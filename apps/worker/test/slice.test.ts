import { describe, expect, it } from 'vitest';
import { nextMonthStart } from '../src/lib/dates.js';
import { hadUserWhenWritten, rollupRowId, sliceMode } from '../src/rollups/slice.js';

describe('sliceMode', () => {
  it('rebuilds when every rolled-up turn still has its raw row, appends when raw rows were deleted', () => {
    expect(sliceMode({ knownRawTurns: 5, rolledTurns: 5 })).toBe('rebuild');
    expect(sliceMode({ knownRawTurns: 6, rolledTurns: 5 })).toBe('rebuild'); // committed after the last rewrite read
    expect(sliceMode({ knownRawTurns: 0, rolledTurns: 0 })).toBe('rebuild'); // never rolled up
    // expired day: the original turns are gone, only a late arrival is left -> never replace the rollup with it
    expect(sliceMode({ knownRawTurns: 0, rolledTurns: 2 })).toBe('append');
    expect(sliceMode({ knownRawTurns: 3, rolledTurns: 4 })).toBe('append'); // interrupted retention pass
  });
});

describe('rollupRowId', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  it('is a valid version-8 UUID that records whether the row had a user when written', () => {
    const withUser = rollupRowId(true);
    const without = rollupRowId(false);
    expect(withUser).toMatch(UUID);
    expect(without).toMatch(UUID);
    expect(withUser).not.toBe(rollupRowId(true));
    expect(hadUserWhenWritten(withUser)).toBe(true);
    expect(hadUserWhenWritten(without)).toBe(false);
    // ids from gen_random_uuid() (seeds, rows written before this rule) are version 4: never "had a user"
    expect(hadUserWhenWritten('6f1c2a3b-1d2e-4a3b-8c4d-5e6f7a8b9c0d')).toBe(false);
  });
});

describe('nextMonthStart', () => {
  it('rolls over months and years', () => {
    expect(nextMonthStart('2026-10-01')).toBe('2026-11-01');
    expect(nextMonthStart('2026-09-30')).toBe('2026-10-01');
    expect(nextMonthStart('2026-12-17')).toBe('2027-01-01');
  });
});
