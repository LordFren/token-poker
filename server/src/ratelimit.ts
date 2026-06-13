import { config } from "./config.js";

/** Simple per-key token bucket for throttling socket events. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private capacity = config.rateLimit.capacity,
    private refillPerSec = config.rateLimit.refillPerSec,
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }

  /** Returns true if an event is allowed (and consumes a token). */
  take(cost = 1): boolean {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Timestamp (ms) of the last take(); used to evict idle per-IP buckets. */
  get lastSeen(): number {
    return this.last;
  }

  /** Milliseconds for an idle bucket to refill to full capacity from empty.
   *  After this long idle, the bucket is full, so dropping it loses no state. */
  get fullRefillMs(): number {
    return (this.capacity / this.refillPerSec) * 1000;
  }
}
