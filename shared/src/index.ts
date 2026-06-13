// Shared types, card deck, and pricing — the single source of truth used by
// both the server (authoritative cost calc) and the web client (display).

// ---------------------------------------------------------------------------
// Card deck
// ---------------------------------------------------------------------------

/** Non-numeric "cards" that must be excluded from any numeric rollup. */
export const SENTINEL_CARDS = ["?", "coffee"] as const;

/** Token-bucket cards, stored as their raw integer token count (as a string).
 * Planning poker's modified Fibonacci scale (1, 2, 3, 5, 8, 13, 20, 40, 100)
 * on a 25k-token base unit — the fixed per-turn overhead of even the most
 * trivial agentic task. Like story points, the gaps widen on purpose: big
 * estimates are vaguer, so fine distinctions up there are noise. */
export const NUMERIC_CARDS = [
  "25000", //   1
  "50000", //   2
  "75000", //   3
  "125000", //  5
  "200000", //  8
  "325000", // 13
  "500000", // 20
  "1000000", // 40
  "2500000", // 100
  "5000000", // 200
  "10000000", // 400
  "20000000", // 800
] as const;
export type NumericCard = (typeof NUMERIC_CARDS)[number];

/** Full deck the UI renders, in order. */
export const DECK = [...NUMERIC_CARDS, ...SENTINEL_CARDS] as const;
export type CardValue = (typeof DECK)[number];

export function isNumericCard(v: string): v is NumericCard {
  return (NUMERIC_CARDS as readonly string[]).includes(v);
}

/** Story-point cards (standard modified-Fibonacci planning poker sequence).
 * Estimated side-by-side with tokens so teams can discover their own
 * tokens-per-point ratio empirically instead of assuming a conversion. */
export const SP_NUMERIC_CARDS = ["1", "2", "3", "5", "8", "13", "20", "40", "100"] as const;
export type NumericSpCard = (typeof SP_NUMERIC_CARDS)[number];

export const SP_DECK = [...SP_NUMERIC_CARDS, ...SENTINEL_CARDS] as const;
export type SpValue = (typeof SP_DECK)[number];

export function isNumericSpCard(v: string): v is NumericSpCard {
  return (SP_NUMERIC_CARDS as readonly string[]).includes(v);
}

/** Short human label for any card (token or story-point deck),
 * e.g. "50000" -> "50k", "2500000" -> "2.5M", "5" -> "5". */
export function cardLabel(v: string): string {
  if (v === "?") return "?";
  if (v === "coffee") return "☕";
  const n = Number(v);
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Models & pricing (USD per 1,000,000 tokens)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  label: string;
  /** input $ / 1M tokens */
  in: number;
  /** output $ / 1M tokens */
  out: number;
}

export const PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-8": { label: "Opus 4.8", in: 5.0, out: 25.0 },
  "claude-sonnet-4-6": { label: "Sonnet 4.6", in: 3.0, out: 15.0 },
  "claude-haiku-4-5": { label: "Haiku 4.5", in: 1.0, out: 5.0 },
  "claude-fable-5": { label: "Fable 5", in: 10.0, out: 50.0 },
};

export const DEFAULT_MODEL_ID = "claude-opus-4-8";
/** Agentic sessions are input-dominated — output is typically ~10% of total. */
export const DEFAULT_OUTPUT_RATIO = 0.1;

export interface ModelInfo {
  id: string;
  label: string;
  in: number;
  out: number;
}

export function modelList(): ModelInfo[] {
  return Object.entries(PRICING).map(([id, p]) => ({ id, ...p }));
}

/** USD cost of `tokens` for a model, split input/output by `outputRatio`. */
export function costFor(
  tokens: number,
  modelId: string,
  outputRatio = DEFAULT_OUTPUT_RATIO,
): number {
  const p = PRICING[modelId] ?? PRICING[DEFAULT_MODEL_ID];
  const blendedPerMillion = (1 - outputRatio) * p.in + outputRatio * p.out;
  return (tokens * blendedPerMillion) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Validation caps (shared so client & server agree)
// ---------------------------------------------------------------------------

export const LIMITS = {
  name: 40,
  title: 255,
  description: 2000,
  storiesPerRoom: 200,
  playersPerRoom: 50,
} as const;

// ---------------------------------------------------------------------------
// Snapshot shape (server -> all clients, single source of truth for render)
// ---------------------------------------------------------------------------

export type StoryStatus = "pending" | "voting" | "revealed" | "done";

/**
 * How a room runs:
 * - "backlog": stories are typed in up front (or as you go) and estimated one by one.
 * - "quick": no story text ever enters the app — votes are auto-numbered rounds the
 *   host starts/accepts in one click, so confidential issue titles stay in your tracker.
 */
export type RoomMode = "backlog" | "quick";

export interface PlayerView {
  id: string;
  name: string;
  isHost: boolean;
  isSpectator: boolean;
  online: boolean;
  hasVoted: boolean; // for the current round of the current story
}

export interface VoteView {
  playerId: string;
  cardValue?: CardValue;
  spValue?: SpValue;
}

export interface RevealStats {
  count: number;
  median: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  spread: number | null; // max - min
  /** median rounded to the nearest deck bucket — the host's default pick */
  suggested: number | null;
}

export interface StoryView {
  id: string;
  title: string;
  description: string;
  status: StoryStatus;
  round: number;
  finalEstimate: number | null;
  finalPoints: number | null;
  costUsd: number | null;
  /** present only when status === "revealed" */
  votes?: VoteView[];
  stats?: RevealStats;
  /** story-point stats, only in rooms with estimatePoints */
  spStats?: RevealStats;
}

export interface Snapshot {
  room: {
    code: string;
    mode: RoomMode;
    estimatePoints: boolean;
    modelId: string;
    outputRatio: number;
    expiresAt: number; // unix ms
  };
  you: {
    playerId: string;
    isHost: boolean;
    isSpectator: boolean;
    /** the card you picked this round, echoed back only to you (null if none) */
    myVote: CardValue | null;
    /** your story-point pick this round (rooms with estimatePoints) */
    mySpVote: SpValue | null;
  };
  players: PlayerView[];
  currentStory: StoryView | null;
  backlog: StoryView[]; // pending stories
  done: StoryView[]; // completed stories with finalEstimate + costUsd
  totals: { tokens: number; points: number; costUsd: number };
  models: ModelInfo[];
}

// ---------------------------------------------------------------------------
// Socket event payloads
// ---------------------------------------------------------------------------

export interface CreateRoomPayload {
  name: string;
  modelId?: string;
  mode?: RoomMode;
  /** estimate story points side-by-side with tokens (creation-time choice) */
  estimatePoints?: boolean;
  spectator?: boolean;
}
export interface JoinRoomPayload {
  code: string;
  name?: string;
  playerToken?: string;
  spectator?: boolean;
}
/** At least one of cardValue / spValue must be present; each click casts one dimension. */
export interface VotePayload {
  storyId: string;
  round: number;
  cardValue?: CardValue;
  spValue?: SpValue;
}
export interface AddStoryPayload {
  hostToken: string;
  title: string;
  description?: string;
}
export interface RevealPayload {
  hostToken: string;
  storyId: string;
}
export interface ResetPayload {
  hostToken: string;
  storyId: string;
}
export interface NextStoryPayload {
  hostToken: string;
  storyId: string;
  finalEstimate?: number;
  finalPoints?: number;
  /** quick mode: immediately open the next auto-numbered vote after accepting */
  startNext?: boolean;
}
export interface QuickStartPayload {
  hostToken: string;
}
export interface SetModelPayload {
  hostToken: string;
  modelId: string;
  outputRatio?: number;
}

export interface IdentityResult {
  ok: true;
  code: string;
  playerToken: string;
  hostToken?: string;
  snapshot: Snapshot;
}
export interface ErrorResult {
  ok: false;
  error: string;
}
export type Ack = IdentityResult | ErrorResult;

/** server -> client events */
export interface ServerToClientEvents {
  state: (snapshot: Snapshot) => void;
  error: (msg: string) => void;
  expired: () => void;
}

/** client -> server events (all use an ack callback) */
export interface ClientToServerEvents {
  "room:create": (p: CreateRoomPayload, ack: (r: Ack) => void) => void;
  "room:join": (p: JoinRoomPayload, ack: (r: Ack) => void) => void;
  vote: (p: VotePayload, ack: (r: { ok: boolean; error?: string }) => void) => void;
  addStory: (p: AddStoryPayload, ack: (r: { ok: boolean; error?: string }) => void) => void;
  reveal: (p: RevealPayload, ack: (r: { ok: boolean; error?: string }) => void) => void;
  reset: (p: ResetPayload, ack: (r: { ok: boolean; error?: string }) => void) => void;
  nextStory: (p: NextStoryPayload, ack: (r: { ok: boolean; error?: string }) => void) => void;
  quickStart: (p: QuickStartPayload, ack: (r: { ok: boolean; error?: string }) => void) => void;
  setModel: (p: SetModelPayload, ack: (r: { ok: boolean; error?: string }) => void) => void;
}
