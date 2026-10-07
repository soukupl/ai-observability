import type { SeriesRow } from '@/components/charts/TokensAreaChart';
import { formatUsageName } from '../../../components/format';
import { eachDay } from '../../../lib/queries/range';
import type { SkillsMcpResult } from '@/lib/queries/skills-mcp';
import type { SkillImpact } from '@/lib/skill-impact';

export const displayName = formatUsageName;

export const anyHashed = (r: SkillsMcpResult): boolean =>
  r.skills.some((s) => s.name.startsWith('sha256:')) || r.servers.some((s) => s.name.startsWith('sha256:'));

/** Skill table rows for DataTable (serializable). `userShare` is the fraction of uses the user typed. */
export function skillTableRows(r: SkillsMcpResult, impacts: readonly SkillImpact[] = []): Record<string, unknown>[] {
  const byName = new Map(impacts.map((i) => [i.skill, i]));
  return r.skills.map((s) => ({
    name: displayName(s.name),
    calls: s.calls,
    modelCalls: s.modelCalls,
    userCalls: s.userCalls,
    userShare: s.calls > 0 ? s.userCalls / s.calls : null,
    turns: s.turns,
    users: s.users,
    successDelta: byName.get(s.name)?.enough ? (byName.get(s.name)!.successDelta ?? null) : null,
    costDelta: byName.get(s.name)?.enough ? (byName.get(s.name)!.cost?.delta ?? null) : null,
  }));
}

/** Rows of the skill impact detail table (one per skill with a comparison). */
export function impactTableRows(impacts: readonly SkillImpact[]): Record<string, unknown>[] {
  return impacts.map((i) => {
    // below the sample-size minimum only the counts are shown: deltas from a handful of turns mislead
    const ok = i.enough;
    return {
      name: displayName(i.skill),
      turns: i.turns,
      comparableTurns: i.comparableTurns,
      successRate: ok ? i.successRate : null,
      comparableSuccessRate: ok ? i.comparableSuccessRate : null,
      successDelta: ok ? i.successDelta : null,
      costSkill: ok ? (i.cost?.skill ?? null) : null,
      costComparable: ok ? (i.cost?.comparable ?? null) : null,
      costDelta: ok ? (i.cost?.delta ?? null) : null,
      tokensDelta: ok ? (i.tokens?.delta ?? null) : null,
      durationDelta: ok ? (i.durationMs?.delta ?? null) : null,
      note: ok ? null : 'not enough data',
    };
  });
}

/**
 * Calls per day of the `top` most used names of one kind, the rest folded into "other", for the stacked
 * area chart. Every day of the range is present (zero when unused).
 */
export function daySeries(r: SkillsMcpResult, kind: 'skill' | 'mcp', top = 6): { data: SeriesRow[]; series: string[] } {
  const ranked = (kind === 'skill' ? r.skills : r.servers).map((x) => x.name);
  const head = ranked.slice(0, top);
  const label = (name: string) => (head.includes(name) ? displayName(name) : 'other');
  const series = [...head.map(displayName), ...(ranked.length > top ? ['other'] : [])];
  const byDay = new Map<string, SeriesRow>();
  for (const day of eachDay(r.range.fromDay, r.range.toDay)) {
    byDay.set(day, { x: day, ...Object.fromEntries(series.map((s) => [s, 0])) });
  }
  for (const d of r.days) {
    if (d.kind !== kind) continue;
    const row = byDay.get(d.day);
    if (row) row[label(d.name)] = Number(row[label(d.name)] ?? 0) + d.calls;
  }
  return { data: [...byDay.values()], series };
}

export function totals(r: SkillsMcpResult) {
  const skillUses = r.skills.reduce((s, x) => s + x.calls, 0);
  const typed = r.skills.reduce((s, x) => s + x.userCalls, 0);
  return {
    skillUses,
    typedShare: skillUses > 0 ? typed / skillUses : null,
    mcpCalls: r.servers.reduce((s, x) => s + x.calls, 0),
    mcpTools: r.servers.reduce((s, x) => s + x.tools.length, 0),
  };
}

/** Latency bucket labels (MCP_LATENCY_BUCKETS_MS): < 1 s, 1–5 s, 5–30 s, 30–120 s, > 120 s. */
export const LATENCY_LABELS = ['< 1 s', '1–5 s', '5–30 s', '30–120 s', '> 120 s'] as const;

/** The bucket the p-th percentile of the timed calls falls in (p = 0.5 median, 0.95 p95); null without timings. */
export function latencyPercentile(buckets: readonly number[], p: number): string | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let cum = 0;
  for (let i = 0; i < buckets.length; i++) {
    cum += buckets[i]!;
    if (cum >= p * total) return LATENCY_LABELS[i] ?? null;
  }
  return LATENCY_LABELS[LATENCY_LABELS.length - 1]!;
}

/**
 * Errors / calls the user did not refuse; null without such calls, or when no result of the server / tool was
 * recorded at all (calls from collectors older than MCP reliability: their error rate is unknown, not 0).
 */
export function errorRate(x: { calls: number; errors: number; denied: number; buckets?: readonly number[] }): number | null {
  const n = x.calls - x.denied;
  if (x.buckets && x.errors + x.denied + x.buckets.reduce((a, b) => a + b, 0) === 0) return null;
  return n > 0 ? x.errors / n : null;
}

/** Highlight rule: an error rate of 10 %+ over 20+ calls. */
export const isUnreliable = (x: { calls: number; errors: number; denied: number }): boolean =>
  x.calls >= 20 && (errorRate(x) ?? 0) >= 0.1;
