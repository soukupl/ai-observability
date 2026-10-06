import { describe, expect, it } from 'vitest';
import { defaultFilters } from '../../../src/lib/filters';
import { isUnnamedHash, phaseStackRows, projectHref, projectTableRows, turnsHref } from '../../../src/app/(dashboard)/projects/helpers';

const id = '11111111-1111-4111-8111-111111111111';

describe('projects helpers', () => {
  it('detects unnamed hashed keys', () => {
    const key = 'sha256:' + 'a'.repeat(64);
    expect(isUnnamedHash({ key, name: key.slice(0, 15) + '…' })).toBe(true);
    expect(isUnnamedHash({ key, name: 'Billing' })).toBe(false);
    expect(isUnnamedHash({ key: 'my-repo', name: 'my-repo' })).toBe(false);
  });
  it('builds links', () => {
    const f = { ...defaultFilters(), projectId: 'x', range: '7d' as const };
    expect(projectHref(id, f)).toBe(`/projects/${id}?range=7d`);
    expect(turnsHref(id, f)).toContain(`projectId=${id}`);
    expect(turnsHref(id, f).startsWith('/turns?')).toBe(true);
  });
  it('maps rows; no link for turns without project; skipped cost is n/a', () => {
    const tok = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 2 };
    const [a, b] = projectTableRows(
      [
        { projectId: null, name: '(no project)', teamId: null, teamName: null, turns: 1, tokens: tok, cost: { usd: 1, partial: false, unknownModels: [] }, costSkipped: true, successRate: null, unknownShare: 1, spark: [1] },
        { projectId: id, name: 'P', teamId: null, teamName: 'T', turns: 1, tokens: tok, cost: { usd: 1, partial: false, unknownModels: [] }, costSkipped: false, successRate: 1, unknownShare: 0, spark: [] },
      ],
      defaultFilters(),
    );
    expect(a.href).toBeUndefined();
    expect((a.cost as { usd: null }).usd).toBeNull();
    expect(b.href).toBe(`/projects/${id}`);
  });
  it('phase stack keeps only used phases', () => {
    const ms = { thinking: 5, exploring: 0, coding: 5, documenting: 0, testing: 0, validating: 0, other: 0 };
    const out = phaseStackRows([{ key: id, label: 'P', ms, totalMs: 10, share: ms }, { key: null, label: 'empty', ms: { ...ms, thinking: 0, coding: 0 }, totalMs: 0, share: ms }]);
    expect(out.keys).toEqual(['thinking', 'coding']);
    expect(out.rows).toHaveLength(1);
  });
});
