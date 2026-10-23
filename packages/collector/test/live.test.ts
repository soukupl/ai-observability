import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeEntries } from '../src/adapters/claude-code/analyze.js';
import { newSessionState, type SessionState, type StoredTurn } from '../src/adapters/claude-code/state.js';
import { slimLine, type SlimEntry } from '../src/adapters/claude-code/transcript.js';
import { parseRolloutLine, type RolloutItem } from '../src/adapters/codex/records.js';
import { applyItems, closeOpenTurn, newSessionState as newCodexState } from '../src/adapters/codex/session.js';
import { provisionalOutcome } from '../src/analysis/outcome.js';
import { ClaudeSessionTail, segmentFacts, SubagentTails, transcriptCwd } from '../src/live/claude-code.js';
import { CodexSessionTail, NULL_ENV } from '../src/live/codex.js';
import { inScope, LIVE_IDLE_STALE_MS, LIVE_WORKING_STALE_MS, LiveMonitor, liveStatus } from '../src/live/monitor.js';
import { harnessStateDir, type AiObsPaths } from '../src/paths.js';
import type { UsageEntry } from '../src/protocol-types.js';
import { SessionStateStore } from '../src/state.js';
import { at, CWD, SESSION, text, threeTurnSession, toolUse, TranscriptBuilder, writeSession } from './claude-code/fixture.js';
import { cleanupHomes, tmpHome } from './helpers.js';

const OPUS = 'claude-opus-5-5';
const iso = (s: number) => new Date(at(s)).toISOString();
const claudeDirs: string[] = [];
afterEach(() => {
  cleanupHomes();
  for (const d of claudeDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const slim = (b: TranscriptBuilder): SlimEntry[] => b.lines.map((l) => slimLine(JSON.stringify(l))).filter((e): e is SlimEntry => e !== null);
const stopAt = (b: TranscriptBuilder, s: number) => b.raw({ type: 'system', subtype: 'turn_duration', timestamp: iso(s), sessionId: b.sessionId, durationMs: 1 });
const touch = (path: string, sec: number) => utimesSync(path, at(sec) / 1000, at(sec) / 1000);
const u = (model: string, o: Partial<UsageEntry> = {}): UsageEntry => ({ model, effort: null, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, requests: 1, ...o });

interface Env {
  paths: AiObsPaths;
  claudeDir: string;
  projectDir: string;
  claude: SessionStateStore;
  codex: SessionStateStore;
}

function env(): Env {
  const paths = tmpHome();
  const claudeDir = mkdtempSync(join(tmpdir(), 'ai-obs-live-claude-'));
  claudeDirs.push(claudeDir);
  const projectDir = join(claudeDir, 'projects', '-work-acme-billing');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(paths.root, { recursive: true });
  return { paths, claudeDir, projectDir, claude: new SessionStateStore(harnessStateDir(paths, 'claude-code')), codex: new SessionStateStore(harnessStateDir(paths, 'codex')) };
}

/** A transcript in projectDir plus (optionally) its hook state; both get mtime `sec`. */
function claudeSession(e: Env, b: TranscriptBuilder, opts: { sec: number; state?: Partial<SessionState> | false; id?: string } ): { path: string; statePath: string | null } {
  const id = opts.id ?? b.sessionId;
  const path = join(e.projectDir, `${id}.jsonl`);
  writeFileSync(path, b.text());
  touch(path, opts.sec);
  if (opts.state === false) return { path, statePath: null };
  e.claude.set(id, { ...newSessionState(id, path, CWD, at(opts.sec)), ...opts.state });
  const statePath = e.claude.path(id);
  touch(statePath, opts.sec);
  return { path, statePath };
}

const working = (id = SESSION, promptAt = 0) =>
  new TranscriptBuilder(id)
    .prompt(promptAt, `u-${id}`, 'fix it')
    .assistant(promptAt + 2, `m-${id}`, OPUS, { in: 10, out: 50, cr: 100, cw: 20 }, [toolUse(`t-${id}`, 'Read', { file_path: '/x' })]);

const finished = (id = SESSION, endAt = 6) => stopAt(working(id).toolResult(4, `t-${id}`, 'ok').assistant(5, `m2-${id}`, OPUS, { in: 2, out: 5 }, [text('done')]), endAt);

const monitorOf = (e: Env, now: number, extra: { scanTranscripts?: boolean } = {}) => new LiveMonitor({ paths: e.paths, claudeDir: e.claudeDir, now: () => now, ...extra });

describe('segmentFacts', () => {
  it('is working from the prompt on, with the turn start, tools and last tool', () => {
    const f = segmentFacts(slim(working()));
    expect(f).toMatchObject({ working: true, since: at(0), lastEntryAt: at(2), tools: 1, subagents: 0, lastTool: 'Read' });
    expect(f.usage).toHaveLength(1);
    expect(f.usage[0]).toMatchObject({ model: OPUS, input: 10, output: 50, cache_read: 100, cache_write: 20, requests: 1 });
  });

  it('a prompt alone is already working', () => {
    expect(segmentFacts(slim(new TranscriptBuilder().prompt(3, 'u', 'hi')))).toMatchObject({ working: true, since: at(3), tools: 0, lastTool: null });
  });

  it('is idle once the end-of-turn record follows the last activity, since = that record', () => {
    const f = segmentFacts(slim(finished(SESSION, 6)));
    expect(f).toMatchObject({ working: false, since: at(6), lastEntryAt: at(6), tools: 1, lastTool: 'Read' });
    expect(f.usage[0]).toMatchObject({ input: 12, output: 55, requests: 2 });
  });

  it('is idle after a user interrupt (no end-of-turn record), since = the interrupt', () => {
    const b = working().interrupt(8);
    expect(segmentFacts(slim(b))).toMatchObject({ working: false, since: at(8) });
  });

  it('is idle after an interrupted tool result', () => {
    const b = working().toolResult(8, `t-${SESSION}`, '[Request interrupted by user for tool use]', true, { interrupted: true });
    expect(segmentFacts(slim(b))).toMatchObject({ working: false, since: at(8) });
  });

  it('is idle after an API error placeholder', () => {
    const b = working().toolResult(4, `t-${SESSION}`, 'ok').raw({
      type: 'assistant',
      timestamp: iso(7),
      sessionId: SESSION,
      isApiErrorMessage: true,
      message: { id: 'm-err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error: 529' }], usage: { input_tokens: 0, output_tokens: 0 } },
    });
    const f = segmentFacts(slim(b));
    expect(f).toMatchObject({ working: false, since: at(7) });
    expect(f.usage).toHaveLength(1); // the placeholder carries no usage
  });

  it('works again when activity continues after a stop (a Stop hook made Claude carry on)', () => {
    const b = stopAt(working().toolResult(4, `t-${SESSION}`, 'ok').assistant(5, 'm2', OPUS, { in: 2, out: 5 }, [text('done')]), 6);
    expect(segmentFacts(slim(b)).working).toBe(false);
    b.assistant(9, 'm3', OPUS, { in: 1, out: 1 }, [toolUse('t3', 'Bash', { command: 'ls' })]);
    expect(segmentFacts(slim(b))).toMatchObject({ working: true, since: at(0), lastTool: 'Bash', tools: 2 });
  });

  it('adds the usage of sub-agents', () => {
    const f = segmentFacts(slim(working()), [u('claude-haiku-4-5', { input: 7, output: 9 }), u(OPUS, { input: 5, effort: 'xhigh' })]);
    expect(f.usage.map((x) => [x.model, x.input, x.output]).sort()).toEqual([
      ['claude-haiku-4-5', 7, 9],
      [OPUS, 15, 50],
    ]);
  });
});

describe('ClaudeSessionTail', () => {
  it('counts a response once when its content blocks arrive in different polls (and waits for complete lines)', () => {
    const e = env();
    const b = new TranscriptBuilder()
      .prompt(0, 'u1', 'go')
      .assistant([2, 3], 'm1', OPUS, { in: 10, out: 50, cr: 100 }, [text('thinking out loud'), toolUse('t1', 'Read', { file_path: '/x' })]);
    const lines = b.lines.map((l) => `${JSON.stringify(l)}\n`);
    const path = join(e.projectDir, `${SESSION}.jsonl`);
    const tail = new ClaudeSessionTail({ sessionId: SESSION, transcriptPath: path, offset: 0 });
    expect(tail.poll()).toBe(false); // no file yet
    expect(tail.facts()).toBeNull();

    writeFileSync(path, lines[0]! + lines[1]!);
    expect(tail.poll()).toBe(true);
    expect(tail.facts()?.usage[0]).toMatchObject({ input: 10, output: 50, requests: 1 });

    appendFileSync(path, lines[2]!.slice(0, 30)); // half-written line: not read yet
    expect(tail.poll()).toBe(false);
    appendFileSync(path, lines[2]!.slice(30));
    expect(tail.poll()).toBe(true);
    const f = tail.facts()!;
    expect(f.usage).toHaveLength(1);
    expect(f.usage[0]).toMatchObject({ input: 10, output: 50, cache_read: 100, requests: 1 });
    expect(f).toMatchObject({ working: true, tools: 1, lastTool: 'Read' });
    expect(tail.poll()).toBe(false);
  });

  it('keeps only the latest prompt segment and starts at the given offset', () => {
    const e = env();
    const fx = threeTurnSession();
    const path = writeSession(e.projectDir, fx, { subagents: false });
    const from = readFileSync(path, 'utf8')
      .split('\n')
      .slice(0, fx.turn2End)
      .reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    const tail = new ClaudeSessionTail({ sessionId: SESSION, transcriptPath: path, offset: from });
    expect(tail.poll()).toBe(true);
    expect(tail.hasPrompt()).toBe(true);
    const f = tail.facts()!;
    // turn 3 only, from its prompt to the end-of-turn record the fixture's trailing `noise` writes
    expect(f.since).toBe(at(406));
    expect(f.working).toBe(false);
    expect(f.tools).toBe(4);
    expect(f.lastTool).toBe('Bash');
  });

  it('reads titles; /rename wins over the generated one', () => {
    const e = env();
    const b = working().raw({ type: 'ai-title', aiTitle: 'Generated title', sessionId: SESSION });
    const path = join(e.projectDir, `${SESSION}.jsonl`);
    writeFileSync(path, b.text());
    const tail = new ClaudeSessionTail({ sessionId: SESSION, transcriptPath: path, offset: 0 });
    tail.poll();
    expect(tail.title()).toBe('Generated title');
    appendFileSync(path, `${JSON.stringify({ type: 'custom-title', customTitle: 'My rename', sessionId: SESSION })}\n`);
    expect(tail.poll()).toBe(true);
    expect(tail.title()).toBe('My rename');
    expect(tail.titles()).toEqual({ ai: 'Generated title', custom: 'My rename' });
  });

  it('restarts from the beginning when the transcript was replaced by a shorter one', () => {
    const e = env();
    const path = join(e.projectDir, `${SESSION}.jsonl`);
    writeFileSync(path, finished().text());
    const tail = new ClaudeSessionTail({ sessionId: SESSION, transcriptPath: path, offset: 0 });
    tail.poll();
    expect(tail.facts()?.working).toBe(false);
    writeFileSync(path, new TranscriptBuilder().prompt(50, 'u9', 'again').text());
    expect(tail.poll()).toBe(true);
    expect(tail.facts()).toMatchObject({ working: true, since: at(50), tools: 0 });
  });
});

describe('SubagentTails', () => {
  it('adds the usage of sub-agents and nested sub-agents of the turn', () => {
    const e = env();
    const fx = threeTurnSession();
    const path = writeSession(e.projectDir, fx, { upTo: fx.turn1End });
    const tail = new ClaudeSessionTail({ sessionId: SESSION, transcriptPath: path, offset: 0 });
    tail.poll();
    const f = tail.facts()!;
    expect(f).toMatchObject({ working: false, subagents: 1 });
    const haiku = f.usage.filter((x) => x.model === 'claude-haiku-4-5');
    const sum = (k: 'input' | 'output' | 'cache_read' | 'cache_write' | 'requests') => haiku.reduce((n, x) => n + x[k], 0);
    // a1: 100+8+20 in, 40+12+60 out, 500+520 read, 500 written; nested a2 (no effort, so its own row): 7 in, 9 out
    expect(haiku).toHaveLength(2);
    expect([sum('input'), sum('output'), sum('cache_read'), sum('cache_write'), sum('requests')]).toEqual([135, 121, 1020, 500, 4]);
    expect(f.usage.find((x) => x.model === 'claude-opus-5-5')!.input).toBe(10 + 5 + 3 + 2);
  });

  it('follows an agent transcript as it grows and relists agents when the turn launches more', () => {
    const e = env();
    const path = join(e.projectDir, `${SESSION}.jsonl`);
    const sub = join(e.projectDir, SESSION, 'subagents');
    mkdirSync(sub, { recursive: true });
    const a = new TranscriptBuilder(SESSION, { agentId: 'a9' }).prompt(1, 'a9-p', 'dig').assistant(2, 'sm1', 'claude-haiku-4-5', { in: 3, out: 4 }, [text('x')]);
    writeFileSync(join(sub, 'agent-a9.jsonl'), a.text());
    writeFileSync(join(sub, 'agent-a9.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu_a9', spawnDepth: 1 }));
    let clock = at(0);
    const tails = new SubagentTails(() => clock);
    expect(tails.poll(path, [])).toEqual([]);
    expect(tails.poll(path, ['tu_a9'])[0]).toMatchObject({ model: 'claude-haiku-4-5', input: 3, output: 4 });
    appendFileSync(join(sub, 'agent-a9.jsonl'), `${JSON.stringify(new TranscriptBuilder(SESSION, { agentId: 'a9' }).assistant(5, 'sm2', 'claude-haiku-4-5', { in: 1, out: 1 }, [text('y')]).lines[0])}\n`);
    expect(tails.poll(path, ['tu_a9'])[0]).toMatchObject({ input: 4, output: 5, requests: 2 });
    // a second agent appears: not listed again before 5 s, unless the turn's call count grew
    writeFileSync(join(sub, 'agent-b1.jsonl'), new TranscriptBuilder(SESSION, { agentId: 'b1' }).prompt(1, 'b-p', 'x').assistant(2, 'sm3', 'claude-haiku-4-5', { in: 10, out: 10 }, [text('z')]).text());
    writeFileSync(join(sub, 'agent-b1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu_b1', spawnDepth: 1 }));
    expect(tails.poll(path, ['tu_a9'])[0]).toMatchObject({ input: 4 });
    clock += 5000;
    expect(tails.poll(path, ['tu_a9'])[0]).toMatchObject({ input: 4 }); // b1 belongs to another call
    expect(tails.poll(path, ['tu_a9', 'tu_b1'])[0]).toMatchObject({ input: 14, output: 15 });
  });

  it('forgets the agents of earlier turns (only the current turn\'s are kept in memory)', () => {
    const e = env();
    const path = join(e.projectDir, `${SESSION}.jsonl`);
    const sub = join(e.projectDir, SESSION, 'subagents');
    mkdirSync(sub, { recursive: true });
    for (const id of ['a1', 'b2']) {
      writeFileSync(join(sub, `agent-${id}.jsonl`), new TranscriptBuilder(SESSION, { agentId: id }).prompt(1, `${id}-p`, 'x').assistant(2, `${id}-m`, 'claude-haiku-4-5', { in: 1, out: 1 }, [text('z')]).text());
      writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'Explore', toolUseId: `tu_${id}`, spawnDepth: 1 }));
    }
    const tails = new SubagentTails();
    const held = () => [...(tails as unknown as { agents: Map<string, unknown> }).agents.keys()];
    tails.poll(path, ['tu_a1']);
    expect(held()).toEqual(['a1']);
    tails.poll(path, ['tu_b2']); // the next turn launched another agent
    expect(held()).toEqual(['b2']);
    expect(tails.poll(path, [])).toEqual([]); // a turn without agents
    expect(held()).toEqual([]);
  });

  it('includes Workflow agents through the wf: key of the launch', () => {
    const e = env();
    const path = join(e.projectDir, `${SESSION}.jsonl`);
    const wf = join(e.projectDir, SESSION, 'subagents', 'workflows', 'wf_abc123');
    mkdirSync(wf, { recursive: true });
    writeFileSync(join(wf, 'agent-w1.jsonl'), new TranscriptBuilder(SESSION, { agentId: 'w1' }).prompt(1, 'w-p', 'x').assistant(2, 'wm1', 'claude-haiku-4-5', { in: 6, out: 7 }, [text('z')]).text());
    writeFileSync(join(wf, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: 'fix:item-1', spawnDepth: 1 }));
    expect(new SubagentTails().poll(path, ['wf:wf_abc123'])[0]).toMatchObject({ input: 6, output: 7 });
    expect(new SubagentTails().poll(path, ['wf:wf_other'])).toEqual([]);
  });
});

describe('transcriptCwd', () => {
  it('returns the first cwd of the transcript', () => {
    const e = env();
    const path = join(e.projectDir, 'x.jsonl');
    writeFileSync(path, `{"type":"file-history-snapshot"}\n${working().text()}`);
    expect(transcriptCwd(path)).toBe(CWD);
    expect(transcriptCwd(join(e.projectDir, 'missing.jsonl'))).toBeNull();
    writeFileSync(path, '{"a":1}\n');
    expect(transcriptCwd(path)).toBeNull();
  });
});

describe('liveStatus and thresholds', () => {
  it('pins the literals shared with apps/web/src/lib/live/status.ts (IDLE_MAX_MS, WORKING_MAX_MS)', () => {
    expect(LIVE_IDLE_STALE_MS).toBe(1_800_000);
    expect(LIVE_WORKING_STALE_MS).toBe(7_200_000);
  });

  it('idle turns stale at exactly 30 minutes without a signal', () => {
    const f = { working: false, since: 0, lastSignalAt: 1_000 };
    expect(liveStatus(f, 1_000 + LIVE_IDLE_STALE_MS - 1)).toBe('idle');
    expect(liveStatus(f, 1_000 + LIVE_IDLE_STALE_MS)).toBe('stale');
  });

  it('working turns stale only after more than 2 hours, whatever the last signal', () => {
    const f = { working: true, since: 5_000, lastSignalAt: 0 };
    expect(liveStatus(f, 5_000 + LIVE_WORKING_STALE_MS)).toBe('working');
    expect(liveStatus(f, 5_000 + LIVE_WORKING_STALE_MS + 1)).toBe('stale');
  });
});

describe('inScope', () => {
  it('matches the directory itself and anything below it, not siblings sharing a prefix', () => {
    expect(inScope('/work/acme', '/work/acme')).toBe(true);
    expect(inScope('/work/acme/packages/a', '/work/acme')).toBe(true);
    expect(inScope('/work/acme-billing', '/work/acme')).toBe(false);
    expect(inScope('/work', '/work/acme')).toBe(false);
    expect(inScope(null, '/work/acme')).toBe(false);
    expect(inScope('/anything', '/')).toBe(true);
  });
});

describe('LiveMonitor discovery', () => {
  it('lists open sessions with fresh state and transcripts, not ended or old ones', async () => {
    const e = env();
    const ID_LIVE = SESSION;
    const ID_ENDED = '22222222-2222-4333-8444-555555555555';
    const ID_OLD = '33333333-2222-4333-8444-555555555555';
    const ID_SCAN = '44444444-2222-4333-8444-555555555555';
    const ID_SCAN_OLD = '55555555-2222-4333-8444-555555555555';
    claudeSession(e, working(ID_LIVE), { sec: 9 });
    claudeSession(e, working(ID_ENDED), { sec: 9, state: { ended: true } });
    claudeSession(e, working(ID_OLD), { sec: -3 * 3600 });
    claudeSession(e, working(ID_SCAN, 5), { sec: 9, state: false }); // no hook state: found by the transcript scan
    claudeSession(e, working(ID_SCAN_OLD), { sec: -3600, state: false }); // untouched for an hour
    writeFileSync(join(e.projectDir, 'notes.jsonl'), working('x').text()); // not a session id
    touch(join(e.projectDir, 'notes.jsonl'), 9);

    const rows = await monitorOf(e, at(10)).refresh();
    expect(rows.map((r) => r.sessionId).sort()).toEqual([ID_LIVE, ID_SCAN].sort());
    const scan = rows.find((r) => r.sessionId === ID_SCAN)!;
    expect(scan).toMatchObject({ harness: 'claude-code', cwd: CWD, project: 'acme-billing', status: 'working', since: at(5) });

    const noScan = await monitorOf(e, at(10), { scanTranscripts: false }).refresh();
    expect(noScan.map((r) => r.sessionId)).toEqual([ID_LIVE]);
  });

  it('skips codex sessions that are ended, sub-agents, without a rollout, old or of another state version', async () => {
    const e = env();
    const rollout = join(e.paths.root, 'rollout.jsonl');
    writeFileSync(rollout, '');
    const put = (id: string, over: object, sec = 9) => {
      e.codex.set(id, { ...newCodexState(id, at(0)), rolloutPath: rollout, ...over });
      touch(e.codex.path(id), sec);
    };
    put('c-live', {});
    put('c-ended', { ended: true });
    put('c-sub', { subagent: true });
    put('c-norollout', { rolloutPath: null });
    put('c-old', {}, -3 * 3600);
    put('c-v2', { v: 2 });
    const rows = await monitorOf(e, at(10), { scanTranscripts: false }).refresh();
    expect(rows.map((r) => r.sessionId)).toEqual(['c-live']);
    expect(rows[0]).toMatchObject({ harness: 'codex', status: 'idle', title: null });
  });

  it('looks for new sessions every 5 s, polls known ones on every refresh', async () => {
    const e = env();
    const first = claudeSession(e, working(SESSION), { sec: 9 });
    let now = at(10);
    const m = new LiveMonitor({ paths: e.paths, claudeDir: e.claudeDir, now: () => now });
    expect((await m.refresh()).map((r) => r.sessionId)).toEqual([SESSION]);

    const other = '66666666-2222-4333-8444-555555555555';
    claudeSession(e, working(other), { sec: 10 });
    now = at(12);
    expect(await m.refresh()).toHaveLength(1); // not discovered yet

    appendFileSync(first.path, `${JSON.stringify(new TranscriptBuilder().assistant(11, 'm-more', OPUS, { in: 1, out: 1 }, [toolUse('t9', 'Bash', { command: 'ls' })]).lines[0])}\n`);
    now = at(13);
    const rows = await m.refresh();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lastTool: 'Bash', tools: 2 }); // polled without a new discovery

    now = at(16);
    expect((await m.refresh()).map((r) => r.sessionId).sort()).toEqual([SESSION, other].sort());
  });

  it('forgets a session once its state file reports it ended', async () => {
    const e = env();
    const s = claudeSession(e, working(), { sec: 9 });
    let now = at(10);
    const m = new LiveMonitor({ paths: e.paths, claudeDir: e.claudeDir, now: () => now, scanTranscripts: false });
    expect(await m.refresh()).toHaveLength(1);
    e.claude.set(SESSION, { ...newSessionState(SESSION, s.path, CWD, at(20)), ended: true });
    touch(s.statePath!, 20);
    now = at(21);
    expect(await m.refresh()).toEqual([]);
  });
});

describe('LiveMonitor rows', () => {
  it('shows working with elapsed since the prompt, then idle after the end-of-turn record, with tokens and cost', async () => {
    const e = env();
    const s = claudeSession(e, working(), { sec: 9, state: { turns: [] } });
    const m = monitorOf(e, at(12), { scanTranscripts: false });
    const [w] = await m.refresh();
    expect(w).toMatchObject({ harness: 'claude-code', sessionId: SESSION, status: 'working', since: at(0), tools: 1, subagents: 0, lastTool: 'Read', tokens: 180, project: 'acme-billing', title: null });
    expect(w!.cost.partial).toBe(false);
    // 10 in x4 + 50 out x20 + 100 read x0.2 + 20 written x5 = 40 + 1000 + 20 + 100 per Mtok
    expect(w!.cost.usd).toBeCloseTo(1160 / 1_000_000, 12);

    writeFileSync(s.path, finished().text());
    const [i] = await m.refresh();
    expect(i).toMatchObject({ status: 'idle', since: at(6), tools: 1 });
    expect(i!.tokens).toBe(180 + 7);
  });

  it('turns an idle session stale after 30 minutes, a working one after 2 hours', async () => {
    const e = env();
    claudeSession(e, finished(SESSION, 6), { sec: 7 });
    const idleId = '77777777-2222-4333-8444-555555555555';
    claudeSession(e, working(idleId, 100), { sec: 100 });
    expect((await monitorOf(e, at(6) + LIVE_IDLE_STALE_MS - 1000, { scanTranscripts: false }).refresh()).map((r) => [r.sessionId, r.status])).toEqual([
      [idleId, 'working'],
      [SESSION, 'idle'],
    ]);
    const later = await monitorOf(e, at(6) + LIVE_IDLE_STALE_MS + 1000, { scanTranscripts: false }).refresh();
    expect(later.find((r) => r.sessionId === SESSION)?.status).toBe('stale');
    expect(later.find((r) => r.sessionId === idleId)?.status).toBe('working');
  });

  it('shows a turn that has run for more than 2 hours as stale while its state is still being written', async () => {
    const e = env();
    claudeSession(e, working(SESSION, 100), { sec: 100 + 7000 }); // hooks (sub-agent stops) kept the state fresh
    const edge = at(100) + LIVE_WORKING_STALE_MS;
    expect((await monitorOf(e, edge, { scanTranscripts: false }).refresh())[0]!.status).toBe('working');
    expect((await monitorOf(e, edge + 1, { scanTranscripts: false }).refresh())[0]!.status).toBe('stale');
  });

  it('orders working (longest running first), idle (most recent first), then stale', async () => {
    const e = env();
    const ids = ['a1111111', 'b2222222', 'c3333333', 'd4444444', 'e5555555'].map((p) => `${p}-2222-4333-8444-555555555555`);
    claudeSession(e, working(ids[0], 50), { sec: 60 }); // working since 50
    claudeSession(e, working(ids[1], 20), { sec: 60 }); // working since 20: runs longer
    claudeSession(e, finished(ids[2], 30), { sec: 60 }); // idle since 30
    claudeSession(e, finished(ids[3], 40), { sec: 60 }); // idle since 40: more recent
    claudeSession(e, finished(ids[4], 8), { sec: 60, state: { lastSeen: at(8) } }); // no signal since 8 s
    const rows = await monitorOf(e, at(8) + LIVE_IDLE_STALE_MS + 1000, { scanTranscripts: false }).refresh();
    expect(rows.map((r) => [r.sessionId.slice(0, 2), r.status])).toEqual([
      ['b2', 'working'],
      ['a1', 'working'],
      ['d4', 'idle'],
      ['c3', 'idle'],
      ['e5', 'stale'],
    ]);
  });

  it('orders idle rows by recency when nothing is stale', async () => {
    const e = env();
    const ids = ['c3333333', 'd4444444'].map((p) => `${p}-2222-4333-8444-555555555555`);
    claudeSession(e, finished(ids[0]!, 30), { sec: 60 });
    claudeSession(e, finished(ids[1]!, 40), { sec: 60 });
    const rows = await monitorOf(e, at(70), { scanTranscripts: false }).refresh();
    expect(rows.map((r) => [r.sessionId.slice(0, 2), r.status])).toEqual([
      ['d4', 'idle'],
      ['c3', 'idle'],
    ]);
  });

  it('takes the title from the transcript, /rename over the state, the state title otherwise', async () => {
    const e = env();
    claudeSession(e, working(SESSION), { sec: 9, state: { title: { ai: 'From state' } } });
    expect((await monitorOf(e, at(10), { scanTranscripts: false }).refresh())[0]!.title).toBe('From state');
    const withTitle = working(SESSION).raw({ type: 'custom-title', customTitle: 'Renamed', sessionId: SESSION });
    writeFileSync(join(e.projectDir, `${SESSION}.jsonl`), withTitle.text());
    expect((await monitorOf(e, at(10), { scanTranscripts: false }).refresh())[0]!.title).toBe('Renamed');
  });

  it('uses the stored last turn when the turn finished before the monitor looked', async () => {
    const e = env();
    const b = finished(SESSION, 6);
    const agg = analyzeEntries(slim(b));
    const turn: StoredTurn = {
      turnId: `u-${SESSION}`,
      sessionId: SESSION,
      agg,
      runUsage: [u('claude-haiku-4-5', { input: 100, output: 100 })],
      rev: 0,
      provisional: provisionalOutcome({}),
      stopFailure: false,
      final: false,
      correction: false,
      reverted: false,
      emitted: [],
    };
    const size = Buffer.byteLength(b.text());
    claudeSession(e, b, { sec: 7, state: { offset: size, turns: [turn] } });
    const [r] = await monitorOf(e, at(10), { scanTranscripts: false }).refresh();
    expect(r).toMatchObject({ status: 'idle', since: at(5), tools: 1, lastTool: 'Read', tokens: 187 + 200 });
  });

  it('never shows a stored turn\'s first-used tool as its last one (Bash, Read, Bash)', async () => {
    const e = env();
    const b = stopAt(
      new TranscriptBuilder(SESSION)
        .prompt(0, `u-${SESSION}`, 'go')
        .assistant(1, 'm1', OPUS, { in: 1, out: 1 }, [toolUse('t1', 'Bash', { command: 'ls' })])
        .toolResult(2, 't1', 'ok')
        .assistant(3, 'm2', OPUS, { in: 1, out: 1 }, [toolUse('t2', 'Read', { file_path: '/x' })])
        .toolResult(4, 't2', 'ok')
        .assistant(5, 'm3', OPUS, { in: 1, out: 1 }, [toolUse('t3', 'Bash', { command: 'pwd' })])
        .toolResult(6, 't3', 'ok')
        .assistant(7, 'm4', OPUS, { in: 1, out: 1 }, [text('done')]),
      8,
    );
    const agg = analyzeEntries(slim(b));
    expect(agg.toolNames).toEqual(['Bash', 'Read']);
    const turn: StoredTurn = {
      turnId: `u-${SESSION}`,
      sessionId: SESSION,
      agg,
      runUsage: [],
      rev: 0,
      provisional: provisionalOutcome({}),
      stopFailure: false,
      final: false,
      correction: false,
      reverted: false,
      emitted: [],
    };
    claudeSession(e, b, { sec: 9, state: { offset: Buffer.byteLength(b.text()), turns: [turn] } });
    const [r] = await monitorOf(e, at(10), { scanTranscripts: false }).refresh();
    expect(r).toMatchObject({ status: 'idle', tools: 3, lastTool: null });
  });

  it('shows a just-started session without any turn as idle at its last hook, and no row for a bare transcript', async () => {
    const e = env();
    claudeSession(e, new TranscriptBuilder(), { sec: 9, state: { lastSeen: at(8) } });
    const [r] = await monitorOf(e, at(10), { scanTranscripts: false }).refresh();
    expect(r).toMatchObject({ status: 'idle', since: at(8), tokens: 0, cost: { usd: 0, partial: false } });
    const other = '88888888-2222-4333-8444-555555555555';
    claudeSession(e, new TranscriptBuilder(other), { sec: 9, state: false });
    expect((await monitorOf(e, at(10)).refresh()).map((x) => x.sessionId)).toEqual([SESSION]);
  });

  it('prices unknown models as partial or n/a', async () => {
    const e = env();
    const b = new TranscriptBuilder()
      .prompt(0, 'u', 'go')
      .assistant(2, 'm1', 'some-future-model', { in: 10, out: 10 }, [toolUse('t', 'Read', {})]);
    claudeSession(e, b, { sec: 9 });
    expect((await monitorOf(e, at(10), { scanTranscripts: false }).refresh())[0]!.cost).toEqual({ usd: null, partial: false });
    b.assistant(3, 'm2', OPUS, { in: 1_000_000, out: 0 }, [text('x')]);
    claudeSession(e, b, { sec: 9 });
    expect((await monitorOf(e, at(10), { scanTranscripts: false }).refresh())[0]!.cost).toEqual({ usd: 4, partial: true });
  });
});

/** path → [bytes, mtime] of every file under the directories */
function snapshot(...roots: string[]): Record<string, [string, number]> {
  const out: Record<string, [string, number]> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = [readFileSync(p, 'utf8'), st.mtimeMs];
    }
  };
  for (const r of roots) walk(r);
  return out;
}

describe('read-only', () => {
  it('never changes the state files, transcripts or anything under the collector home', async () => {
    const e = env();
    const fx = threeTurnSession();
    const path = writeSession(e.projectDir, fx, { upTo: fx.turn1End });
    e.claude.set(SESSION, { ...newSessionState(SESSION, path, CWD, at(9)), offset: 0 });
    touch(e.claude.path(SESSION), 9);
    touch(path, 9);
    const rollout = join(e.paths.root, 'rollout.jsonl');
    writeFileSync(rollout, codexRollout(false).join('\n') + '\n');
    e.codex.set(CODEX, { ...newCodexState(CODEX, at(0)), rolloutPath: rollout });
    touch(e.codex.path(CODEX), 9);
    const before = snapshot(e.paths.root, e.claudeDir);
    const m = monitorOf(e, at(12));
    expect((await m.refresh()).length).toBe(2);
    await m.refresh();
    await m.refresh();
    expect(snapshot(e.paths.root, e.claudeDir)).toEqual(before);
  });
});

// ---------------------------------------------------------------- Codex

const CODEX = '019f0000-0000-7000-8000-0000000000d1';
const cx = (sec: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: iso(sec), type, payload });
const totals = { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 1100 };

/** A Codex rollout: one turn on gpt-5.5, finished at +8 s when `done`. */
function codexRollout(done: boolean): string[] {
  return [
    cx(0, 'session_meta', { id: CODEX, session_id: CODEX, timestamp: iso(0), cwd: '/work/acme-app', cli_version: '0.154.0' }),
    cx(1, 'event_msg', { type: 'task_started', turn_id: 't1' }),
    cx(1, 'turn_context', { turn_id: 't1', model: 'gpt-5.5', effort: 'high' }),
    cx(2, 'event_msg', { type: 'user_message', message: 'Add a retry helper' }),
    cx(4, 'event_msg', { type: 'token_count', info: { total_token_usage: totals, last_token_usage: totals } }),
    cx(5, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'c1' }),
    ...(done ? [cx(8, 'event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' })] : []),
  ];
}

describe('CodexSessionTail', () => {
  it('replays the rollout into a clone: working while the turn is open, idle after task_complete; the state file stays untouched', async () => {
    const e = env();
    const rollout = join(e.paths.root, 'rollout.jsonl');
    writeFileSync(rollout, codexRollout(false).join('\n') + '\n');
    const state = { ...newCodexState(CODEX, at(0)), rolloutPath: rollout };
    e.codex.set(CODEX, state);
    const stateBefore = snapshot(harnessStateDir(e.paths, 'codex'));

    const tail = new CodexSessionTail(state);
    expect(await tail.poll()).toBe(true);
    const w = tail.facts();
    expect(w).toMatchObject({ working: true, since: at(1), tools: 1, subagents: 0, lastTool: 'exec_command' });
    expect(w.usage[0]).toMatchObject({ model: 'gpt-5.5', input: 800, cache_read: 200, output: 100, reasoning: 40 });
    expect(tail.cwd()).toBe('/work/acme-app');
    expect(await tail.poll()).toBe(false);

    appendFileSync(rollout, `${codexRollout(true).at(-1)}\n`);
    expect(await tail.poll()).toBe(true);
    const i = tail.facts();
    expect(i).toMatchObject({ working: false, since: at(8), tools: 1 });
    expect(i.usage[0]).toMatchObject({ input: 800, output: 100 });
    expect(snapshot(harnessStateDir(e.paths, 'codex'))).toEqual(stateBefore);
    expect(state.open).toBeNull(); // the caller's object is not the clone
  });

  it('does not touch the state it was built from and skips to the end when the rollout was rewritten', async () => {
    const e = env();
    const rollout = join(e.paths.root, 'rollout.jsonl');
    writeFileSync(rollout, codexRollout(true).join('\n') + '\n');
    const state = { ...newCodexState(CODEX, at(0)), rolloutPath: rollout, offset: 10_000_000 };
    const tail = new CodexSessionTail(state);
    expect(await tail.poll()).toBe(true); // reset: read position moves to the end, nothing is applied
    expect(tail.facts().working).toBe(false);
    expect(tail.facts().tools).toBe(0);
    expect(await tail.poll()).toBe(false);
  });

  it('shows the tool used last, not the last new tool name, while working and once idle', async () => {
    const e = env();
    const rollout = join(e.paths.root, 'rollout.jsonl');
    const call = (sec: number, name: string, id: string) => cx(sec, 'response_item', { type: 'function_call', name, arguments: '{}', call_id: id });
    const lines = [...codexRollout(false), call(6, 'write_stdin', 'c2'), call(7, 'exec_command', 'c3')];
    writeFileSync(rollout, lines.join('\n') + '\n');
    const tail = new CodexSessionTail({ ...newCodexState(CODEX, at(0)), rolloutPath: rollout });
    await tail.poll();
    expect(tail.facts()).toMatchObject({ working: true, tools: 3, lastTool: 'exec_command' });
    appendFileSync(rollout, `${cx(8, 'event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'done' })}\n`);
    await tail.poll();
    expect(tail.facts()).toMatchObject({ working: false, tools: 3, lastTool: 'exec_command' });
  });

  it('follows newer hook state: a turn the Stop hook closed shows idle, with its sub-agents\' usage', async () => {
    const e = env();
    const rollout = join(e.paths.root, 'rollout.jsonl');
    const lines = codexRollout(false); // task_complete never reaches the rollout
    writeFileSync(rollout, lines.join('\n') + '\n');
    touch(rollout, 6);
    e.codex.set(CODEX, { ...newCodexState(CODEX, at(0)), rolloutPath: rollout, lastActivityAt: at(5) });
    touch(e.codex.path(CODEX), 6);
    let now = at(12);
    const m = new LiveMonitor({ paths: e.paths, claudeDir: e.claudeDir, now: () => now, scanTranscripts: false });
    expect((await m.refresh())[0]).toMatchObject({ status: 'working', tokens: 1100 });

    // the hook read the rollout, closed the turn at its Stop and resolved a sub-agent's usage
    const hook = { ...newCodexState(CODEX, at(0)), rolloutPath: rollout };
    await applyItems(hook, NULL_ENV, lines.map(parseRolloutLine).filter((i): i is RolloutItem => i !== null));
    closeOpenTurn(hook, NULL_ENV, at(9));
    hook.emitted[0]!.children = { kid: [u('gpt-5.5', { input: 50, output: 5 })] };
    hook.offset = statSync(rollout).size;
    e.codex.set(CODEX, hook);
    touch(e.codex.path(CODEX), 13);
    now = at(18);
    expect((await m.refresh())[0]).toMatchObject({ status: 'idle', since: at(9), tokens: 1100 + 55, lastTool: 'exec_command' });
  });

  it('shows a Codex session as a monitor row with its price', async () => {
    const e = env();
    const rollout = join(e.paths.root, 'rollout.jsonl');
    writeFileSync(rollout, codexRollout(false).join('\n') + '\n');
    touch(rollout, 6);
    e.codex.set(CODEX, { ...newCodexState(CODEX, at(0)), rolloutPath: rollout, lastActivityAt: at(5) });
    touch(e.codex.path(CODEX), 6);
    const [r] = await monitorOf(e, at(12), { scanTranscripts: false }).refresh();
    expect(r).toMatchObject({ harness: 'codex', sessionId: CODEX, status: 'working', since: at(1), project: 'acme-app', cwd: '/work/acme-app', tokens: 1100, tools: 1 });
    expect(r!.cost.usd).toBeCloseTo((800 * 5 + 100 * 30 + 200 * 0.5) / 1_000_000, 12);
  });
});
