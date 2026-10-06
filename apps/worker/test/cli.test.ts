import { describe, expect, it, vi } from 'vitest';
import { parseRunOnce, runOnce } from '../src/cli.js';
import { fileStateStore, memoryStateStore } from '../src/lib/state.js';
import { loadConfig } from '../src/lib/config.js';
import { healthLine, type Job } from '../src/scheduler.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = () => ({ info: vi.fn(), error: vi.fn() });

describe('parseRunOnce', () => {
  it('reads --once <job>, --once=<job>, once <job> and RUN_ONCE', () => {
    expect(parseRunOnce(['--once', 'rollups'], {})).toBe('rollups');
    expect(parseRunOnce(['--once=budgets'], {})).toBe('budgets');
    expect(parseRunOnce(['once', 'retention'], {})).toBe('retention');
    expect(parseRunOnce([], { RUN_ONCE: 'rollups' })).toBe('rollups');
  });
  it('is undefined in scheduler mode', () => {
    expect(parseRunOnce([], {})).toBeUndefined();
    expect(parseRunOnce(['--once'], { RUN_ONCE: ' ' })).toBeUndefined();
  });
});

describe('runOnce', () => {
  const ok: Job = { name: 'ok', intervalMs: 1, run: vi.fn(async () => 'rows=3') };
  const bad: Job = { name: 'bad', intervalMs: 1, run: async () => { throw new Error('boom'); } };
  it('returns 0, forces the job and logs a health line', async () => {
    const l = log();
    expect(await runOnce('ok', [ok, bad], l)).toBe(0);
    expect(ok.run).toHaveBeenCalledWith(expect.anything(), { force: true });
    expect(l.info).toHaveBeenCalledWith(expect.stringMatching(/^job=ok status=ok ms=\d+ rows=3$/));
  });
  it('returns 1 when the job fails and never throws', async () => {
    const l = log();
    expect(await runOnce('bad', [ok, bad], l)).toBe(1);
    expect(l.error).toHaveBeenCalledWith(expect.stringContaining('job=bad status=error'), expect.any(Error));
  });
  it('returns 2 for an unknown job', async () => {
    const l = log();
    expect(await runOnce('nope', [ok], l)).toBe(2);
    expect(l.error).toHaveBeenCalledWith(expect.stringContaining('expected one of: ok'));
  });
});

describe('healthLine', () => {
  it('is greppable key=value', () => {
    expect(healthLine('rollups', 'ok', 12, 'days=2')).toBe('job=rollups status=ok ms=12 days=2');
    expect(healthLine('rollups', 'error', 5)).toBe('job=rollups status=error ms=5');
  });
});

describe('state store', () => {
  it('persists to a file and survives a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-state-'));
    try {
      fileStateStore(dir).set('k', 'v');
      expect(fileStateStore(dir).get('k')).toBe('v');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('falls back to memory when the directory is not writable', () => {
    const onError = vi.fn();
    const s = fileStateStore('/proc/definitely/not/writable', onError);
    s.set('a', '1');
    s.set('b', '2');
    expect(s.get('a')).toBe('1');
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it('memory store works', () => {
    const s = memoryStateStore({ x: '1' });
    s.set('y', '2');
    expect([s.get('x'), s.get('y'), s.get('z')]).toEqual(['1', '2', undefined]);
  });
});

describe('loadConfig', () => {
  it('has dev defaults and parses env', () => {
    expect(loadConfig({}).smtp).toMatchObject({ host: 'localhost', port: 1025, secure: false });
    expect(loadConfig({}).retentionHourUtc).toBe(3);
    const c = loadConfig({ SMTP_HOST: 'mail', SMTP_PORT: '587', SMTP_SECURE: 'true', RETENTION_HOUR_UTC: '25', APP_URL: 'https://x.io/' });
    expect(c.smtp).toMatchObject({ host: 'mail', port: 587, secure: true });
    expect(c.retentionHourUtc).toBe(3);
    expect(c.appUrl).toBe('https://x.io');
  });
});
