/**
 * openmeet client — drives mediasoup-client and renders the video grid + chat.
 *
 * UI buttons are wired at module load so they always work; the WebSocket
 * connection happens asynchronously and surfaces errors via the banner.
 */

import * as mediasoupClient from "https://esm.sh/mediasoup-client@3";
const { Device } = mediasoupClient;

const params = new URLSearchParams(location.search);
const roomId = location.pathname.split("/").pop();
const displayName = params.get("name") || "anonymous";
const urlPassword = params.get("pwd") || "";

const grid = document.getElementById("grid");
const banner = document.getElementById("banner");
const peerCountEl = document.getElementById("peer-count");
const chatPanel = document.getElementById("chat-panel");
const chatList = document.getElementById("chat-list");
const chatInput = document.getElementById("chat-input");
const chatForm = document.getElementById("chat-form");
const chatToggle = document.getElementById("btn-chat");
const chatUnread = document.getElementById("chat-unread");
document.getElementById("room-name").textContent = roomId;

const state = {
  socket: null,
  device: null,
  sendTransport: null,
  recvTransport: null,
  micProducer: null,
  camProducer: null,
  screenProducer: null,
  localStream: null,
  screenStream: null,
  peerId: null,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  peers: new Map(),
  consumers: new Map(),
  pendingRequests: new Map(),
  nextRequestId: 1,
  chatOpen: false,
  unreadChat: 0,
};

function flash(text, ms = 2500, isError = false) {
  banner.textContent = text;
  banner.classList.toggle("error", isError);
  banner.hidden = false;
  clearTimeout(banner._t);
  if (ms > 0) banner._t = setTimeout(() => (banner.hidden = true), ms);
}

// ============================================================ UI buttons (always wired)

document.getElementById("copy-link").onclick = async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    flash("Link copied — share it with the other peers", 1500);
  } catch {
    window.prompt("Copy this invite URL:", url);
  }
};

document.getElementById("btn-leave").onclick = () => {
  try {
    state.socket?.close();
    state.localStream?.getTracks().forEach((t) => t.stop());
    state.screenStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  location.href = "/";
};

document.getElementById("btn-mic").onclick = () => toggleProducer("mic");
document.getElementById("btn-cam").onclick = () => toggleProducer("cam");
document.getElementById("btn-share").onclick = toggleScreenShare;
document.getElementById("btn-breakout").onclick = createBreakout;

chatToggle.onclick = toggleChat;
chatForm.onsubmit = sendChat;

window.addEventListener("beforeunload", () => state.socket?.close());

// ============================================================ signaling

function request(type, data = {}) {
  return new Promise((resolve, reject) => {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      reject(new Error("not connected"));
      return;
    }
    const id = state.nextRequestId++;
    state.pendingRequests.set(id, { resolve, reject });
    state.socket.send(JSON.stringify({ id, type, ...data }));
  });
}

function send(type, data = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({ type, ...data }));
}

function onSocketMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.data);
  } catch {
    return;
  }
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
      addChatSystem(`${msg.peer.displayName} joined`);
      break;
    case "peerLeft": {
      const left = state.peers.get(msg.peerId);
      removePeer(msg.peerId);
      updatePeerCount();
      if (left) addChatSystem(`${left.displayName} left`);
      break;
    }
    case "newProducer":
      consume(msg.peerId, msg.producerId, msg.kind, msg.appData);
      break;
    case "consumerClosed":
      detachConsumer(msg.consumerId);
      break;
    case "chat":
      addChatMessage(msg);
      break;
  }
}

// ============================================================ main

async function main() {
  state.socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  await new Promise((resolve, reject) => {
    state.socket.addEventListener("open", () => resolve(), { once: true });
    state.socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
  state.socket.addEventListener("message", onSocketMessage);
  state.socket.addEventListener("close", () => flash("Disconnected from server.", 0, true));

  // Try join. If server demands a password we don't have, prompt and retry.
  let joined;
  try {
    joined = await request("join", { roomId, displayName, password: urlPassword });
  } catch (e) {
    if (/password/i.test(e.message)) {
      const pwd = window.prompt("This room requires a password:");
      if (!pwd) { location.href = "/"; return; }
      joined = await request("join", { roomId, displayName, password: pwd });
    } else {
      throw e;
    }
  }
  state.peerId = joined.peerId;
  state.iceServers = joined.iceServers ?? state.iceServers;

  state.device = new Device();
  await state.device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });

  addLocalTile();
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    });
  } catch (e) {
    flash(`Mic/camera permission denied: ${e.message}. Room still loads.`, 6000, true);
    state.localStream = new MediaStream();
    document.getElementById("btn-mic").classList.remove("on");
    document.getElementById("btn-cam").classList.remove("on");
  }
  attachStreamToTile("local", state.localStream);

  state.sendTransport = await createTransport("send");
  state.recvTransport = await createTransport("recv");

  const audioTrack = state.localStream.getAudioTracks()[0];
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (audioTrack) {
    state.micProducer = await state.sendTransport.produce({
      track: audioTrack,
      codecOptions: { opusStereo: true, opusDtx: true },
      appData: { source: "mic" },
    });
  }
  if (videoTrack) {
    // Simulcast: three layers so the SFU can downshift quality for distant
    // consumers or small tiles. This is the real fix for 4+ peer quality.
    state.camProducer = await state.sendTransport.produce({
      track: videoTrack,
      encodings: [
        { rid: "r0", maxBitrate: 100_000, scaleResolutionDownBy: 4 },
        { rid: "r1", maxBitrate: 300_000, scaleResolutionDownBy: 2 },
        { rid: "r2", maxBitrate: 900_000, scaleResolutionDownBy: 1 },
      ],
      codecOptions: { videoGoogleStartBitrate: 1000 },
      appData: { source: "cam" },
    });
  }

  // Seed chat history from server.
  for (const entry of joined.chatHistory ?? []) addChatMessage(entry, true);

  // Existing peers + their producers.
  for (const peer of joined.peers) {
    addPeerTile(peer.id, peer.displayName);
    for (const prod of peer.producers) {
      await consume(peer.id, prod.producerId, prod.kind, prod.appData);
    }
  }
  updatePeerCount();

  // iOS: require a user gesture to resume audio if autoplay was blocked.
  document.addEventListener("click", resumeAllAudio, { once: true });
}

function resumeAllAudio() {
  document.querySelectorAll("video").forEach((v) => {
    if (v.paused) v.play().catch(() => {});
  });
}

async function createTransport(direction) {
  const info = await request("createTransport", { direction });
  const opts = { ...info, iceServers: state.iceServers };
  const transport =
    direction === "send"
      ? state.device.createSendTransport(opts)
      : state.device.createRecvTransport(opts);

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
  if (source === "screen") document.getElementById(`tile-screen-${peerId}`)?.remove();
}

// ============================================================ DOM

function addLocalTile() {
  if (document.getElementById("tile-local")) return;
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
  v.play?.().catch(() => {});
}

function updatePeerCount() {
  peerCountEl.textContent = String(state.peers.size + 1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================ chat

function toggleChat() {
  state.chatOpen = !state.chatOpen;
  chatPanel.classList.toggle("open", state.chatOpen);
  document.body.classList.toggle("chat-open", state.chatOpen);
  if (state.chatOpen) {
    state.unreadChat = 0;
    chatUnread.hidden = true;
    chatInput.focus();
  }
}

function sendChat(e) {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  send("chat", { text });
  chatInput.value = "";
}

function addChatMessage(msg, isHistory = false) {
  const isOwn = msg.peerId === state.peerId;
  const row = document.createElement("div");
  row.className = "chat-msg" + (isOwn ? " own" : "");
  row.innerHTML = `
    <div class="chat-meta"><span class="chat-name">${escapeHtml(msg.displayName)}</span><span class="chat-time">${formatTime(msg.at)}</span></div>
    <div class="chat-text">${linkifyAndEscape(msg.text)}</div>
  `;
  chatList.appendChild(row);
  chatList.scrollTop = chatList.scrollHeight;
  if (!state.chatOpen && !isOwn && !isHistory) {
    state.unreadChat++;
    chatUnread.textContent = String(state.unreadChat);
    chatUnread.hidden = false;
  }
}

function addChatSystem(text) {
  const row = document.createElement("div");
  row.className = "chat-msg system";
  row.textContent = text;
  chatList.appendChild(row);
  chatList.scrollTop = chatList.scrollHeight;
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function linkifyAndEscape(text) {
  return escapeHtml(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// ============================================================ controls

function toggleProducer(kind) {
  const producer = kind === "mic" ? state.micProducer : state.camProducer;
  const btn = document.getElementById(kind === "mic" ? "btn-mic" : "btn-cam");
  if (!producer) {
    flash("Still connecting — try again in a moment.", 1500);
    return;
  }
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
  if (!state.sendTransport) {
    flash("Still connecting — try again in a moment.", 1500);
    return;
  }
  if (state.screenProducer) {
    state.screenProducer.close();
    try { await request("closeProducer", { producerId: state.screenProducer.id }); } catch {}
    state.screenProducer = null;
    state.screenStream?.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
    btn.classList.remove("on");
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    flash("Screen share is not supported on this browser/device.", 3000, true);
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

function createBreakout() {
  const suffix = "breakout-" + Math.random().toString(36).slice(2, 7);
  const newRoomId = `${roomId}-${suffix}`;
  const newUrl = `${location.origin}/r/${encodeURIComponent(newRoomId)}?name=${encodeURIComponent(displayName)}`;
  navigator.clipboard?.writeText(newUrl).catch(() => {});
  send("chat", { text: `Opened a breakout: ${newUrl}` });
  flash("Breakout URL sent to chat + clipboard. Opening…", 1800);
  setTimeout(() => (location.href = newUrl), 1800);
}

main().catch((e) => {
  console.error(e);
  flash(`Connection failed: ${e.message}`, 0, true);
});
