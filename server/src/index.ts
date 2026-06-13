import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import path from "node:path";
import { Server } from "socket.io";
import { config, isProd } from "./config.js";
import { initDb } from "./db.js";
import { IO, registerHandlers } from "./events.js";
import { addConn, canConnect, clientIp, removeConn } from "./net.js";
import { TokenBucket } from "./ratelimit.js";
import { getRoom, rehydrate, sweepExpired } from "./rooms.js";

function main(): void {
  // Fail closed: never run a production server with a wildcard CORS origin.
  if (isProd && config.corsOrigin === "*") {
    console.error("Refusing to start: set CORS_ORIGIN to your domain in production (got '*').");
    process.exit(1);
  }

  initDb();
  const restored = rehydrate();

  const app = express();
  app.disable("x-powered-by");

  // Baseline security headers (CSP, HSTS, X-Frame-Options, nosniff, …) so the
  // app is safe even if served directly by Node without a hardened proxy.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Per-IP token-bucket limiter for the HTTP routes (socket events have their own).
  const httpBuckets = new Map<string, TokenBucket>();
  const httpLimit = (req: Request, res: Response, next: NextFunction): void => {
    const ip = clientIp(req.headers["x-forwarded-for"], req.socket.remoteAddress);
    let b = httpBuckets.get(ip);
    if (!b) {
      b = new TokenBucket(config.httpRateLimit.capacity, config.httpRateLimit.refillPerSec);
      httpBuckets.set(ip, b);
    }
    if (!b.take()) {
      res.status(429).json({ error: "rate limited" });
      return;
    }
    next();
  };

  app.get("/healthz", httpLimit, (_req, res) => {
    res.json({ ok: true });
  });

  // Lightweight existence check used by the web app to decide
  // "show join form" vs "show expired screen" for /r/<slug> links.
  app.get("/api/room/:code", httpLimit, (req, res) => {
    const room = getRoom(String(req.params.code));
    res.json({ exists: !!room });
  });

  // Optionally serve the built web app (start:local / production).
  if (config.serveStatic) {
    const dist = path.resolve(process.cwd(), "web", "dist");
    app.use(express.static(dist));
    // SPA fallback so /r/<slug> (and any client route) loads index.html.
    // Express 5 uses path-to-regexp v8, where "*" is no longer a valid path
    // string — use a RegExp catch-all instead. /api and /healthz are declared
    // above, so they match first; Socket.IO handles /socket.io itself.
    app.get(/.*/, (_req, res) => {
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  const httpServer = createServer(app);
  const io: IO = new Server(httpServer, {
    maxHttpBufferSize: config.socketBufferBytes,
    cors: { origin: config.corsOrigin === "*" ? "*" : config.corsOrigin.split(",") },
  });

  // Reject connection floods from a single IP before they allocate per-socket state.
  io.use((socket, next) => {
    const ip = clientIp(socket.handshake.headers["x-forwarded-for"], socket.handshake.address);
    if (!canConnect(ip)) return next(new Error("Too many connections"));
    socket.data.ip = ip;
    addConn(ip);
    next();
  });

  io.on("connection", (socket) => {
    registerHandlers(io, socket);
    socket.on("disconnect", () => removeConn(socket.data.ip ?? ""));
  });

  // Periodic expiry sweep: notify any connected clients, then drop the rooms.
  setInterval(() => {
    const removed = sweepExpired();
    for (const code of removed) io.to(code).emit("expired");
  }, config.sweepIntervalMs).unref();

  httpServer.listen(config.port, config.host, () => {
    console.log(
      `token-poker server on http://${config.host}:${config.port} ` +
        `(${isProd ? "prod" : "dev"}, static=${config.serveStatic}, restored ${restored} room(s))`,
    );
  });
}

main();
