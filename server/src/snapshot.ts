import {
  costFor,
  isNumericCard,
  isNumericSpCard,
  modelList,
  NUMERIC_CARDS,
  RevealStats,
  Snapshot,
  SP_NUMERIC_CARDS,
  StoryView,
  VoteView,
} from "@token-poker/shared";
import { PlayerVote, Room, Story } from "./rooms.js";

function roundVotes(story: Story): Map<string, PlayerVote> {
  return story.votes.get(story.round) ?? new Map();
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const TOKEN_BUCKETS = NUMERIC_CARDS.map(Number);
const SP_BUCKETS = SP_NUMERIC_CARDS.map(Number);

function nearestBucket(n: number, buckets: number[]): number {
  return buckets.reduce((best, b) => (Math.abs(b - n) < Math.abs(best - n) ? b : best), buckets[0]);
}

/** Stats over one dimension's numeric votes; `suggested` snaps to that deck's buckets. */
function computeStats(values: number[], buckets: number[]): RevealStats {
  const nums = [...values].sort((a, b) => a - b);
  if (nums.length === 0) {
    return { count: 0, median: null, mean: null, min: null, max: null, spread: null, suggested: null };
  }
  const med = median(nums);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const min = nums[0];
  const max = nums[nums.length - 1];
  return {
    count: nums.length,
    median: med,
    mean,
    min,
    max,
    spread: max - min,
    suggested: med === null ? null : nearestBucket(med, buckets),
  };
}

function revealVotes(story: Story): VoteView[] {
  return [...roundVotes(story).entries()].map(([playerId, v]) => ({
    playerId,
    cardValue: v.tokens,
    spValue: v.sp,
  }));
}

function storyView(room: Room, story: Story): StoryView {
  const base: StoryView = {
    id: story.id,
    title: story.title,
    description: story.description,
    status: story.status,
    round: story.round,
    finalEstimate: story.finalEstimate,
    finalPoints: story.finalPoints,
    costUsd:
      story.finalEstimate != null ? costFor(story.finalEstimate, room.modelId, room.outputRatio) : null,
  };
  // Vote privacy: only expose card values once revealed.
  if (story.status === "revealed") {
    const votes = [...roundVotes(story).values()];
    base.votes = revealVotes(story);
    base.stats = computeStats(
      votes.flatMap((v) => (v.tokens != null && isNumericCard(v.tokens) ? [Number(v.tokens)] : [])),
      TOKEN_BUCKETS,
    );
    if (room.estimatePoints) {
      base.spStats = computeStats(
        votes.flatMap((v) => (v.sp != null && isNumericSpCard(v.sp) ? [Number(v.sp)] : [])),
        SP_BUCKETS,
      );
    }
  }
  return base;
}

export function buildSnapshot(room: Room, viewerId: string): Snapshot {
  const current = room.currentStoryId ? room.stories.find((s) => s.id === room.currentStoryId) ?? null : null;
  const currentRoundVotes = current ? roundVotes(current) : new Map<string, PlayerVote>();

  // "Voted" = picked everything this room asks for (tokens, plus SP when enabled).
  const isComplete = (v: PlayerVote | undefined): boolean =>
    v?.tokens != null && (!room.estimatePoints || v.sp != null);

  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    isSpectator: p.isSpectator,
    online: p.online,
    hasVoted: isComplete(currentRoundVotes.get(p.id)),
  }));

  const done = room.stories.filter((s) => s.status === "done").map((s) => storyView(room, s));
  const backlog = room.stories.filter((s) => s.status === "pending").map((s) => storyView(room, s));

  const totalsTokens = done.reduce((sum, s) => sum + (s.finalEstimate ?? 0), 0);
  const totalsPoints = done.reduce((sum, s) => sum + (s.finalPoints ?? 0), 0);
  const totalsCost = done.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);

  const me = room.players.get(viewerId);
  const myPick = current ? currentRoundVotes.get(viewerId) : undefined;

  return {
    room: {
      code: room.code,
      mode: room.mode,
      estimatePoints: room.estimatePoints,
      modelId: room.modelId,
      outputRatio: room.outputRatio,
      expiresAt: room.expiresAt,
    },
    you: {
      playerId: viewerId,
      isHost: !!me?.isHost,
      isSpectator: !!me?.isSpectator,
      myVote: myPick?.tokens ?? null,
      mySpVote: myPick?.sp ?? null,
    },
    players,
    currentStory: current ? storyView(room, current) : null,
    backlog,
    done,
    totals: { tokens: totalsTokens, points: totalsPoints, costUsd: totalsCost },
    models: modelList(),
  };
}
