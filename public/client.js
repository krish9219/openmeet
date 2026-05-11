/**
 * openmeet client — drives mediasoup-client and renders the video grid.
 *
 * Flow:
 *   1. open WebSocket
 *   2. `join` -> server returns router RTP capabilities + list of peers already in
 *   3. create a Device, load capabilities
 *   4. createSendTransport, createRecvTransport
 *   5. get local mic + camera, produce both
 *   6. for every existing producer, send `consume` and attach the track
 *   7. on `newProducer` from anyone, consume + attach
 *
 * mediasoup-client is loaded via the CDN script tag in room.html; it exposes
 * `mediasoupClient` on window.
 */

const { Device } = window.mediasoupClient;

const params = new URLSearchParams(location.search);
const roomId = location.pathname.split("/").pop();
const displayName = params.get("name") || "anonymous";

const grid = document.getElementById("grid");
const banner = document.getElementById("banner");
const peerCountEl = document.getElementById("peer-count");
document.getElementById("room-name").textContent = roomId;
document.getElementById("copy-link").onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    flash("Link copied — share it with the other peers", 1500);
  } catch {}
};

const state = {
  socket: /** @type {WebSocket | null} */ (null),
  device: /** @type {any} */ (null),
  sendTransport: null,
  recvTransport: null,
  micProducer: null,
  camProducer: null,
  screenProducer: null,
  localStream: null,
  screenStream: null,
  // peerId -> { displayName, tile element }
  peers: new Map(),
  // consumerId -> consumer
  consumers: new Map(),
  pendingRequests: new Map(),
  nextRequestId: 1,
};

function flash(text, ms = 2500, isError = false) {
  banner.textContent = text;
  banner.classList.toggle("error", isError);
  banner.hidden = false;
  clearTimeout(banner._t);
  banner._t = setTimeout(() => (banner.hidden = true), ms);
}

function send(type, data = {}) {
  state.socket.send(JSON.stringify({ type, ...data }));
}

function request(type, data = {}) {
  return new Promise((resolve, reject) => {
    const id = state.nextRequestId++;
    state.pendingRequests.set(id, { resolve, reject });
    state.socket.send(JSON.stringify({ id, type, ...data }));
  });
}

function onSocketMessage(raw) {
  const msg = JSON.parse(raw.data);
  if (msg.id && state.pendingRequests.has(msg.id)) {
    const { resolve, reject } = state.pendingRequests.get(msg.id);
    state.pendingRequests.delete(msg.id);
    if (msg.error) reject(new Error(msg.error));
    else resolve(msg);
    return;
  }
  switch (msg.type) {
    case "peerJoined":
      addPeerTile(msg.peer.id, msg.peer.displayName);
      flash(`${msg.peer.displayName} joined`);
      updatePeerCount();
      break;
    case "peerLeft":
      removePeer(msg.peerId);
      updatePeerCount();
      break;
    case "newProducer":
      consume(msg.peerId, msg.producerId, msg.kind, msg.appData);
      break;
    case "producerClosed":
      // server doesn't tell us which consumer, but consumerClosed handles it
      break;
    case "consumerClosed":
      detachConsumer(msg.consumerId);
      break;
  }
}

// ----------------------------------------------------------------- main

async function main() {
  state.socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  await new Promise((resolve, reject) => {
    state.socket.addEventListener("open", resolve, { once: true });
    state.socket.addEventListener("error", reject, { once: true });
  });
  state.socket.addEventListener("message", onSocketMessage);
  state.socket.addEventListener("close", () => flash("Disconnected from server.", 99999, true));

  // 1. Join the room.
  const joined = await request("join", { roomId, displayName });
  state.peerId = joined.peerId;

  // 2. Initialize mediasoup Device.
  state.device = new Device();
  await state.device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });

  // 3. Get local media (don't request before we have a place to render it).
  addLocalTile();
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    flash(`Mic/camera permission denied: ${e.message}`, 6000, true);
    state.localStream = new MediaStream();
  }
  attachStreamToTile("local", state.localStream);

  // 4. Create both transports.
  state.sendTransport = await createTransport("send");
  state.recvTransport = await createTransport("recv");

  // 5. Produce audio + video.
  const audioTrack = state.localStream.getAudioTracks()[0];
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (audioTrack) {
    state.micProducer = await state.sendTransport.produce({ track: audioTrack, appData: { source: "mic" } });
  }
  if (videoTrack) {
    state.camProducer = await state.sendTransport.produce({ track: videoTrack, appData: { source: "cam" } });
  }

  // 6. Consume everyone else already in the room.
  for (const peer of joined.peers) {
    addPeerTile(peer.id, peer.displayName);
    for (const prod of peer.producers) {
      await consume(peer.id, prod.producerId, prod.kind, prod.appData);
    }
  }
  updatePeerCount();
  wireControls();
}

async function createTransport(direction) {
  const info = await request("createTransport", { direction });
  const transport =
    direction === "send"
      ? state.device.createSendTransport(info)
      : state.device.createRecvTransport(info);

  transport.on("connect", async ({ dtlsParameters }, callback, errback) => {
    try {
      await request("connectTransport", { transportId: transport.id, dtlsParameters });
      callback();
    } catch (e) {
      errback(e);
    }
  });

  if (direction === "send") {
    transport.on("produce", async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const { producerId } = await request("produce", {
          transportId: transport.id,
          kind,
          rtpParameters,
          appData,
        });
        callback({ id: producerId });
      } catch (e) {
        errback(e);
      }
    });
  }
  return transport;
}

async function consume(peerId, producerId, kind, appData) {
  if (!state.recvTransport) return;
  const info = await request("consume", {
    transportId: state.recvTransport.id,
    producerId,
    rtpCapabilities: state.device.rtpCapabilities,
  });
  const consumer = await state.recvTransport.consume({
    id: info.id,
    producerId: info.producerId,
    kind: info.kind,
    rtpParameters: info.rtpParameters,
  });
  state.consumers.set(consumer.id, { consumer, peerId, source: appData?.source });

  const isScreen = appData?.source === "screen";
  const tileId = isScreen ? `screen-${peerId}` : peerId;
  if (isScreen) ensureScreenTile(peerId);

  let stream = document.getElementById(`stream-${tileId}`)?._stream;
  if (!stream) {
    stream = new MediaStream();
    attachStreamToTile(tileId, stream);
  }
  stream.addTrack(consumer.track);

  consumer.on("transportclose", () => detachConsumer(consumer.id));
  consumer.on("trackended", () => detachConsumer(consumer.id));
}

function detachConsumer(consumerId) {
  const entry = state.consumers.get(consumerId);
  if (!entry) return;
  const { peerId, source } = entry;
  state.consumers.delete(consumerId);
  if (source === "screen") {
    const tile = document.getElementById(`tile-screen-${peerId}`);
    if (tile) tile.remove();
  }
}

// ----------------------------------------------------------------- DOM

function addLocalTile() {
  const tile = makeTile("local", `${displayName} (you)`);
  tile.classList.add("local");
  grid.appendChild(tile);
}

function addPeerTile(peerId, name) {
  if (state.peers.has(peerId)) return;
  const tile = makeTile(peerId, name);
  grid.appendChild(tile);
  state.peers.set(peerId, { displayName: name, tile });
}

function ensureScreenTile(peerId) {
  const id = `screen-${peerId}`;
  if (document.getElementById(`tile-${id}`)) return;
  const peer = state.peers.get(peerId);
  const name = peer ? `${peer.displayName} — screen` : "screen";
  const tile = makeTile(id, name);
  tile.classList.add("screen");
  grid.appendChild(tile);
}

function removePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (peer) {
    peer.tile.remove();
    state.peers.delete(peerId);
  }
  document.getElementById(`tile-screen-${peerId}`)?.remove();
}

function makeTile(id, name) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.id = `tile-${id}`;
  tile.innerHTML = `
    <video id="stream-${id}" autoplay playsinline ${id === "local" ? "muted" : ""}></video>
    <div class="name">${escapeHtml(name)}</div>
  `;
  return tile;
}

function attachStreamToTile(id, stream) {
  const v = document.getElementById(`stream-${id}`);
  if (!v) return;
  v.srcObject = stream;
  v._stream = stream;
}

function updatePeerCount() {
  peerCountEl.textContent = String(state.peers.size + 1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ----------------------------------------------------------------- controls

function wireControls() {
  document.getElementById("btn-mic").onclick = () => toggleProducer("mic");
  document.getElementById("btn-cam").onclick = () => toggleProducer("cam");
  document.getElementById("btn-share").onclick = toggleScreenShare;
  document.getElementById("btn-leave").onclick = leave;
}

function toggleProducer(kind) {
  const producer = kind === "mic" ? state.micProducer : state.camProducer;
  const btn = document.getElementById(kind === "mic" ? "btn-mic" : "btn-cam");
  if (!producer) return;
  if (producer.paused) {
    producer.resume();
    btn.classList.add("on");
  } else {
    producer.pause();
    btn.classList.remove("on");
  }
}

async function toggleScreenShare() {
  const btn = document.getElementById("btn-share");
  if (state.screenProducer) {
    state.screenProducer.close();
    await request("closeProducer", { producerId: state.screenProducer.id });
    state.screenProducer = null;
    state.screenStream?.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
    btn.classList.remove("on");
    return;
  }
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch {
    return;
  }
  const track = state.screenStream.getVideoTracks()[0];
  track.onended = () => toggleScreenShare();
  state.screenProducer = await state.sendTransport.produce({ track, appData: { source: "screen" } });
  btn.classList.add("on");
}

function leave() {
  state.socket?.close();
  state.localStream?.getTracks().forEach((t) => t.stop());
  state.screenStream?.getTracks().forEach((t) => t.stop());
  location.href = "/";
}

window.addEventListener("beforeunload", () => state.socket?.close());

main().catch((e) => flash(`Fatal: ${e.message}`, 99999, true));
