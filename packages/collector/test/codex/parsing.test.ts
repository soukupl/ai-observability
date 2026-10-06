import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { usageDelta } from '../../src/adapters/codex/accumulator.js';
import { locateRollout } from '../../src/adapters/codex/locate.js';
import { parseRolloutLine } from '../../src/adapters/codex/records.js';
import { readFirstLine, readNewLines } from '../../src/adapters/codex/rollout.js';
import { extractCodexText, FALLBACK_SUMMARY_MODEL, pickSummaryModel, summaryArgv } from '../../src/adapters/codex/summarize.js';
import { parseApplyPatch, parseExecOutput, spawnedAgentIds, toolFacts } from '../../src/adapters/codex/tools.js';
import { isRevertCommand } from '../../src/analysis/outcome.js';
import { cleanupHomes, tmpHome } from '../helpers.js';
import { CHILD, fixtureLines, SESSION } from './codex-helpers.js';

afterEach(() => cleanupHomes());

const tmp = () => join(tmpHome().root, '..');
const T = (input: number, cached: number, output: number, reasoning = 0) => ({ input, cached, cacheWrite: 0, output, reasoning, total: input + output });

describe('locating rollouts by session id', () => {
  it('prefers the payload transcript path, then scans sessions/ newest first, then archived_sessions/', () => {
    const home = join(tmp(), 'codex');
    const old = join(home, 'sessions', '2026', '09', '30');
    const recent = join(home, 'sessions', '2026', '10', '05');
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });
    mkdirSync(join(home, 'archived_sessions'), { recursive: true });
    const a = join(old, `rollout-2026-09-30T08-00-00-${SESSION}.jsonl`);
    const other = join(recent, 'rollout-2026-10-05T08-00-00-019f0000-0000-7000-8000-00000000ffff.jsonl');
    const archived = join(home, 'archived_sessions', `rollout-2026-09-01T08-00-00-${CHILD}.jsonl`);
    for (const f of [a, other, archived]) writeFileSync(f, '{}\n');
    expect(locateRollout(SESSION, { home })).toBe(a);
    expect(locateRollout(SESSION.toUpperCase(), { home })).toBe(a);
    expect(locateRollout(CHILD, { home })).toBe(archived);
    expect(locateRollout(SESSION, { home, hint: join(home, 'missing.jsonl') })).toBe(a);
    expect(locateRollout(SESSION, { home, hint: other })).toBe(a); // hint names another thread
    const hinted = join(tmp(), `custom-${SESSION}.jsonl`);
    writeFileSync(hinted, '{}\n');
    expect(locateRollout(SESSION, { home, hint: hinted })).toBe(hinted);
    expect(locateRollout('../../etc/passwd', { home })).toBeNull();
    expect(locateRollout('019f0000-0000-7000-8000-00000000dead', { home })).toBeNull();
  });
});

describe('incremental reader', () => {
  it('returns complete lines only and a byte cursor; detects a shrunken file', () => {
    const f = join(tmp(), 'r.jsonl');
    writeFileSync(f, '{"a":1}\n{"b":"ž"}\n{"c":');
    const r1 = readNewLines(f, 0);
    expect(r1.lines).toEqual(['{"a":1}', '{"b":"ž"}']);
    expect(r1.offset).toBe(Buffer.byteLength('{"a":1}\n{"b":"ž"}\n'));
    appendFileSync(f, '3}\n');
    expect(readNewLines(f, r1.offset)).toEqual({ lines: ['{"c":3}'], offset: Buffer.byteLength('{"a":1}\n{"b":"ž"}\n{"c":3}\n'), reset: false });
    writeFileSync(f, '{}\n');
    expect(readNewLines(f, 30).reset).toBe(true);
    expect(readFirstLine(f)).toBe('{}');
    expect(readNewLines(join(tmp(), 'missing'), 5)).toEqual({ lines: [], offset: 5, reset: false });
  });
});

describe('rollout records', () => {
  it('reads the sub-agent link from session_meta.source.subagent.thread_spawn', () => {
    const meta = parseRolloutLine(fixtureLines('child-rollout.jsonl')[0]!);
    expect(meta).toMatchObject({ kind: 'meta', meta: { sessionId: CHILD, isSubagent: true, parentThreadId: SESSION, depth: 1, agentType: 'explorer' } });
    const main = parseRolloutLine(fixtureLines('main-rollout.jsonl')[0]!);
    expect(main).toMatchObject({ kind: 'meta', meta: { sessionId: SESSION, isSubagent: false, parentThreadId: null, cliVersion: '0.154.0' } });
  });

  it('parses MCP tool calls (namespace) and legacy event shapes; ignores garbage', () => {
    const at = '2026-10-05T10:00:00Z';
    expect(parseRolloutLine(JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'function_call', name: 'js', namespace: 'mcp__node_repl', arguments: '{}', call_id: 'c' } })))
      .toMatchObject({ kind: 'tool_call', name: 'mcp__node_repl__js' });
    expect(parseRolloutLine(JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }))).toMatchObject({ kind: 'user_prompt', text: 'hi' });
    expect(parseRolloutLine(JSON.stringify({ timestamp: at, type: 'response_item', payload: { type: 'local_shell_call', call_id: 'c', action: { command: ['bash', '-lc', 'npm test'] } } })))
      .toMatchObject({ kind: 'tool_call', name: 'local_shell', args: { command: ['bash', '-lc', 'npm test'] } });
    expect(parseRolloutLine('not json')).toBeNull();
    expect(parseRolloutLine(JSON.stringify({ id: 'x', timestamp: at, instructions: null }))).toBeNull();
  });
});

describe('token deltas', () => {
  it('uses differences of cumulative totals, skips repeated snapshots, falls back to last on a reset', () => {
    expect(usageDelta(null, { total: T(1000, 200, 100), last: T(1000, 200, 100) })).toEqual(T(1000, 200, 100));
    expect(usageDelta(T(1000, 200, 100), { total: T(2500, 1200, 250), last: null })).toEqual(T(1500, 1000, 150));
    expect(usageDelta(T(2500, 1200, 250), { total: T(2500, 1200, 250), last: T(1500, 1000, 150) })).toBeNull();
    expect(usageDelta(T(9000, 0, 900), { total: T(300, 0, 30), last: T(300, 0, 30) })).toEqual(T(300, 0, 30));
    expect(usageDelta(null, { total: T(0, 0, 0), last: { ...T(0, 0, 0), total: 7974 } })).toBeNull();
  });
});

describe('tool facts', () => {
  const noProc = () => undefined;
  it('classifies exec_command lines, apply_patch paths and multi-agent tools', () => {
    expect(toolFacts('exec_command', { cmd: 'pnpm test' }, null, noProc, isRevertCommand)).toMatchObject({ phase: 'testing', check: 'testing' });
    expect(toolFacts('exec_command', { cmd: 'git checkout -- src/a.ts' }, null, noProc, isRevertCommand)).toMatchObject({ revert: true });
    expect(toolFacts('shell', { command: ['bash', '-lc', 'tsc --noEmit'] }, null, noProc, isRevertCommand)).toMatchObject({ phase: 'validating', check: 'validating' });
    expect(toolFacts('apply_patch', null, '*** Begin Patch\n*** Update File: docs/a.md\n@@\n+x\n*** End Patch', noProc, isRevertCommand)).toMatchObject({ phase: 'documenting' });
    expect(toolFacts('shell', { command: ['apply_patch', '*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch'] }, null, noProc, isRevertCommand)).toMatchObject({ phase: 'coding' });
    expect(toolFacts('wait_agent', {}, null, noProc, isRevertCommand).phase).toBe('delegating');
    expect(toolFacts('assign_agent_task', { task_name: 'review/api' }, null, noProc, isRevertCommand).phase).toBe('delegating'); // MultiAgentV2
    expect(toolFacts('write_stdin', { session_id: 7 }, null, (id) => (id === '7' ? { phase: 'testing', check: 'testing' } : undefined), isRevertCommand)).toMatchObject({ phase: 'testing', processId: '7' });
  });

  it('parses apply_patch envelopes (lines, files incl. moves)', () => {
    const p = parseApplyPatch('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-old\n+new\n+more\n*** Delete File: c.ts\n*** End Patch');
    expect(p).toMatchObject({ files: ['a.ts', 'b.ts', 'c.ts'], added: 2, removed: 1 });
  });

  it('reads exit codes from unified exec, legacy JSON and text outputs', () => {
    expect(parseExecOutput('Chunk ID: 1\nWall time: 1 seconds\nProcess exited with code 2\n')).toEqual({ exitCode: 2, runningId: null });
    expect(parseExecOutput('Process running with session ID 51130\n')).toEqual({ exitCode: null, runningId: '51130' });
    expect(parseExecOutput('{"output":"x","metadata":{"exit_code":0,"duration_seconds":1}}')).toEqual({ exitCode: 0, runningId: null });
    expect(parseExecOutput('Exit code: 1\nWall time: 2s')).toEqual({ exitCode: 1, runningId: null });
    expect(parseExecOutput('hello')).toEqual({ exitCode: null, runningId: null });
  });

  it('finds spawned agent ids in spawn_agent output', () => {
    expect(spawnedAgentIds(`{"agent_id":"${CHILD.toUpperCase()}","nickname":"Ada"}`)).toEqual([CHILD]);
  });
});

describe('summaries via codex exec', () => {
  it('picks the smallest listed model from models_cache.json, honours the env override, falls back', () => {
    const home = join(tmp(), 'codex');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-6-astra', description: 'Frontier intelligence.', visibility: 'list' },
      { slug: 'gpt-reserve', description: 'Fast and affordable agentic coding model.', visibility: 'hide' },
      { slug: 'gpt-5.6-luna', description: 'Older fast and efficient model.', visibility: 'list' },
      { slug: 'gpt-5.5', description: 'Legacy coding model.', visibility: 'list' },
    ] }));
    expect(pickSummaryModel(home, {})).toBe('gpt-5.6-luna');
    expect(pickSummaryModel(home, { AI_OBS_CODEX_SUMMARY_MODEL: 'gpt-x-mini' })).toBe('gpt-x-mini');
    expect(pickSummaryModel(join(tmp(), 'none'), {})).toBe(FALLBACK_SUMMARY_MODEL);
  });

  it('runs codex exec headless with hooks disabled and the prompt on stdin', () => {
    const argv = summaryArgv('gpt-5.6-luna');
    expect(argv.slice(0, 2)).toEqual(['codex', 'exec']);
    expect(argv).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '-c', 'features.hooks=false', '-m', 'gpt-5.6-luna']));
    expect(argv.at(-1)).toBe('-');
    expect(summaryArgv('m', { withUserConfig: true })).not.toContain('--ignore-user-config');
  });

  it('unwraps --json event output to the last agent message', () => {
    const jsonl = ['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"t1\\":\\"x\\"}"}}'].join('\n');
    expect(extractCodexText(jsonl)).toBe('{"t1":"x"}');
    expect(extractCodexText('{"t1": "plain"}')).toBe('{"t1": "plain"}');
  });
});
