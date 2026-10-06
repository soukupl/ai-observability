import type { SeriesRow } from '@/components/charts/TokensAreaChart';
import { formatUsageName } from '../../../components/format';
import { eachDay } from '../../../lib/queries/range';
import type { SkillsMcpResult } from '@/lib/queries/skills-mcp';

export const displayName = formatUsageName;

export const anyHashed = (r: SkillsMcpResult): boolean =>
  r.skills.some((s) => s.name.startsWith('sha256:')) || r.servers.some((s) => s.name.startsWith('sha256:'));

/** Skill table rows for DataTable (serializable). `userShare` is the fraction of uses the user typed. */
export function skillTableRows(r: SkillsMcpResult): Record<string, unknown>[] {
  return r.skills.map((s) => ({
    name: displayName(s.name),
    calls: s.calls,
    modelCalls: s.modelCalls,
    userCalls: s.userCalls,
    userShare: s.calls > 0 ? s.userCalls / s.calls : null,
    turns: s.turns,
    users: s.users,
  }));
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
