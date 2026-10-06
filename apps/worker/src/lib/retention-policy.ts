import { effectiveRetentionDays } from '@ai-obs/db';
import { DAY_MS, startOfUtcDay, utcDay } from './dates.js';

export { effectiveRetentionDays };

/**
 * Raw rows that started before this instant are expired. Aligned to 00:00 UTC so a day is always kept or
 * deleted as a whole: partial days would make the whole-day rollup recompute shrink.
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(startOfUtcDay(now).getTime() - retentionDays * DAY_MS);
}

/** First 'YYYY-MM-DD' still inside the retention window. */
export const retentionCutoffDay = (now: Date, retentionDays: number): string => utcDay(retentionCutoff(now, retentionDays));
