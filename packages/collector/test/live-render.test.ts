import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newSessionState } from '../src/adapters/claude-code/state.js';
import { main } from '../src/cli.js';
import { liveCommand, LIVE_REFRESH_MS, type LiveTerminal } from '../src/commands/live.js';
import { formatCost, formatElapsed, formatTokens, renderFrame } from '../src/live/render.js';
import type { LiveSession } from '../src/live/monitor.js';
import { harnessStateDir } from '../src/paths.js';
import { SessionStateStore } from '../src/state.js';
import { at, CWD, SESSION, toolUse, TranscriptBuilder } from './claude-code/fixture.js';
import { cleanupHomes, tmpHome } from './helpers.js';

// A local-time constructor: the header clock is the machine's local time.
const NOW = new Date(2026, 9, 23, 14, 5, 9).getTime();

const row = (o: Partial<LiveSession>): LiveSession => ({
  harness: 'claude-code',
  sessionId: 's',
  title: null,
  project: 'acme',
  cwd: null,
  status: 'working',
  since: NOW,
  usage: [],
  tokens: 0,
  cost: { usd: 0, partial: false },
  tools: 0,
  subagents: 0,
  lastTool: null,
  ...o,
});

const ROWS: LiveSession[] = [
  row({
    title: 'Add retry with exponential backoff to the HTTP client and document it',
    project: 'acme-billing',
    since: NOW - 192_000,
    tokens: 12_345,
    cost: { usd: 0.42, partial: false },
    tools: 14,
    subagents: 2,
    lastTool: 'Bash',
  }),
  row({ harness: 'codex', project: 'acme-app', status: 'idle', since: NOW - 240_000, tokens: 950, cost: { usd: null, partial: false }, tools: 3 }),
  row({ title: 'old one', project: 'x', status: 'stale', since: NOW - 9_000_000 }),
];

describe('formatters', () => {
  it('formatElapsed', () => {
    expect(
      [-5, 0, 45_000, 59_999, 60_000, 192_000, 3_599_000, 3_600_000, 3_840_000, 90_000_000].map(formatElapsed),
    ).toEqual(['0s', '0s', '45s', '59s', '1m00s', '3m12s', '59m59s', '1h00m', '1h04m', '25h00m']);
  });

  it('formatTokens', () => {
    expect([0, 950, 999, 1000, 12_345, 999_949, 999_950, 1_234_567, 25_000_000].map(formatTokens)).toEqual([
      '0',
      '950',
      '999',
      '1.0k',
      '12.3k',
      '999.9k',
      '1.0M',
      '1.2M',
      '25.0M',
    ]);
  });

  it('formatCost', () => {
    expect(formatCost({ usd: 0.42, partial: false })).toBe('≈ $0.42');
    expect(formatCost({ usd: 0.421, partial: true })).toBe('≈ $0.42+');
    expect(formatCost({ usd: 0, partial: false })).toBe('≈ $0.00');
    expect(formatCost({ usd: 1234.5, partial: false })).toBe('≈ $1234.50');
    expect(formatCost({ usd: null, partial: false })).toBe('n/a');
  });
});

describe('renderFrame', () => {
  it('draws the header, the table (stale rows left out) and the footer at width 200', () => {
    expect(renderFrame(ROWS, { now: NOW, width: 200, scope: null })).toEqual([
      'ai-obs live · 2 running · 14:05:09 · q quits',
      '',
      'STATUS         HARNESS      PROJECT       TITLE                                                         TOKENS  ≈COST    TOOLS  AGENTS  LAST TOOL',
      'working 3m12s  claude-code  acme-billing  Add retry with exponential backoff to the HTTP client and d…  12.3k   ≈ $0.42  14     2       Bash',
      'idle 4m00s     codex        acme-app      -                                                             950     n/a      3      0       -',
      '',
      '1 stale hidden · ≈ at default list prices',
    ]);
  });

  it('gives the title what is left at width 80 and drops the last columns first', () => {
    const lines = renderFrame(ROWS, { now: NOW, width: 80, scope: null });
    expect(lines).toEqual([
      'ai-obs live · 2 running · 14:05:09 · q quits',
      '',
      'STATUS         HARNESS      PROJECT       TITLE                  TOKENS  ≈COST',
      'working 3m12s  claude-code  acme-billing  Add retry with expon…  12.3k   ≈ $0.42',
      'idle 4m00s     codex        acme-app      -                      950     n/a',
      '',
      '1 stale hidden · ≈ at default list prices',
    ]);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(80);
  });

  it('shortens long project names before cutting the cost off at width 80', () => {
    const rows = [
      row({ project: 'Ashes-of-the-Vanguard-Exodus', title: 'Status and next steps', status: 'idle', since: NOW - 347_000, tokens: 975_000, cost: { usd: 0.31, partial: false } }),
    ];
    expect(renderFrame(rows, { now: NOW, width: 80, scope: null }).slice(2, 4)).toEqual([
      'STATUS      HARNESS      PROJECT         TITLE                  TOKENS  ≈COST',
      'idle 5m47s  claude-code  Ashes-of-the-…  Status and next steps  975.0k  ≈ $0.31',
    ]);
  });

  it('cuts every line to the width', () => {
    for (const width of [1, 10, 40, 60, 100]) {
      const lines = renderFrame(ROWS, { now: NOW, width, scope: null });
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(width);
      expect(lines.every((l) => l === l.trimEnd())).toBe(true);
    }
    expect(renderFrame(ROWS, { now: NOW, width: 20, scope: null })[0]).toBe('ai-obs live · 2 runn');
  });

  it('keeps the header and footer on a short terminal and counts the sessions left out', () => {
    const many = Array.from({ length: 6 }, (_, i) => row({ sessionId: `s${i}`, project: `p${i}` }));
    const lines = renderFrame(many, { now: NOW, width: 80, scope: null, rows: 8 });
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('ai-obs live · 6 running · 14:05:09 · q quits');
    expect(lines.slice(3, 6).map((l) => l.split(/\s{2,}/)[2])).toEqual(['p0', 'p1', 'p2']);
    expect(lines.at(-1)).toBe('3 more not shown · ≈ at default list prices');
    expect(renderFrame(many, { now: NOW, width: 80, scope: null, rows: 40 })).toHaveLength(6 + 5);
  });

  it('never writes control characters from a directory, title, tool name or scope', () => {
    const evil = row({ project: 'repo\x1b]0;pwned\x07', title: 'T\x1b[2J', lastTool: 'Bash\x9b31m', harness: 'codex' });
    const lines = renderFrame([evil], { now: NOW, width: 200, scope: '/work/\x1b[31mx' });
    expect(lines.join('\n')).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(lines[3]).toContain('repo ]0;pwned');
    expect(lines[3]).toContain('Bash 31m');
  });

  it('says so when nothing runs, and names the scope', () => {
    expect(renderFrame([], { now: NOW, width: 80, scope: null })).toEqual([
      'ai-obs live · 0 running · 14:05:09 · q quits',
      '',
      'No sessions running',
      '',
      '≈ at default list prices',
    ]);
    expect(renderFrame([], { now: NOW, width: 80, scope: '/work/acme' })[0]).toBe('ai-obs live · 0 running in /work/acme · 14:05:09 · q quits');
  });

  it('counts only the sessions shown and reports how many stale ones are hidden', () => {
    const lines = renderFrame([ROWS[2]!, row({ status: 'stale' })], { now: NOW, width: 80, scope: null });
    expect(lines).toEqual([
      'ai-obs live · 0 running · 14:05:09 · q quits',
      '',
      'No sessions running',
      '',
      '2 stale hidden · ≈ at default list prices',
    ]);
  });

  it('shows partial costs with a plus and unknown ones as n/a, and clips long names', () => {
    const lines = renderFrame(
      [row({ project: 'a-very-long-project-directory-name', lastTool: 'mcp__some-server__some_tool_with_a_long_name', cost: { usd: 3.5, partial: true } })],
      { now: NOW, width: 300, scope: null },
    );
    expect(lines[3]).toBe('working 0s  claude-code  a-very-long-project-dir…  -      0       ≈ $3.50+  0      0       mcp__some-server__some_…');
  });
});

// ---------------------------------------------------------------- the command

const closers: string[] = [];
afterEach(() => {
  cleanupHomes();
  for (const d of closers.splice(0)) rmSync(d, { recursive: true, force: true });
});

function capture() {
  const lines: string[] = [];
  return { lines, text: () => lines.join('\n'), io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
}

function fakeTerminal(isTTY: boolean, o: { rows?: number; onKeyThrows?: boolean } = {}) {
  const writes: string[] = [];
  let handler: ((k: string) => void) | null = null;
  let stopped = 0;
  const terminal: LiveTerminal = {
    isTTY,
    columns: () => 100,
    ...(o.rows ? { rows: () => o.rows! } : {}),
    write: (s) => void writes.push(s),
    onKey: (fn) => {
      if (o.onKeyThrows) throw new Error('setRawMode EIO');
      handler = fn;
      return () => {
        handler = null;
        stopped++;
      };
    },
  };
  return { terminal, writes, press: (k: string) => handler?.(k), hasHandler: () => handler !== null, stopped: () => stopped };
}

/** A machine with one working Claude Code session in /work/acme-billing. */
function machine() {
  const paths = tmpHome();
  const claudeDir = mkdtempSync(join(tmpdir(), 'ai-obs-live-cmd-'));
  closers.push(claudeDir);
  const dir = join(claudeDir, 'projects', 'p');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, new TranscriptBuilder().prompt(0, 'u1', 'go').assistant(2, 'm1', 'claude-opus-5-5', { in: 10, out: 50 }, [toolUse('t1', 'Read', {})]).text());
  const store = new SessionStateStore(harnessStateDir(paths, 'claude-code'));
  store.set(SESSION, newSessionState(SESSION, path, CWD, at(9)));
  utimesSync(store.path(SESSION), at(9) / 1000, at(9) / 1000);
  return { paths, claudeDir, now: () => at(12) };
}

describe('ai-obs live', () => {
  it('--once prints one frame and returns 0, on a terminal too', async () => {
    const m = machine();
    for (const isTTY of [false, true]) {
      const c = capture();
      const t = fakeTerminal(isTTY);
      expect(await liveCommand(['--once'], c.io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal })).toBe(0);
      expect(t.writes).toEqual([]);
      expect(c.lines).toHaveLength(1);
      expect(c.text()).toContain('ai-obs live · 1 running');
      expect(c.text()).toMatch(/working 12s +claude-code +acme-billing +- +60 /);
    }
  });

  it('prints one frame when stdout is not a terminal, even without --once', async () => {
    const m = machine();
    const c = capture();
    const t = fakeTerminal(false);
    expect(await liveCommand([], c.io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal })).toBe(0);
    expect(c.text()).toContain('1 running');
    expect(t.writes).toEqual([]);
  });

  it('--cwd keeps the sessions in that directory', async () => {
    const m = machine();
    const inside = capture();
    await liveCommand(['--once', '--cwd'], inside.io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: fakeTerminal(false).terminal, cwd: `${CWD}/src` });
    expect(inside.text()).toContain('0 running in /work/acme-billing/src');
    const same = capture();
    await liveCommand(['--once', '--cwd'], same.io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: fakeTerminal(false).terminal, cwd: CWD });
    expect(same.text()).toContain('1 running in /work/acme-billing');
    const other = capture();
    await liveCommand(['--once', '--cwd'], other.io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: fakeTerminal(false).terminal, cwd: '/work/other' });
    expect(other.text()).toContain('0 running in /work/other');
    expect(other.text()).toContain('No sessions running');
  });

  it('rejects an unknown flag with exit code 2', async () => {
    const paths = tmpHome();
    const c = capture();
    expect(await main(['live', '--nope'], c.io, { paths })).toBe(2);
    expect(c.text()).toContain('ai-obs live:');
    expect(c.text()).toContain('Usage: ai-obs');
  });

  it('runs through main(): --once', async () => {
    const m = machine();
    const c = capture();
    // claudeDir comes from CLAUDE_CONFIG_DIR
    expect(await main(['live', '--once'], c.io, { paths: m.paths, now: m.now, env: { CLAUDE_CONFIG_DIR: m.claudeDir } })).toBe(0);
    expect(c.text()).toContain('1 running');
  });

  it('on a terminal: enters the alternate screen, redraws in place, q restores the screen', async () => {
    const m = machine();
    const t = fakeTerminal(true);
    const done = liveCommand([], capture().io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal, refreshMs: 15 });
    await vi.waitFor(() => expect(t.writes.length).toBeGreaterThanOrEqual(2));
    expect(t.writes[0]).toBe('\x1b[?1049h\x1b[?25l');
    expect(t.writes[1]!.startsWith('\x1b[H')).toBe(true);
    expect(t.writes[1]!.endsWith('\x1b[J')).toBe(true);
    expect(t.writes[1]).toContain('ai-obs live · 1 running');
    expect(t.writes[1]).toContain('\x1b[K\r\n');
    await vi.waitFor(() => expect(t.writes.length).toBeGreaterThanOrEqual(4)); // redrawn without any key
    expect(t.hasHandler()).toBe(true);
    t.press('x'); // other keys do nothing
    t.press('q');
    expect(await done).toBe(0);
    expect(t.writes.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
    expect(t.hasHandler()).toBe(false);
    expect(t.stopped()).toBe(1);
    const n = t.writes.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(t.writes.length).toBe(n); // the redraw timer is gone
  });

  it.each([['Q'], ['\u0003']])('stops on %j', async (key) => {
    const m = machine();
    const t = fakeTerminal(true);
    const done = liveCommand([], capture().io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal, refreshMs: 15 });
    await vi.waitFor(() => expect(t.writes.length).toBeGreaterThanOrEqual(2));
    t.press(key);
    expect(await done).toBe(0);
    expect(t.writes.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
  });

  it('stops on SIGTERM and removes its signal handlers', async () => {
    const m = machine();
    const t = fakeTerminal(true);
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const done = liveCommand([], capture().io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal, refreshMs: 15 });
    await vi.waitFor(() => expect(t.writes.length).toBeGreaterThanOrEqual(2));
    expect(process.listenerCount('SIGTERM')).toBe(before[0]! + 1);
    process.emit('SIGTERM', 'SIGTERM');
    expect(await done).toBe(0);
    expect(t.writes.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
    expect(t.hasHandler()).toBe(false);
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual(before);
  });

  it('restores the screen and its handlers when the terminal input cannot be set up', async () => {
    const m = machine();
    const t = fakeTerminal(true, { onKeyThrows: true });
    const before = ['SIGTERM', 'SIGINT', 'exit'].map((s) => process.listenerCount(s));
    await expect(liveCommand([], capture().io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal, refreshMs: 15 })).rejects.toThrow('setRawMode EIO');
    expect(t.writes).toEqual(['\x1b[?1049h\x1b[?25l', '\x1b[?25h\x1b[?1049l']);
    expect(['SIGTERM', 'SIGINT', 'exit'].map((s) => process.listenerCount(s))).toEqual(before);
  });

  it('restores the screen if the process exits while it runs', async () => {
    const m = machine();
    const t = fakeTerminal(true);
    const before = process.listeners('exit');
    const done = liveCommand([], capture().io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal, refreshMs: 15 });
    await vi.waitFor(() => expect(t.writes.length).toBeGreaterThanOrEqual(2));
    const added = process.listeners('exit').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    const onExit = added[0] as () => void;
    onExit();
    expect(t.writes.at(-1)).toBe('\x1b[?25h\x1b[?1049l');
    t.press('q');
    expect(await done).toBe(0);
    expect(process.listeners('exit')).not.toContain(onExit);
  });

  it('in place: one column short of the terminal and no taller than it', async () => {
    const m = machine();
    const t = fakeTerminal(true, { rows: 5 });
    const done = liveCommand([], capture().io, { paths: m.paths, claudeDir: m.claudeDir, now: m.now, terminal: t.terminal, refreshMs: 15 });
    await vi.waitFor(() => expect(t.writes.length).toBeGreaterThanOrEqual(2));
    t.press('q');
    await done;
    const lines = t.writes[1]!.slice(3, -3).split('\x1b[K\r\n');
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines[0]).toContain('1 running');
    expect(lines.at(-1)).toBe('1 more not shown · ≈ at default list prices');
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(99);
  });

  it('refreshes once a second by default', () => {
    expect(LIVE_REFRESH_MS).toBe(1000);
  });
});
