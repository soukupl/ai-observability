import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateBatch, type IngestEvent } from '@ai-obs/protocol';
import {
  INT4_MAX,
  MAX_PHASE_MS,
  MAX_TOKENS_PER_ENTRY,
  MAX_USAGE_CALLS,
  enforceLimits,
  normalizeAgentType,
  normalizeTools,
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
});
