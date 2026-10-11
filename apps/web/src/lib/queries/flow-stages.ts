/**
 * Stages of one workflow run (ADR-0020), used by the Agent flows query (queries/flows) and the flow sections of the
 * turn page. Pure: no database, no React.
 */

/** The fields of a run the stage rule needs. */
export interface StageRun {
  id: string;
  agentGroup: string;
  stageIndex: number | null;
  startedMs: number;
}

const WORKFLOW_GROUP = /^workflow:(.+)$/s;

/** Human stage name of an agent group: `workflow:verify` -> `verify`; a bare `workflow` -> null (no phase known). */
export function stageName(group: string): string | null {
  const m = WORKFLOW_GROUP.exec(group);
  if (m) return m[1]!.trim() || null;
  return group === 'workflow' ? null : group;
}

const byStart = (a: StageRun, b: StageRun) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Stages of one orchestration and each run's row index in them.
 * - With phase ordinals (collector ≥ ADR-0020): the distinct stage indexes present, compacted (gaps of phases that
 *   ran outside the view are dropped); each named by the most common phase name of its runs (ties: earliest run),
 *   `stage N` when none is known. Runs without an ordinal go to the "unstaged" row (null).
 * - Without any ordinal (older rows): stages by group, in order of first start, so old workflows still show phase
 *   rows; an orchestration whose only "stage" is the bare `workflow` group has no stages.
 */
export function orchestrationStages(runs: StageRun[]): { stages: string[]; indexOf: Map<string, number | null> } {
  const sorted = [...runs].sort(byStart);
  const indexOf = new Map<string, number | null>();
  const ordinals = [...new Set(sorted.flatMap((r) => (r.stageIndex === null ? [] : [r.stageIndex])))].sort((a, b) => a - b);
  if (ordinals.length > 0) {
    const dense = new Map(ordinals.map((o, i) => [o, i]));
    const stages = ordinals.map((o) => {
      const counts = new Map<string, number>();
      for (const r of sorted) {
        if (r.stageIndex !== o) continue;
        const name = stageName(r.agentGroup);
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      let best: string | null = null;
      for (const [name, n] of counts) if (best === null || n > counts.get(best)!) best = name;
      return best ?? `stage ${o + 1}`;
    });
    for (const r of sorted) indexOf.set(r.id, r.stageIndex === null ? null : dense.get(r.stageIndex)!);
    return { stages, indexOf };
  }
  const names: string[] = [];
  for (const r of sorted) {
    const name = stageName(r.agentGroup) ?? 'workflow';
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 1 && names[0] === 'workflow') {
    for (const r of sorted) indexOf.set(r.id, null);
    return { stages: [], indexOf };
  }
  for (const r of sorted) indexOf.set(r.id, names.indexOf(stageName(r.agentGroup) ?? 'workflow'));
  return { stages: names, indexOf };
}
