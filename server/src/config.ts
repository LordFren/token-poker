import path from "node:path";

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST ?? "127.0.0.1",
  /** When set, the server also serves the built web app from web/dist. */
  serveStatic: process.env.SERVE_STATIC === "1",
  /** Allowed CORS origin for the Socket.IO handshake. "*" only in dev. */
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  /** Trust X-Forwarded-For (only when behind a proxy that sets it, e.g. Caddy). */
  trustProxy: process.env.TRUST_PROXY === "1",
  /** Path to the SQLite file. */
  dbPath:
    process.env.DB_PATH ??
    path.resolve(process.cwd(), "data", process.env.NODE_ENV === "production" ? "rooms.sqlite" : "dev.sqlite"),

  // Room expiry policy (ms)
  idleTtlMs: num(process.env.IDLE_TTL_MS, 4 * 60 * 60 * 1000), // 4h since last activity
  maxTtlMs: num(process.env.MAX_TTL_MS, 24 * 60 * 60 * 1000), // 24h absolute cap
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 60 * 1000),

  // Abuse limits
  maxRoomsPerIp: num(process.env.MAX_ROOMS_PER_IP, 20),
  /** Global backstop on total live rooms (per-IP caps don't bound a distributed flood). */
  maxRooms: num(process.env.MAX_ROOMS, 50_000),
  maxSocketsPerIp: num(process.env.MAX_SOCKETS_PER_IP, 30),
  maxRounds: num(process.env.MAX_ROUNDS, 1000),
  socketBufferBytes: num(process.env.SOCKET_BUFFER_BYTES, 8 * 1024),
  rateLimit: {
    capacity: num(process.env.RL_CAPACITY, 20), // burst
    refillPerSec: num(process.env.RL_REFILL, 8), // sustained events/sec
  },
  // HTTP route limiter (per IP)
  httpRateLimit: {
    capacity: num(process.env.HTTP_RL_CAPACITY, 30),
    refillPerSec: num(process.env.HTTP_RL_REFILL, 5),
  },
} as const;

export const isProd = process.env.NODE_ENV === "production";
