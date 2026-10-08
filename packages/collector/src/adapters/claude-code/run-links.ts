import type { RunLinkInput } from '../../events.js';

/**
 * Typed links between the sub-agent runs of one turn (ADR-0020). Pure: the session code gathers the
 * turn's known runs (sent earlier + built now) and attaches the incoming links to the runs it sends.
 *
 * - `item`: workflow agents of one orchestration with the same `flowKey` (the `<item>` of a
 *   `<stage>:<item>` label), in start order (then run id): each links to the previous one.
 * - `sequence`: Agent-tool agents (no orchestration) with the same parent (null = the main agent):
 *   each links to the sibling with the latest end that is not after its start (ties: the greater run
 *   id). Siblings that overlap in time are not chained.
 *
 * Self-links and cycles never occur; a run id seen twice counts once (first wins).
 */
export interface LinkableRun {
  runId: string;
  parentRunId: string | null;
  orchestrationId: string | null;
  flowKey: string | null;
  startedMs: number;
  endedMs: number;
}

export function computeRunLinks(runs: readonly LinkableRun[]): Map<string, RunLinkInput[]> {
  const byId = new Map<string, LinkableRun>();
  for (const r of runs) if (!byId.has(r.runId)) byId.set(r.runId, r);
  const out = new Map<string, RunLinkInput[]>();
  const add = (to: string, fromRunId: string, kind: RunLinkInput['kind']) => {
    if (to === fromRunId) return;
    const list = out.get(to) ?? [];
    if (!list.some((l) => l.fromRunId === fromRunId && l.kind === kind)) list.push({ fromRunId, kind });
    out.set(to, list);
  };
  const byRunId = (a: LinkableRun, b: LinkableRun) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);

  const items = new Map<string, LinkableRun[]>();
  const siblings = new Map<string, LinkableRun[]>();
  for (const r of byId.values()) {
    if (r.orchestrationId) {
      if (!r.flowKey) continue;
      const k = JSON.stringify([r.orchestrationId, r.flowKey]);
      items.set(k, [...(items.get(k) ?? []), r]);
    } else {
      const k = r.parentRunId ?? '';
      siblings.set(k, [...(siblings.get(k) ?? []), r]);
    }
  }

  for (const chain of items.values()) {
    chain.sort((a, b) => a.startedMs - b.startedMs || byRunId(a, b));
    for (let i = 1; i < chain.length; i++) add(chain[i]!.runId, chain[i - 1]!.runId, 'item');
  }

  for (const group of siblings.values()) {
    for (const b of group) {
      let best: LinkableRun | null = null;
      for (const a of group) {
        if (a === b || a.endedMs > b.startedMs) continue;
        // two zero-length runs at the same instant would link both ways: only the lower run id leads
        if (a.startedMs === b.startedMs && byRunId(a, b) > 0) continue;
        if (!best || a.endedMs > best.endedMs || (a.endedMs === best.endedMs && byRunId(a, best) > 0)) best = a;
      }
      if (best) add(b.runId, best.runId, 'sequence');
    }
  }
  return out;
}
