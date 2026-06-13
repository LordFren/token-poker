import { timingSafeEqual } from "node:crypto";
import type { Server, Socket } from "socket.io";
import type {
  Ack,
  CardValue,
  ClientToServerEvents,
  ServerToClientEvents,
  SpValue,
} from "@token-poker/shared";
import { buildSnapshot } from "./snapshot.js";
import { schemas, parse } from "./validation.js";
import { TokenBucket } from "./ratelimit.js";
import { clientIp as resolveIp } from "./net.js";
import {
  addStory,
  castVote,
  createRoom,
  getRoom,
  joinRoom,
  nextStory,
  resetRound,
  reveal,
  Room,
  setModel,
  setOnline,
  startQuickVote,
} from "./rooms.js";

interface SocketData {
  bucket: TokenBucket;
  ip?: string;
  code?: string;
  playerId?: string;
}

/** Constant-time secret comparison (both are fixed-length hex tokens). */
function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type IOSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Emit an individualized snapshot to every socket in a room (vote privacy + `you`).
 *  Never rejects — a transport hiccup here must not crash the process. */
async function broadcast(io: IO, room: Room): Promise<void> {
  try {
    const sockets = await io.in(room.code).fetchSockets();
    for (const s of sockets) {
      const pid = s.data.playerId;
      if (!pid) continue;
      s.emit("state", buildSnapshot(room, pid));
    }
  } catch {
    /* dropped sockets / transient io errors — ignore */
  }
}

function clientIp(socket: IOSocket): string {
  return socket.data.ip ?? resolveIp(socket.handshake.headers["x-forwarded-for"], socket.handshake.address);
}

export function registerHandlers(io: IO, socket: IOSocket): void {
  socket.data.bucket = new TokenBucket();

  const limited = (): boolean => !socket.data.bucket.take();

  socket.on("room:create", (raw, ack: (r: Ack) => void) => {
    if (limited()) return ack({ ok: false, error: "Slow down." });
    const v = parse(schemas.createRoom, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });

    const res = createRoom({ ...v.data, ip: clientIp(socket) });
    if (!res.ok) return ack({ ok: false, error: res.error });

    socket.data.code = res.room.code;
    socket.data.playerId = res.player.id;
    socket.join(res.room.code);
    ack({
      ok: true,
      code: res.room.code,
      playerToken: res.player.token,
      hostToken: res.room.hostToken,
      snapshot: buildSnapshot(res.room, res.player.id),
    });
  });

  socket.on("room:join", (raw, ack: (r: Ack) => void) => {
    if (limited()) return ack({ ok: false, error: "Slow down." });
    const v = parse(schemas.joinRoom, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });

    const res = joinRoom(v.data);
    if (!res.ok) return ack({ ok: false, error: res.error });

    socket.data.code = res.room.code;
    socket.data.playerId = res.player.id;
    socket.join(res.room.code);
    void broadcast(io, res.room);
    ack({
      ok: true,
      code: res.room.code,
      playerToken: res.player.token,
      hostToken: res.player.isHost ? res.room.hostToken : undefined,
      snapshot: buildSnapshot(res.room, res.player.id),
    });
  });

  // ---- helpers for the in-room mutations -------------------------------

  type SimpleAck = (r: { ok: boolean; error?: string }) => void;

  const withRoom = (ack: SimpleAck): Room | undefined => {
    if (limited()) {
      ack({ ok: false, error: "Slow down." });
      return undefined;
    }
    const code = socket.data.code;
    const room = code ? getRoom(code) : undefined;
    if (!room) {
      ack({ ok: false, error: "Not in a room (it may have expired)." });
      return undefined;
    }
    return room;
  };

  const requireHost = (room: Room, hostToken: string, ack: SimpleAck): boolean => {
    if (!tokenEquals(hostToken, room.hostToken)) {
      ack({ ok: false, error: "Host action not authorized." });
      return false;
    }
    return true;
  };

  socket.on("vote", (raw, ack: SimpleAck) => {
    const room = withRoom(ack);
    if (!room) return;
    const v = parse(schemas.vote, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });
    const r = castVote(room, socket.data.playerId!, v.data.storyId, v.data.round, {
      cardValue: v.data.cardValue as CardValue | undefined,
      spValue: v.data.spValue as SpValue | undefined,
    });
    if (!r.ok) return ack(r);
    void broadcast(io, room);
    ack({ ok: true });
  });

  socket.on("addStory", (raw, ack: SimpleAck) => {
    const room = withRoom(ack);
    if (!room) return;
    const v = parse(schemas.addStory, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });
    if (!requireHost(room, v.data.hostToken, ack)) return;
    const r = addStory(room, v.data.title, v.data.description);
    if (!r.ok) return ack(r);
    void broadcast(io, room);
    ack({ ok: true });
  });

  socket.on("reveal", (raw, ack: SimpleAck) => {
    const room = withRoom(ack);
    if (!room) return;
    const v = parse(schemas.reveal, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });
    if (!requireHost(room, v.data.hostToken, ack)) return;
    const r = reveal(room, v.data.storyId);
    if (!r.ok) return ack(r);
    void broadcast(io, room);
    ack({ ok: true });
  });

  socket.on("reset", (raw, ack: SimpleAck) => {
    const room = withRoom(ack);
    if (!room) return;
    const v = parse(schemas.reset, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });
    if (!requireHost(room, v.data.hostToken, ack)) return;
    const r = resetRound(room, v.data.storyId);
    if (!r.ok) return ack(r);
    void broadcast(io, room);
    ack({ ok: true });
  });

  socket.on("nextStory", (raw, ack: SimpleAck) => {
    const room = withRoom(ack);
    if (!room) return;
    const v = parse(schemas.nextStory, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });
    if (!requireHost(room, v.data.hostToken, ack)) return;
    const r = nextStory(room, v.data.storyId, v.data.finalEstimate ?? null, v.data.finalPoints ?? null);
    if (!r.ok) return ack(r);
    // Quick mode: accept + open the next numbered vote in one round trip.
    if (v.data.startNext && room.mode === "quick" && !room.currentStoryId) startQuickVote(room);
    void broadcast(io, room);
    ack({ ok: true });
  });

  socket.on("quickStart", (raw, ack: SimpleAck) => {
    const room = withRoom(ack);
    if (!room) return;
    const v = parse(schemas.quickStart, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });
    if (!requireHost(room, v.data.hostToken, ack)) return;
    const r = startQuickVote(room);
    if (!r.ok) return ack(r);
    void broadcast(io, room);
    ack({ ok: true });
  });

  socket.on("setModel", (raw, ack: SimpleAck) => {
    const room = withRoom(ack);
    if (!room) return;
    const v = parse(schemas.setModel, raw);
    if (!v.ok) return ack({ ok: false, error: v.error });
    if (!requireHost(room, v.data.hostToken, ack)) return;
    const r = setModel(room, v.data.modelId, v.data.outputRatio);
    if (!r.ok) return ack(r);
    void broadcast(io, room);
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    const pid = socket.data.playerId;
    if (!code || !pid) return;
    const room = getRoom(code);
    if (!room) return;
    setOnline(room, pid, false);
    void broadcast(io, room);
  });
}
