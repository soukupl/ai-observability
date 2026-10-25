import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { IngestEvent } from '@ai-obs/protocol';
import { readBatchBody } from '../../src/lib/ingest/body';
import { orderEvents } from '../../src/lib/ingest/process-batch';
import { effectiveProject, hashProjectKey, resolveTeam, turnKey } from '../../src/lib/ingest/resolve';
import { mergeUsage, sumUsage } from '../../src/lib/ingest/usage';

const req = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request('http://x/api/v1/ingest', { method: 'POST', body, headers });

describe('readBatchBody', () => {
  it('reads plain and gzip JSON', async () => {
    expect(await readBatchBody(req('{"a":1}'))).toEqual({ ok: true, json: { a: 1 } });
    const gz = gzipSync(Buffer.from('{"a":2}'));
    expect(await readBatchBody(req(gz, { 'content-encoding': 'gzip' }))).toEqual({ ok: true, json: { a: 2 } });
  });

  it('rejects oversized bodies, gzip bombs and too many events with 413', async () => {
    expect((await readBatchBody(req('x'.repeat(101)), 100)) as { status: number }).toMatchObject({ status: 413 });
    const bomb = gzipSync(Buffer.from(`{"pad":"${'a'.repeat(5000)}"}`));
    expect(bomb.length).toBeLessThan(100);
    expect(await readBatchBody(req(bomb, { 'content-encoding': 'gzip' }), 100)).toMatchObject({ status: 413 });
    const many = JSON.stringify({ events: Array.from({ length: 501 }, () => ({})) });
    expect(await readBatchBody(req(many))).toMatchObject({ ok: false, status: 413 });
  });

  it('rejects bad JSON, bad gzip and unknown encodings', async () => {
    expect(await readBatchBody(req('{nope'))).toMatchObject({ status: 400 });
    expect(await readBatchBody(req('{}', { 'content-encoding': 'gzip' }))).toMatchObject({ status: 400 });
    expect(await readBatchBody(req('{}', { 'content-encoding': 'br' }))).toMatchObject({ status: 415 });
  });
});

describe('resolution rules', () => {
  it('attributes a team: admin mapping, then the primary team, else none', () => {
    expect(resolveTeam({ mappedTeamId: 'm', primaryTeamId: 'u' })).toBe('m');
    expect(resolveTeam({ mappedTeamId: null, primaryTeamId: 'u' })).toBe('u');
    expect(resolveTeam({ mappedTeamId: 'm', primaryTeamId: null })).toBe('m');
    expect(resolveTeam({ mappedTeamId: null, primaryTeamId: null })).toBeNull();
    expect(resolveTeam({ mappedTeamId: undefined, primaryTeamId: undefined })).toBeNull();
  });

  it('respects hashed project keys and hashed naming mode', () => {
    const hashed = `sha256:${'a'.repeat(64)}`;
    expect(effectiveProject({ key: 'github.com/acme/x', name: 'x' }, 'plain')).toEqual({ key: 'github.com/acme/x', name: 'x' });
    expect(effectiveProject({ key: hashed, name: 'leaky' }, 'plain')).toEqual({ key: hashed, name: null });
    expect(effectiveProject({ key: 'github.com/acme/x', name: 'x' }, 'hashed')).toEqual({
      key: hashProjectKey('github.com/acme/x'),
      name: null,
    });
    expect(hashProjectKey('github.com/acme/x')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('namespaces collector ids by harness', () => {
    expect(turnKey('codex', 't1')).toBe('codex:t1');
  });
});

describe('usage', () => {
  it('merges duplicate model × effort entries and sums totals', () => {
    const e = (model: string, effort: string | null, input: number) => ({
      model, effort, input, output: 1, cache_read: 2, cache_write: 3, reasoning: 0, requests: 1,
    });
    const rows = mergeUsage([e('m', 'high', 10), e('m', 'high', 5), e('m', null, 1), e('n', 'high', 2)]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ model: 'm', effort: 'high', input: 15, output: 2, cacheRead: 4, requests: 2 });
    expect(sumUsage(rows)).toEqual({ input: 18, output: 4, cacheRead: 8, cacheWrite: 12, reasoning: 0, requests: 4 });
  });
});

describe('orderEvents', () => {
  it('applies sessions, turn starts, turns, runs by depth, patches in arrival order, then session ends', () => {
    const ev = (type: string, extra: object = {}) => ({ type, event_id: `${type}${JSON.stringify(extra)}`, ...extra }) as unknown as IngestEvent;
    const input = [
      ev('session_end'),
      ev('turn_started'),
      ev('turn_summary', { n: 1 }),
      ev('run', { depth: 2 }),
      ev('turn_outcome', { n: 2 }),
      ev('run', { depth: 1 }),
      ev('turn'),
      ev('session_start'),
      ev('turn_outcome', { n: 3 }),
    ];
    expect(orderEvents(input).map((e) => e.event_id)).toEqual([
      'session_start{}',
      'turn_started{}',
      'turn{}',
      'run{"depth":1}',
      'run{"depth":2}',
      'turn_summary{"n":1}',
      'turn_outcome{"n":2}',
      'turn_outcome{"n":3}',
      'session_end{}',
    ]);
  });
});
