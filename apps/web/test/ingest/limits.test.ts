import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateBatch, type IngestEvent } from '@ai-obs/protocol';
import {
  INT4_MAX,
  MAX_PHASE_MS,
  MAX_TOKENS_PER_ENTRY,
  MAX_MCP_MS,
  MAX_USAGE_CALLS,
  enforceLimits,
  normalizeAgentGroup,
  normalizeAgentType,
  normalizeFlowKey,
  normalizeRunLinks,
  normalizeOrchestrationId,
  normalizeTools,
  timeWindowProblem,
} from '../../src/lib/ingest/limits';
import { batch, ev } from './fixtures';

function parse(e: ReturnType<(typeof ev)['turn']>): IngestEvent {
  const r = validateBatch(batch([e]));
  if (!r.ok || r.events.length !== 1) throw new Error('fixture must validate');
  return r.events[0]!;
}

describe('enforceLimits', () => {
  it('accepts values at the limit and rejects one above, naming the field', () => {
    const at = parse({ ...ev.turn('s', 't'), lines_added: INT4_MAX, phases_ms: { coding: MAX_PHASE_MS } } as never);
    expect(enforceLimits(at).ok).toBe(true);
    for (const [patch, field] of [
      [{ lines_added: INT4_MAX + 1 }, 'lines_added'],
      [{ lines_removed: INT4_MAX + 1 }, 'lines_removed'],
      [{ files_touched: INT4_MAX + 1 }, 'files_touched'],
      [{ phase_rules_version: INT4_MAX + 1 }, 'phase_rules_version'],
      [{ phases_ms: { thinking: MAX_PHASE_MS + 1 } }, 'phases_ms.thinking'],
      [{ tools: { bash: 1_000_000_001 } }, 'tools'],
    ] as const) {
      expect(enforceLimits(parse({ ...ev.turn('s', 't'), ...patch } as never))).toEqual({ ok: false, reason: `${field} is out of range` });
    }
  });

  it('bounds every token field and requests per usage entry', () => {
    const turn = ev.turn('s', 't') as unknown as { usage: Array<Record<string, number>> };
    for (const f of ['input', 'output', 'cache_read', 'cache_write', 'reasoning']) {
      turn.usage[0]![f] = MAX_TOKENS_PER_ENTRY;
      expect(enforceLimits(parse(turn as never)).ok).toBe(true);
      turn.usage[0]![f] = MAX_TOKENS_PER_ENTRY + 1;
      expect(enforceLimits(parse(turn as never))).toEqual({ ok: false, reason: `usage.${f} is out of range` });
      turn.usage[0]![f] = 1;
    }
    turn.usage[0]!.requests = 10_000_001;
    expect(enforceLimits(parse(turn as never))).toEqual({ ok: false, reason: 'usage.requests is out of range' });
  });

  it('keeps the worst-case sum of one batch far below bigint', () => {
    // 500 events × 64 usage entries at the cap, summed: still < 2^63.
    expect(500 * 64 * MAX_TOKENS_PER_ENTRY).toBeLessThan(2 ** 53);
  });

  it('normalises tools, agent types and signals without rejecting', () => {
    const turn = parse({
      ...ev.turn('s', 't'),
      tools: { Read: 1, 'mcp__srv__tool': 2, '../x': 3, ok_1: 4 },
      outcome: { status: 'success', signals: ['tests_passed', 'my secret note', 'tests_passed'], provisional: false },
    } as never);
    const out = enforceLimits(turn);
    expect(out.ok && out.event.type === 'turn' && out.event.tools).toEqual({ read: 1, mcp: 2, other: 3, ok_1: 4 });
    expect(out.ok && out.event.type === 'turn' && out.event.outcome.signals).toEqual(['tests_passed']);

    const run = enforceLimits(parse({ ...ev.run('t', 'r', null, 1), agent_type: 'C:\\agents\\x' } as never));
    expect(run.ok && run.event.type === 'run' && run.event.agent_type).toBe('other');
  });

  it('bounds skill and MCP counts per entry', () => {
    const ok = parse({ ...ev.turn('s', 't'), skills: { a: { model: MAX_USAGE_CALLS, user: 0 } }, mcp: { s: { t: MAX_USAGE_CALLS } } } as never);
    expect(enforceLimits(ok).ok).toBe(true);
    const skill = parse({ ...ev.turn('s', 't'), skills: { a: { model: 0, user: MAX_USAGE_CALLS + 1 } } } as never);
    expect(enforceLimits(skill)).toEqual({ ok: false, reason: 'skills is out of range' });
    const mcp = parse({ ...ev.run('t', 'r', null, 1), mcp: { s: { t: MAX_USAGE_CALLS + 1 } } } as never);
    expect(enforceLimits(mcp)).toEqual({ ok: false, reason: 'mcp is out of range' });
    const stats = parse({ ...ev.turn('s', 't'), mcp_stats: { s: { t: { errors: 1, ms: MAX_MCP_MS + 1, buckets: [1, 0, 0, 0, 0] } } } } as never);
    expect(enforceLimits(stats)).toEqual({ ok: false, reason: 'mcp_stats is out of range' });
  });

  it('hashed mode: plain skill / MCP names are hashed like an unsalted collector, hashed ones kept', () => {
    const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
    const pre = sha('anything');
    const turn = parse({
      ...ev.turn('s', 't'),
      skills: { 'code-review': { model: 1, user: 2 }, [pre]: { model: 1, user: 0 } },
      mcp: { github: { search_code: 3 } },
    } as never);
    const plain = enforceLimits(turn, 'plain');
    expect(plain.ok && plain.event.type === 'turn' && plain.event.skills).toEqual({ 'code-review': { model: 1, user: 2 }, [pre]: { model: 1, user: 0 } });
    const hashed = enforceLimits(turn, 'hashed');
    expect(hashed.ok && hashed.event.type === 'turn' && hashed.event.skills).toEqual({ [sha('skill:code-review')]: { model: 1, user: 2 }, [pre]: { model: 1, user: 0 } });
    expect(hashed.ok && hashed.event.type === 'turn' && hashed.event.mcp).toEqual({ [sha('mcp:github')]: { [sha('mcp:github/search_code')]: 3 } });
    const withStats = parse({ ...ev.turn('s', 't'), mcp_stats: { github: { search_code: { errors: 1, ms: 5, buckets: [1, 0, 0, 0, 0] } } } } as never);
    const h2 = enforceLimits(withStats, 'hashed');
    expect(h2.ok && h2.event.type === 'turn' && Object.keys(h2.event.mcp_stats![sha('mcp:github')]!)).toEqual([sha('mcp:github/search_code')]);
  });

  it('normalizeTools / normalizeAgentType edge cases', () => {
    expect(normalizeTools({})).toEqual({});
    expect(normalizeTools({ a: 1, A: 2 })).toEqual({ a: 3 });
    expect(normalizeTools({ [`x${'y'.repeat(64)}`]: 1 })).toEqual({ other: 1 });
    expect(normalizeAgentType('general-purpose')).toBe('general-purpose');
    expect(normalizeAgentType('plugin:agent.v2')).toBe('plugin:agent.v2');
    expect(normalizeAgentType('has space')).toBe('other');
    expect(normalizeAgentType('a'.repeat(65))).toBe('other');
  });

  it('normalizeAgentGroup / normalizeOrchestrationId: absent → undefined, path-like group → other, ids clipped', () => {
    expect(normalizeAgentGroup(undefined)).toBeUndefined();
    expect(normalizeAgentGroup('   ')).toBeUndefined();
    expect(normalizeAgentGroup(' workflow:verify ')).toBe('workflow:verify');
    expect(normalizeAgentGroup('general-purpose')).toBe('general-purpose');
    expect(normalizeAgentGroup('/Users/me/agents/x')).toBe('other');
    expect(normalizeAgentGroup('C:\\agents')).toBe('other');
    expect(normalizeAgentGroup('has space')).toBe('other');
    expect(normalizeAgentGroup('g'.repeat(128))).toBe('g'.repeat(128));
    expect(normalizeAgentGroup('g'.repeat(200))).toBe('g'.repeat(128));
    // A group equal to the run's type is sanitised like the type, so the two columns agree.
    const longType = `my-plugin:${'x'.repeat(60)}`; // 70 chars: valid characters, over the 64-char type limit
    expect(normalizeAgentType(longType)).toBe('other');
    expect(normalizeAgentGroup(longType, longType)).toBe('other');
    expect(normalizeAgentGroup('Explore', 'Explore')).toBe('Explore');
    expect(normalizeAgentGroup(longType, 'workflow:x')).toBe(longType);
    expect(normalizeOrchestrationId(undefined)).toBeUndefined();
    expect(normalizeOrchestrationId('wf_01J9ZQ8Y3N4X5V6W7Z8A9B0C')).toBe('wf_01J9ZQ8Y3N4X5V6W7Z8A9B0C');
    expect(normalizeOrchestrationId('0b0a6a8e-7d4b-4c1a-9b5e-3f2d1c0b9a87')).toBe('0b0a6a8e-7d4b-4c1a-9b5e-3f2d1c0b9a87');
    expect(normalizeOrchestrationId('/tmp/run')).toBeUndefined();
    expect(normalizeOrchestrationId('i'.repeat(200))).toBe('i'.repeat(128));
  });

  it('normalizeFlowKey / normalizeRunLinks (ADR-0020): trimmed key, path-like → undefined; links deduplicated without self-links', () => {
    expect(normalizeFlowKey(undefined)).toBeUndefined();
    expect(normalizeFlowKey('  ')).toBeUndefined();
    expect(normalizeFlowKey(' bugs ')).toBe('bugs');
    expect(normalizeFlowKey('/Users/me/x')).toBeUndefined();
    expect(normalizeFlowKey('free text')).toBeUndefined();
    expect(normalizeFlowKey('k'.repeat(200))).toBe('k'.repeat(128));
    expect(normalizeRunLinks(undefined, 'r')).toBeUndefined();
    expect(normalizeRunLinks([{ from_run_id: 'r', kind: 'item' }], 'r')).toBeUndefined();
    expect(
      normalizeRunLinks(
        [
          { from_run_id: 'a', kind: 'item' },
          { from_run_id: 'a', kind: 'item' },
          { from_run_id: 'a', kind: 'sequence' },
          { from_run_id: 'r', kind: 'sequence' },
        ],
        'r',
      ),
    ).toEqual([
      { from_run_id: 'a', kind: 'item' },
      { from_run_id: 'a', kind: 'sequence' },
    ]);
  });

  it('enforceLimits normalises a run\'s flow_key / links and drops them when unusable', () => {
    const run = (extra: object) => parse({ ...ev.run('t', 'r', null, 1), ...extra } as never);
    const a = enforceLimits(run({ stage_index: 3, flow_key: ' data ', links: [{ from_run_id: 'q', kind: 'item' }, { from_run_id: 'q', kind: 'item' }] }));
    expect(a.ok && a.event.type === 'run' && [a.event.stage_index, a.event.flow_key, a.event.links]).toEqual([3, 'data', [{ from_run_id: 'q', kind: 'item' }]]);
    const b = enforceLimits(run({ flow_key: 'a b', links: [{ from_run_id: 'r', kind: 'item' }] }));
    expect(b.ok && b.event.type === 'run' && ['flow_key' in b.event, 'links' in b.event]).toEqual([false, false]);
  });

  it('enforceLimits normalises a run\'s agent_group / orchestration_id and drops them when unusable', () => {
    const run = (extra: object) => parse({ ...ev.run('t', 'r', null, 1), ...extra } as never);
    const a = enforceLimits(run({ agent_group: 'workflow:impl', orchestration_id: 'wf_1' }));
    expect(a.ok && a.event.type === 'run' && [a.event.agent_group, a.event.orchestration_id]).toEqual(['workflow:impl', 'wf_1']);
    const b = enforceLimits(run({ agent_group: '/x/y', orchestration_id: 'a b' }));
    expect(b.ok && b.event.type === 'run' && [b.event.agent_group, 'orchestration_id' in b.event]).toEqual(['other', false]);
    const c = enforceLimits(run({}));
    expect(c.ok && c.event.type === 'run' && ['agent_group' in c.event, 'orchestration_id' in c.event]).toEqual([false, false]);
    const longType = `my-plugin:${'x'.repeat(60)}`;
    const d = enforceLimits(run({ agent_type: longType, agent_group: longType }));
    expect(d.ok && d.event.type === 'run' && [d.event.agent_type, d.event.agent_group]).toEqual(['other', 'other']);
  });
});

describe('turn_started (ADR-0027)', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const started = (at: string) => parse(ev.turnStarted('s', at, 't'));

  it('uses the turn time window with started = ended = started_at', () => {
    expect(timeWindowProblem(started('2026-10-05T09:00:30Z'), 30, now)).toBeNull();
    expect(timeWindowProblem(started('2026-09-05T23:59:00Z'), 30, now)).toMatch(/retention/);
    expect(timeWindowProblem(started(new Date(now + 2 * 86_400_000).toISOString()), 30, now)).toBe(
      'timestamp is more than a day in the future',
    );
  });

  it('enforceLimits passes it through unchanged', () => {
    const e = started('2026-10-05T09:00:30Z');
    expect(enforceLimits(e)).toEqual({ ok: true, event: e });
  });
});
