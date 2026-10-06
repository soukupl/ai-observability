import type { UsageEntry } from '../protocol-types.js';

/**
 * One usage record as read from a transcript. Convention (packages/db): `input` excludes cache reads
 * and writes; `reasoning` is part of `output`. Adapters normalize to this before calling sumUsage.
 */
export interface UsageRecord {
  /** API response / message id; records sharing it are the same response (transcripts repeat usage per content block) */
  responseId?: string | null;
  model: string;
  effort?: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

const n = (v: number | undefined) => (Number.isFinite(v) && (v as number) > 0 ? Math.round(v as number) : 0);
const keyOf = (model: string, effort: string | null) => `${model}\u0000${effort ?? ''}`;

/**
 * De-duplicates records per API response id (field-wise max, so a later, more complete copy wins)
 * and sums per model × effort. Records without an id each count as their own response.
 */
export function sumUsage(records: Iterable<UsageRecord>): UsageEntry[] {
  const byResponse = new Map<string, UsageRecord>();
  const anonymous: UsageRecord[] = [];
  for (const r of records) {
    if (!r.model) continue;
    if (!r.responseId) {
      anonymous.push(r);
      continue;
    }
    const prev = byResponse.get(r.responseId);
    if (!prev) {
      byResponse.set(r.responseId, { ...r });
      continue;
    }
    prev.input = Math.max(n(prev.input), n(r.input));
    prev.output = Math.max(n(prev.output), n(r.output));
    prev.cacheRead = Math.max(n(prev.cacheRead), n(r.cacheRead));
    prev.cacheWrite = Math.max(n(prev.cacheWrite), n(r.cacheWrite));
    prev.reasoning = Math.max(n(prev.reasoning), n(r.reasoning));
  }
  const out = new Map<string, UsageEntry>();
  for (const r of [...byResponse.values(), ...anonymous]) {
    const effort = r.effort ?? null;
    const k = keyOf(r.model, effort);
    const e = out.get(k) ?? { model: r.model, effort, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, requests: 0 };
    e.input += n(r.input);
    e.output += n(r.output);
    e.cache_read += n(r.cacheRead);
    e.cache_write += n(r.cacheWrite);
    e.reasoning += n(r.reasoning);
    e.requests += 1;
    out.set(k, e);
  }
  return [...out.values()];
}

/** Adds usage lists (e.g. a turn = main run + sub-agent runs), merging equal model × effort. */
export function mergeUsage(...lists: ReadonlyArray<readonly UsageEntry[]>): UsageEntry[] {
  const out = new Map<string, UsageEntry>();
  for (const list of lists) {
    for (const u of list) {
      const k = keyOf(u.model, u.effort);
      const e = out.get(k) ?? { ...u, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, requests: 0 };
      e.input += u.input;
      e.output += u.output;
      e.cache_read += u.cache_read;
      e.cache_write += u.cache_write;
      e.reasoning += u.reasoning;
      e.requests += u.requests;
      out.set(k, e);
    }
  }
  return [...out.values()];
}

export const totalTokens = (u: UsageEntry) => u.input + u.output + u.cache_read + u.cache_write;

/** Primary model × effort of a usage list: most output tokens, then most requests. */
export function primaryModel(usage: readonly UsageEntry[]): { model: string; effort: string | null } | null {
  const best = [...usage].sort((a, b) => b.output - a.output || b.requests - a.requests)[0];
  return best ? { model: best.model, effort: best.effort } : null;
}
