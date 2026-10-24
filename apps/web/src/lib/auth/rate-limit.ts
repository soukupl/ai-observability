/**
 * In-memory fixed-window limiter (per process). Good enough for one web instance; a multi-instance
 * deployment gets a per-instance limit, which still bounds abuse of the magic-link mailer.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; false when the key is over the limit for the current window. */
  hit(key: string): boolean {
    const t = this.now();
    if (this.hits.size > 10_000) this.prune(t);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** True when the key has used its whole budget for the current window (records nothing). */
  exhausted(key: string): boolean {
    const entry = this.hits.get(key);
    return entry !== undefined && entry.resetAt > this.now() && entry.count >= this.limit;
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

const WINDOW_MS = 15 * 60_000;
const g = globalThis as typeof globalThis & { __aiObsMagicLimits?: { email: RateLimiter; ip: RateLimiter } };

/** Magic-link sends: 5 per e-mail and 20 per IP per 15 minutes. Kept on globalThis to survive dev HMR. */
export const magicLinkLimits = (g.__aiObsMagicLimits ??= {
  email: new RateLimiter(5, WINDOW_MS),
  ip: new RateLimiter(20, WINDOW_MS),
});
