/**
 * openmeet — group video calling with a real SFU.
 *
 *   browser <---WebSocket signaling---> server <---ipc---> mediasoup worker
 *
 * Each room owns one mediasoup Router. Each peer owns up to two WebRTC transports
 * (one for sending audio/video to the SFU, one for receiving everyone else's).
 *
 * Signaling messages are plain JSON over WebSocket. See `handle()` below.
 */

import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as mediasoup from "mediasoup";

import {
  PORT,
  RTC_MIN_PORT,
  RTC_MAX_PORT,
  WEBRTC_TRANSPORT_OPTIONS,
} from "./lib/config.js";
import { Peer, Room } from "./lib/room.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------- bootstrap

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/r/:roomId", (_req, res) => res.sendFile(path.join(__dirname, "public", "room.html")));

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

/** @type {mediasoup.types.Worker} */
let worker;
const rooms = new Map();

async function start() {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: RTC_MIN_PORT,
    rtcMaxPort: RTC_MAX_PORT,
  });
  worker.on("died", () => {
    console.error("mediasoup worker died — shutting down");
    process.exit(1);
  });
  console.log(`mediasoup worker pid=${worker.pid}`);

  httpServer.listen(PORT, () => {
    console.log(`openmeet listening on http://localhost:${PORT}`);
  });
}

async function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = await new Room(roomId, worker).init();
    rooms.set(roomId, room);
    console.log(`[room ${roomId}] created`);
  }
  return room;
}

// ----------------------------------------------------------------- signaling

wss.on("connection", (socket) => {
  /** @type {Peer | null} */
  let peer = null;
  /** @type {Room | null} */
  let room = null;

  function send(type, data = {}) {
    socket.send(JSON.stringify({ type, ...data }));
  }

  function reply(id, data) {
    socket.send(JSON.stringify({ id, ...data }));
  }

  function broadcast(type, data) {
    if (!room || !peer) return;
    for (const other of room.otherPeers(peer.id)) {
      other.socket.send(JSON.stringify({ type, ...data }));
    }
  }

  socket.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      await handle(msg);
    } catch (e) {
      console.error(`[${peer?.id}] error handling ${msg.type}:`, e);
      if (msg.id) reply(msg.id, { error: String(e.message || e) });
    }
  });

  socket.on("close", () => {
    if (!peer || !room) return;
    const peerId = peer.id;
    room.removePeer(peerId);
    broadcast("peerLeft", { peerId });
    console.log(`[room ${room.id}] peer ${peer.displayName} left`);
    if (room.isEmpty()) {
      room.close();
      rooms.delete(room.id);
      console.log(`[room ${room.id}] closed (empty)`);
    }
    peer = null;
    room = null;
  });

  async function handle(msg) {
    switch (msg.type) {
      case "join": {
        room = await getOrCreateRoom(msg.roomId);
        peer = new Peer(msg.displayName || "anonymous", socket);
        room.addPeer(peer);
        console.log(`[room ${room.id}] peer ${peer.displayName} joined`);
        reply(msg.id, {
          peerId: peer.id,
          routerRtpCapabilities: room.router.rtpCapabilities,
          peers: room.snapshot(peer.id),
        });
        broadcast("peerJoined", { peer: { id: peer.id, displayName: peer.displayName } });
        return;
      }

      case "createTransport": {
        if (!peer || !room) throw new Error("not joined");
        const transport = await room.router.createWebRtcTransport(WEBRTC_TRANSPORT_OPTIONS);
        peer.transports.set(transport.id, transport);
        reply(msg.id, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
        return;
      }

      case "connectTransport": {
        if (!peer) throw new Error("not joined");
        const transport = peer.transports.get(msg.transportId);
        if (!transport) throw new Error(`unknown transport ${msg.transportId}`);
        await transport.connect({ dtlsParameters: msg.dtlsParameters });
        reply(msg.id, {});
        return;
      }

      case "produce": {
        if (!peer) throw new Error("not joined");
        const transport = peer.transports.get(msg.transportId);
        if (!transport) throw new Error(`unknown transport ${msg.transportId}`);
        const producer = await transport.produce({
          kind: msg.kind,
          rtpParameters: msg.rtpParameters,
          appData: msg.appData ?? {},
        });
        peer.producers.set(producer.id, producer);
        producer.on("transportclose", () => peer.producers.delete(producer.id));
        reply(msg.id, { producerId: producer.id });
        broadcast("newProducer", {
          peerId: peer.id,
          producerId: producer.id,
          kind: producer.kind,
          appData: producer.appData,
        });
        return;
      }

      case "consume": {
        if (!peer || !room) throw new Error("not joined");
        const transport = peer.transports.get(msg.transportId);
        if (!transport) throw new Error(`unknown transport ${msg.transportId}`);
        if (!room.router.canConsume({ producerId: msg.producerId, rtpCapabilities: msg.rtpCapabilities })) {
          throw new Error("router cannot consume");
        }
        const consumer = await transport.consume({
          producerId: msg.producerId,
          rtpCapabilities: msg.rtpCapabilities,
          paused: false,
        });
        peer.consumers.set(consumer.id, consumer);
        consumer.on("transportclose", () => peer.consumers.delete(consumer.id));
        consumer.on("producerclose", () => {
          peer.consumers.delete(consumer.id);
          socket.send(JSON.stringify({ type: "consumerClosed", consumerId: consumer.id }));
        });
        reply(msg.id, {
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
        return;
      }

      case "closeProducer": {
        if (!peer) throw new Error("not joined");
        const producer = peer.producers.get(msg.producerId);
        if (!producer) return;
        producer.close();
        peer.producers.delete(msg.producerId);
        broadcast("producerClosed", { peerId: peer.id, producerId: msg.producerId });
        reply(msg.id, {});
        return;
      }

      default:
        throw new Error(`unknown message type: ${msg.type}`);
    }
  }
});

start();
