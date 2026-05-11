/**
 * A Room owns a mediasoup Router and a map of Peers. One router per room means
 * audio/video routing is isolated — peers in different rooms can't see each other
 * and bandwidth is bounded per room.
 */

import { randomUUID } from "node:crypto";
import { MEDIA_CODECS } from "./config.js";

export class Room {
  constructor(id, worker) {
    this.id = id;
    this.worker = worker;
    this.router = null;
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
  }

  async init() {
    this.router = await this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    return this;
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.close();
    this.peers.delete(peerId);
  }

  otherPeers(peerId) {
    return [...this.peers.values()].filter((p) => p.id !== peerId);
  }

  /** Snapshot the room for a joining peer: who's here + what they're producing. */
  snapshot(forPeerId) {
    return this.otherPeers(forPeerId).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      producers: [...p.producers.values()].map((prod) => ({
        producerId: prod.id,
        kind: prod.kind,
        appData: prod.appData,
      })),
    }));
  }

  isEmpty() {
    return this.peers.size === 0;
  }

  close() {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.router?.close();
  }
}

/**
 * A Peer is one connected client. It has up to two WebRTC transports (one for
 * sending media to the SFU, one for receiving) and a set of producers/consumers.
 */
export class Peer {
  constructor(displayName, socket) {
    this.id = randomUUID();
    this.displayName = displayName;
    this.socket = socket;
    /** @type {Map<string, mediasoup.types.WebRtcTransport>} */
    this.transports = new Map();
    /** @type {Map<string, mediasoup.types.Producer>} */
    this.producers = new Map();
    /** @type {Map<string, mediasoup.types.Consumer>} */
    this.consumers = new Map();
  }

  close() {
    for (const t of this.transports.values()) t.close();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }
}
