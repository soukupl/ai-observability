import { describe, expect, it } from 'vitest';
import { retentionDue } from '../src/jobs/retention.js';
import { effectiveRetentionDays, retentionCutoff, retentionCutoffDay } from '../src/lib/retention-policy.js';

describe('effectiveRetentionDays', () => {
  it('uses the company setting when the plan allows it', () => {
    expect(effectiveRetentionDays('team', { retentionDays: 90 })).toBe(90);
    expect(effectiveRetentionDays('business', { retentionDays: 730 })).toBe(730);
  });
  it('is bounded by the plan maximum', () => {
    expect(effectiveRetentionDays('free', { retentionDays: 395 })).toBe(30);
    expect(effectiveRetentionDays('team', { retentionDays: 730 })).toBe(395);
  });
  it('never goes below 30 days and falls back to the default for junk', () => {
    expect(effectiveRetentionDays('business', { retentionDays: 3 })).toBe(30);
    expect(effectiveRetentionDays('business', {})).toBe(395);
    expect(effectiveRetentionDays('business', null)).toBe(395);
  });
});

describe('retentionCutoff', () => {
  it('is aligned to 00:00 UTC so days are kept or deleted whole', () => {
    const now = new Date('2026-10-05T15:30:00Z');
    expect(retentionCutoff(now, 30).toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect(retentionCutoffDay(now, 395)).toBe('2025-09-05');
  });
});

describe('retentionDue', () => {
  const at = (iso: string) => new Date(iso);
  it('runs once per UTC day, not before the configured hour', () => {
    expect(retentionDue(at('2026-10-05T02:59:00Z'), undefined, 3)).toBe(false);
    expect(retentionDue(at('2026-10-05T03:00:00Z'), undefined, 3)).toBe(true);
    expect(retentionDue(at('2026-10-05T10:00:00Z'), '2026-10-05', 3)).toBe(false);
    expect(retentionDue(at('2026-10-06T03:00:00Z'), '2026-10-05', 3)).toBe(true);
  });
});
