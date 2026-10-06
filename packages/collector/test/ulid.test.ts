import { describe, expect, it } from 'vitest';
import { decodeTime, ulid, ulidFrom, ULID_RE } from '../src/ulid.js';

describe('ulid', () => {
  it('is 26 Crockford base32 chars and encodes the time', () => {
    const t = Date.UTC(2026, 9, 5, 10, 0, 0);
    const id = ulid(t);
    expect(id).toMatch(ULID_RE);
    expect(decodeTime(id)).toBe(t);
  });

  it('is strictly monotonic within the same millisecond', () => {
    const t = Date.now();
    const ids = Array.from({ length: 1000 }, () => ulid(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts by time across milliseconds, even if the clock goes back', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    const c = ulid(1_500_000); // clock went back: still after b
    expect(a < b && b < c).toBe(true);
  });

  it('ulidFrom is deterministic per seed and time', () => {
    expect(ulidFrom('x', 1000)).toBe(ulidFrom('x', 1000));
    expect(ulidFrom('x', 1000)).not.toBe(ulidFrom('y', 1000));
    expect(ulidFrom('x', 1000)).toMatch(ULID_RE);
    expect(decodeTime(ulidFrom('x', 123456))).toBe(123456);
  });
});
