import { randomBytes, timingSafeEqual } from "node:crypto";

// base58 alphabet (Bitcoin) — no 0/O/I/l ambiguity.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Unbiased base58 of `len` chars via rejection sampling. Plain `byte % 58`
 * favors the first 256 % 58 = 24 symbols; rejecting bytes >= 232 (4*58) keeps
 * the distribution uniform so slug entropy is the full log2(58) per char.
 */
function base58(len: number): string {
  let out = "";
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b >= 232) continue; // reject the biased tail
      out += B58[b % 58];
      if (out.length === len) break;
    }
  }
  return out;
}

/** ~8-char URL-safe room slug (used as both the code and the /r/<slug> path). */
export function newSlug(len = 8): string {
  return base58(len);
}

/** 128-bit secret token (hex) for player/host identity. */
export function newToken(): string {
  return randomBytes(16).toString("hex");
}

/** Short opaque id for players/stories (non-secret). */
export function newId(prefix: string): string {
  return `${prefix}_${base58(9)}`;
}

/**
 * Constant-time equality for secret tokens (host + player tokens are fixed-length
 * hex). Comparing with `===` short-circuits on the first differing byte, which
 * leaks position via timing; timingSafeEqual always reads the whole buffer.
 * Length is not secret here (all tokens are 32 chars), so an early length check
 * is fine and avoids timingSafeEqual's equal-length requirement.
 */
export function tokenEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
