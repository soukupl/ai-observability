import { randomUUID } from 'node:crypto';

/**
 * Rules for rewriting one (company, day) slice of daily_rollups without losing history (ADR-0012).
 *
 * Two kinds of rows must survive a slice rewrite because their raw rows are gone for good:
 *
 * 1. **Anonymised rows.** Deleting a user deletes their raw turns (ON DELETE CASCADE) and sets
 *    daily_rollups.user_id to null (ON DELETE SET NULL). Those rows cannot be told apart from rows of
 *    unverified (team-token) turns by their columns, so the worker marks every row it writes in its id:
 *    a random UUID with version digit 8, followed by `a` when the row had a user when written and `0`
 *    when it did not. A row with user_id null whose id says "had a user" lost its user afterwards and is
 *    kept as it is. Rows written by anything else (seeds, rows from before this rule) count as ordinary.
 * 2. **Rows whose raw turns expired.** See `sliceMode`.
 */
export function rollupRowId(hadUser: boolean): string {
  const u = randomUUID();
  return `${u.slice(0, 14)}8${hadUser ? 'a' : '0'}${u.slice(16)}`;
}

/** Whether a row with this id had a user when the worker wrote it (see `rollupRowId`). */
export const hadUserWhenWritten = (id: string): boolean => id[14] === '8' && id[15] === 'a';

/**
 * How to rewrite a slice, given its raw turns that already existed at the last rewrite (created no later
 * than the newest rollup row) and the turns of its rollup rows that are not anonymised.
 *
 * - `rebuild`: none of those raw turns is missing, so the raw rows are complete: replace the
 *   (non-anonymised) rows with a fresh fold of every raw turn. This is the normal case.
 * - `append`: fewer raw turns remain than were rolled up. Raw rows were deleted (an expired day, an
 *   interrupted retention pass, or a widened retention window), so rebuilding would shrink the permanent
 *   rollup. Only turns created after the last rewrite (late arrivals, never rolled up) are added on top.
 */
export function sliceMode(input: { knownRawTurns: number; rolledTurns: number }): 'rebuild' | 'append' {
  return input.knownRawTurns >= input.rolledTurns ? 'rebuild' : 'append';
}
