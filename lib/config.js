/**
 * mediasoup + server config in one file. Edit the listenIp for LAN / production.
 */

export const PORT = Number(process.env.PORT ?? 3000);

// The IP your mediasoup worker binds to.
//   - "127.0.0.1"      — localhost only (single machine demo)
//   - your LAN IP      — same Wi-Fi
//   - "0.0.0.0" + ANNOUNCED_IP env — public deployment
export const LISTEN_IP = process.env.LISTEN_IP ?? "127.0.0.1";
export const ANNOUNCED_IP = process.env.ANNOUNCED_IP || null;

// UDP port range mediasoup will use for RTP. Keep narrow on dev, wider in prod.
export const RTC_MIN_PORT = Number(process.env.RTC_MIN_PORT ?? 40000);
export const RTC_MAX_PORT = Number(process.env.RTC_MAX_PORT ?? 40100);

// Audio + video codecs the SFU advertises.
export const MEDIA_CODECS = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/VP9",
    clockRate: 90000,
    parameters: { "profile-id": 2, "x-google-start-bitrate": 1000 },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];

export const WEBRTC_TRANSPORT_OPTIONS = {
  listenIps: [{ ip: LISTEN_IP, announcedIp: ANNOUNCED_IP }],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 1_000_000,
};

/**
 * ICE servers the client uses. STUN helps discover the client's public
 * address; TURN relays media when peer-to-peer fails (strict NAT, firewalls).
 *
 * Configure via env:
 *   ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"}]'
 *   ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:my.turn.host:3478","username":"u","credential":"p"}]'
 *
 * Free/cheap TURN providers: Cloudflare TURN, Twilio NTS, Metered, Xirsys.
 */
function parseIceServers() {
  if (process.env.ICE_SERVERS) {
    try { return JSON.parse(process.env.ICE_SERVERS); }
    catch (e) { console.warn("invalid ICE_SERVERS JSON, using default STUN:", e.message); }
  }
  return [{ urls: "stun:stun.l.google.com:19302" }];
}
export const ICE_SERVERS = parseIceServers();

/** Optional shared-secret room password. Empty = no auth. */
export const ROOM_PASSWORD = process.env.ROOM_PASSWORD ?? "";

/** Maximum peers in a room before the SFU starts dropping the lowest simulcast layer. */
export const SIMULCAST_ENCODINGS = [
  { rid: "r0", maxBitrate: 100_000, scaleResolutionDownBy: 4 },
  { rid: "r1", maxBitrate: 300_000, scaleResolutionDownBy: 2 },
  { rid: "r2", maxBitrate: 900_000, scaleResolutionDownBy: 1 },
];
