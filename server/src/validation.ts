import { z } from "zod";
import { DECK, LIMITS, PRICING, SP_DECK } from "@token-poker/shared";

const name = z.string().trim().min(1).max(LIMITS.name);
const optName = z.string().trim().min(1).max(LIMITS.name).optional();
const slug = z.string().trim().min(4).max(24);
const token = z.string().length(32); // 16 bytes hex
const storyId = z.string().min(1).max(64);
const card = z.enum(DECK as unknown as [string, ...string[]]);
const spCard = z.enum(SP_DECK as unknown as [string, ...string[]]);
const modelId = z.enum(Object.keys(PRICING) as [string, ...string[]]);
const round = z.number().int().min(1).max(10_000);
const estimate = z.number().int().min(0).max(1_000_000_000);
const points = z.number().int().min(0).max(10_000);
const ratio = z.number().min(0).max(1);

export const schemas = {
  createRoom: z.object({
    name,
    modelId: modelId.optional(),
    mode: z.enum(["backlog", "quick"]).optional(),
    estimatePoints: z.boolean().optional(),
    spectator: z.boolean().optional(),
  }),
  joinRoom: z.object({
    code: slug,
    name: optName,
    playerToken: token.optional(),
    spectator: z.boolean().optional(),
  }),
  vote: z
    .object({
      storyId,
      round,
      cardValue: card.optional(),
      spValue: spCard.optional(),
    })
    .refine((v) => v.cardValue != null || v.spValue != null, { message: "pick at least one card" }),
  addStory: z.object({
    hostToken: token,
    title: z.string().trim().min(1).max(LIMITS.title),
    description: z.string().trim().max(LIMITS.description).optional(),
  }),
  reveal: z.object({ hostToken: token, storyId }),
  reset: z.object({ hostToken: token, storyId }),
  nextStory: z.object({
    hostToken: token,
    storyId,
    finalEstimate: estimate.optional(),
    finalPoints: points.optional(),
    startNext: z.boolean().optional(),
  }),
  quickStart: z.object({ hostToken: token }),
  setModel: z.object({
    hostToken: token,
    modelId,
    outputRatio: ratio.optional(),
  }),
};

/** Parse with a schema; returns either data or a short error string. */
export function parse<T>(schema: z.ZodType<T>, raw: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  const first = r.error.issues[0];
  return { ok: false, error: first ? `${first.path.join(".") || "input"}: ${first.message}` : "invalid input" };
}
