import { describe, expect, it } from 'vitest';
import { ageText, formatUserCode, normalizeUserCode, USER_CODE_ALPHABET, withMissBudget } from '../../src/lib/auth/device';
import { RateLimiter } from '../../src/lib/auth/rate-limit';

describe('device login codes (brief Appendix B)', () => {
  it('accepts XXXX-XXXX and XXXXXXXX in any case, with stray spaces', () => {
    expect(normalizeUserCode('ABCD-EFGH')).toBe('ABCDEFGH');
    expect(normalizeUserCode('abcdefgh')).toBe('ABCDEFGH');
    expect(normalizeUserCode(' abcd - efgh ')).toBe('ABCDEFGH');
  });

  it('rejects anything that cannot be a code', () => {
    for (const bad of ['', 'ABCDEFG', 'ABCDEFGHJ', 'ABCD-EFGI', 'ABCD-EFGO', 'ABCD1EFG', "ABCD'; --", null, undefined, 12345678]) {
      expect(normalizeUserCode(bad), String(bad)).toBeNull();
    }
    expect(USER_CODE_ALPHABET).not.toMatch(/[IO]/); // no look-alikes of 1 / 0
  });

  it('formats for display and describes the age', () => {
    expect(formatUserCode('ABCDEFGH')).toBe('ABCD-EFGH');
    const now = 1_000_000_000;
    expect(ageText(now - 10_000, now)).toBe('just now');
    expect(ageText(now - 60_000, now)).toBe('1 minute ago');
    expect(ageText(now - 7 * 60_000, now)).toBe('7 minutes ago');
    expect(ageText(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(ageText(now + 5_000, now)).toBe('just now'); // clock skew
  });
});

describe('wrong-code budget (withMissBudget)', () => {
  it('counts misses, then refuses every attempt (a correct code too) without running it, until the window ends', async () => {
    let now = 0;
    const limiter = new RateLimiter(3, 60_000, () => now);
    let runs = 0;
    const miss = () => { runs++; return Promise.resolve(null); };
    const hit = () => { runs++; return Promise.resolve('found'); };
    for (let i = 0; i < 3; i++) expect(await withMissBudget(limiter, 'u1', miss)).toEqual({ status: 'miss' });
    expect(await withMissBudget(limiter, 'u1', hit)).toEqual({ status: 'limited' });
    expect(await withMissBudget(limiter, 'u1', miss)).toEqual({ status: 'limited' });
    expect(runs).toBe(3); // refused attempts never reach the database
    expect(await withMissBudget(limiter, 'u2', hit)).toEqual({ status: 'ok', value: 'found' }); // per user
    now = 60_000;
    expect(await withMissBudget(limiter, 'u1', hit)).toEqual({ status: 'ok', value: 'found' });
  });

  it('treats false (approve / deny found nothing open) as a miss, and a hit does not spend the budget', async () => {
    const limiter = new RateLimiter(1, 60_000, () => 0);
    expect(await withMissBudget(limiter, 'u', () => Promise.resolve(true))).toEqual({ status: 'ok', value: true });
    expect(limiter.exhausted('u')).toBe(false);
    expect(await withMissBudget(limiter, 'u', () => Promise.resolve(false))).toEqual({ status: 'miss' });
    expect(limiter.exhausted('u')).toBe(true);
  });
});
