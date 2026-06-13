import {
  CardValue,
  DEFAULT_MODEL_ID,
  DEFAULT_OUTPUT_RATIO,
  LIMITS,
  PRICING,
  RoomMode,
  SpValue,
  StoryStatus,
} from "@token-poker/shared";
import { config } from "./config.js";
import { loadRooms, purgeExpired, saveRoom } from "./db.js";
import { newId, newSlug, newToken, tokenEquals } from "./ids.js";

// ---------------------------------------------------------------------------
// In-memory model (authoritative). SQLite mirrors it for restart durability.
// `online` is runtime-only and never persisted.
// ---------------------------------------------------------------------------

interface Player {
  id: string;
  token: string;
  name: string;
  isHost: boolean;
  isSpectator: boolean;
  online: boolean;
}

/** One player's picks for a round — tokens and (optionally) story points. */
export interface PlayerVote {
  tokens?: CardValue;
  sp?: SpValue;
}

export interface Story {
  id: string;
  title: string;
  description: string;
  status: StoryStatus;
  round: number;
  finalEstimate: number | null;
  finalPoints: number | null;
  /** votes[round] = Map<playerId, PlayerVote> */
  votes: Map<number, Map<string, PlayerVote>>;
}

export interface Room {
  code: string;
  hostToken: string;
  mode: RoomMode;
  estimatePoints: boolean;
  modelId: string;
  outputRatio: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  creatorIp?: string;
  players: Map<string, Player>;
  stories: Story[];
  currentStoryId: string | null;
}

const rooms = new Map<string, Room>();
const roomsByIp = new Map<string, Set<string>>();

export function getRoom(code: string): Room | undefined {
  return rooms.get(code);
}

// ---------------------------------------------------------------------------
// Expiry helpers
// ---------------------------------------------------------------------------

function computeExpiry(createdAt: number, now = Date.now()): number {
  return Math.min(createdAt + config.maxTtlMs, now + config.idleTtlMs);
}

/** Update timestamps + expiry and persist. Call after every mutation. */
function touch(room: Room): void {
  const now = Date.now();
  room.updatedAt = now;
  room.expiresAt = computeExpiry(room.createdAt, now);
  persist(room);
}

function trackIp(room: Room): void {
  if (!room.creatorIp) return;
  let set = roomsByIp.get(room.creatorIp);
  if (!set) {
    set = new Set();
    roomsByIp.set(room.creatorIp, set);
  }
  set.add(room.code);
}

function untrackIp(room: Room): void {
  if (!room.creatorIp) return;
  const set = roomsByIp.get(room.creatorIp);
  set?.delete(room.code);
  if (set && set.size === 0) roomsByIp.delete(room.creatorIp);
}

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

type CreateResult = { ok: true; room: Room; player: Player } | { ok: false; error: string };

export function createRoom(opts: {
  name: string;
  modelId?: string;
  mode?: RoomMode;
  estimatePoints?: boolean;
  spectator?: boolean;
  ip?: string;
}): CreateResult {
  // Global backstop: per-IP caps don't bound a distributed flood across many IPs.
  if (rooms.size >= config.maxRooms) return { ok: false, error: "The server is at capacity. Try again shortly." };

  if (opts.ip) {
    const count = roomsByIp.get(opts.ip)?.size ?? 0;
    if (count >= config.maxRoomsPerIp) return { ok: false, error: "Too many rooms from this connection. Try again later." };
  }

  let code = newSlug();
  while (rooms.has(code)) code = newSlug();

  const now = Date.now();
  const room: Room = {
    code,
    hostToken: newToken(),
    mode: opts.mode === "quick" ? "quick" : "backlog",
    estimatePoints: !!opts.estimatePoints,
    modelId: opts.modelId && PRICING[opts.modelId] ? opts.modelId : DEFAULT_MODEL_ID,
    outputRatio: DEFAULT_OUTPUT_RATIO,
    createdAt: now,
    updatedAt: now,
    expiresAt: computeExpiry(now, now),
    creatorIp: opts.ip,
    players: new Map(),
    stories: [],
    currentStoryId: null,
  };

  const player: Player = {
    id: newId("p"),
    token: newToken(),
    name: opts.name,
    isHost: true,
    isSpectator: !!opts.spectator,
    online: true,
  };
  room.players.set(player.id, player);

  rooms.set(code, room);
  trackIp(room);
  touch(room);
  return { ok: true, room, player };
}

type JoinResult = { ok: true; room: Room; player: Player } | { ok: false; error: string };

export function joinRoom(opts: {
  code: string;
  name?: string;
  playerToken?: string;
  spectator?: boolean;
}): JoinResult {
  const room = rooms.get(opts.code);
  if (!room) return { ok: false, error: "Room not found or expired." };

  // Rejoin by token (refresh / reconnect). Constant-time per-token compare so
  // the lookup doesn't leak how many bytes of a guessed token were correct.
  if (opts.playerToken) {
    const existing = [...room.players.values()].find((p) => tokenEquals(p.token, opts.playerToken!));
    if (existing) {
      existing.online = true;
      if (opts.name) existing.name = opts.name;
      touch(room);
      return { ok: true, room, player: existing };
    }
  }

  if (!opts.name) return { ok: false, error: "A name is required to join." };
  if (room.players.size >= LIMITS.playersPerRoom) return { ok: false, error: "This room is full." };

  const player: Player = {
    id: newId("p"),
    token: newToken(),
    name: opts.name,
    isHost: false,
    isSpectator: !!opts.spectator,
    online: true,
  };
  room.players.set(player.id, player);
  touch(room);
  return { ok: true, room, player };
}

export function setOnline(room: Room, playerId: string, online: boolean): void {
  const p = room.players.get(playerId);
  if (p && p.online !== online) {
    p.online = online;
    touch(room);
  }
}

// ---------------------------------------------------------------------------
// Story / voting state machine
// ---------------------------------------------------------------------------

function findStory(room: Room, storyId: string): Story | undefined {
  return room.stories.find((s) => s.id === storyId);
}

export function addStory(room: Room, title: string, description?: string): { ok: boolean; error?: string } {
  if (room.stories.length >= LIMITS.storiesPerRoom) return { ok: false, error: "Story limit reached for this room." };
  const story: Story = {
    id: newId("s"),
    title,
    description: description ?? "",
    status: "pending",
    round: 1,
    finalEstimate: null,
    finalPoints: null,
    votes: new Map(),
  };
  room.stories.push(story);
  // If nothing is active, make this the current story and open voting.
  if (!room.currentStoryId) {
    story.status = "voting";
    room.currentStoryId = story.id;
  }
  touch(room);
  return { ok: true };
}

/**
 * Quick mode: open the next auto-numbered vote ("Vote #N"). No story text is
 * ever entered — the actual issue lives in the team's tracker / conversation.
 */
export function startQuickVote(room: Room): { ok: boolean; error?: string } {
  if (room.mode !== "quick") return { ok: false, error: "This room is not in quick mode." };
  if (room.currentStoryId) return { ok: false, error: "A vote is already in progress." };
  return addStory(room, `Vote #${room.stories.length + 1}`);
}

export function castVote(
  room: Room,
  playerId: string,
  storyId: string,
  round: number,
  pick: { cardValue?: CardValue; spValue?: SpValue },
): { ok: boolean; error?: string } {
  const player = room.players.get(playerId);
  if (!player) return { ok: false, error: "Unknown player." };
  if (player.isSpectator) return { ok: false, error: "Spectators cannot vote." };
  if (room.currentStoryId !== storyId) return { ok: false, error: "That story is not currently being voted on." };
  if (pick.cardValue == null && pick.spValue == null) return { ok: false, error: "Pick a card." };
  if (pick.spValue != null && !room.estimatePoints)
    return { ok: false, error: "This room does not estimate story points." };
  const story = findStory(room, storyId);
  if (!story || story.status !== "voting") return { ok: false, error: "Voting is not open for this story." };
  if (story.round !== round) return { ok: false, error: "Stale round — refresh." };

  let roundVotes = story.votes.get(round);
  if (!roundVotes) {
    roundVotes = new Map();
    story.votes.set(round, roundVotes);
  }
  // Merge: each click casts one dimension; the other (if any) is kept.
  const existing = roundVotes.get(playerId) ?? {};
  if (pick.cardValue != null) existing.tokens = pick.cardValue;
  if (pick.spValue != null) existing.sp = pick.spValue;
  roundVotes.set(playerId, existing);
  touch(room);
  return { ok: true };
}

export function reveal(room: Room, storyId: string): { ok: boolean; error?: string } {
  const story = findStory(room, storyId);
  if (!story) return { ok: false, error: "Story not found." };
  if (story.status !== "voting") return { ok: false, error: "Story is not open for voting." };
  story.status = "revealed";
  touch(room);
  return { ok: true };
}

export function resetRound(room: Room, storyId: string): { ok: boolean; error?: string } {
  const story = findStory(room, storyId);
  if (!story) return { ok: false, error: "Story not found." };
  if (story.status !== "revealed" && story.status !== "voting") return { ok: false, error: "Cannot re-vote this story." };
  if (story.round >= config.maxRounds) return { ok: false, error: "Too many re-votes on this story." };
  story.round += 1;
  story.status = "voting";
  touch(room);
  return { ok: true };
}

export function nextStory(
  room: Room,
  storyId: string,
  finalEstimate: number | null,
  finalPoints: number | null = null,
): { ok: boolean; error?: string } {
  const story = findStory(room, storyId);
  if (!story) return { ok: false, error: "Story not found." };
  if (room.currentStoryId !== storyId) return { ok: false, error: "That story is not active." };
  story.status = "done";
  story.finalEstimate = finalEstimate;
  story.finalPoints = room.estimatePoints ? finalPoints : null;
  // Advance to the next pending story, if any.
  const next = room.stories.find((s) => s.status === "pending");
  if (next) {
    next.status = "voting";
    room.currentStoryId = next.id;
  } else {
    room.currentStoryId = null;
  }
  touch(room);
  return { ok: true };
}

export function setModel(room: Room, modelId: string, outputRatio?: number): { ok: boolean; error?: string } {
  if (!PRICING[modelId]) return { ok: false, error: "Unknown model." };
  room.modelId = modelId;
  if (typeof outputRatio === "number") room.outputRatio = outputRatio;
  touch(room);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Persistence (serialize Maps -> plain JSON)
// ---------------------------------------------------------------------------

interface PersistedRoom {
  code: string;
  hostToken: string;
  mode?: RoomMode; // absent in rows persisted before modes existed
  estimatePoints?: boolean; // absent in rows persisted before SP voting existed
  modelId: string;
  outputRatio: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  // creatorIp is intentionally NOT persisted — it's PII and only needed for the
  // live per-IP room cap (rebuilt in-memory). The per-IP counter resets on
  // restart, which is an acceptable trade for keeping no IPs at rest.
  currentStoryId: string | null;
  players: Omit<Player, "online">[];
  stories: {
    id: string;
    title: string;
    description: string;
    status: StoryStatus;
    round: number;
    finalEstimate: number | null;
    finalPoints?: number | null;
    votes: { round: number; playerId: string; cardValue?: CardValue; spValue?: SpValue }[];
  }[];
}

function serialize(room: Room): PersistedRoom {
  return {
    code: room.code,
    hostToken: room.hostToken,
    mode: room.mode,
    estimatePoints: room.estimatePoints,
    modelId: room.modelId,
    outputRatio: room.outputRatio,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresAt: room.expiresAt,
    currentStoryId: room.currentStoryId,
    players: [...room.players.values()].map(({ online: _online, ...p }) => p),
    stories: room.stories.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      status: s.status,
      round: s.round,
      finalEstimate: s.finalEstimate,
      finalPoints: s.finalPoints,
      votes: [...s.votes.entries()].flatMap(([round, m]) =>
        [...m.entries()].map(([playerId, v]) => ({ round, playerId, cardValue: v.tokens, spValue: v.sp })),
      ),
    })),
  };
}

function deserialize(p: PersistedRoom): Room {
  const players = new Map<string, Player>();
  for (const pl of p.players) players.set(pl.id, { ...pl, online: false });
  const stories: Story[] = p.stories.map((s) => {
    const votes = new Map<number, Map<string, PlayerVote>>();
    for (const v of s.votes) {
      let r = votes.get(v.round);
      if (!r) {
        r = new Map();
        votes.set(v.round, r);
      }
      r.set(v.playerId, { tokens: v.cardValue, sp: v.spValue });
    }
    return { ...s, finalPoints: s.finalPoints ?? null, votes };
  });
  return {
    code: p.code,
    hostToken: p.hostToken,
    mode: p.mode ?? "backlog",
    estimatePoints: p.estimatePoints ?? false,
    modelId: p.modelId,
    outputRatio: p.outputRatio,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    expiresAt: p.expiresAt,
    // creatorIp not restored — see PersistedRoom. trackIp() no-ops without it,
    // so rehydrated rooms simply aren't counted against the per-IP cap.
    currentStoryId: p.currentStoryId,
    players,
    stories,
  };
}

function persist(room: Room): void {
  saveRoom(room.code, room.expiresAt, JSON.stringify(serialize(room)));
}

// ---------------------------------------------------------------------------
// Boot rehydrate + periodic sweep
// ---------------------------------------------------------------------------

export function rehydrate(): number {
  const now = Date.now();
  const rows = loadRooms(now);
  for (const row of rows) {
    try {
      const room = deserialize(JSON.parse(row.data) as PersistedRoom);
      rooms.set(room.code, room);
      trackIp(room);
    } catch {
      // skip a corrupt row
    }
  }
  return rooms.size;
}

/** Remove expired rooms from memory + DB; returns codes that were removed. */
export function sweepExpired(): string[] {
  const now = Date.now();
  const removed: string[] = [];
  for (const [code, room] of rooms) {
    if (room.expiresAt <= now) {
      untrackIp(room);
      rooms.delete(code);
      removed.push(code);
    }
  }
  purgeExpired(now);
  return removed;
}

