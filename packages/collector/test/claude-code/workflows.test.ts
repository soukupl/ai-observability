import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, threeTurnSession, TranscriptBuilder, text, toolUse } from './fixture.js';
import { assertValid, byType, setup, type Harness } from './helpers.js';

afterEach(cleanupHomes);

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
const WF = 'wf_0123abcd-ef4';
const u = (model: string, effort: string | null, input: number, output: number, cache_read: number, cache_write: number, reasoning: number, requests: number) => ({
  model, effort, input, output, cache_read, cache_write, reasoning, requests,
});

/** Main turn that launches a Workflow in the background (real result shape: status async_launched). */
function launchTurn(h: Harness): string {
  const file = join(h.projectDir, `${SESSION}.jsonl`);
  const b = new TranscriptBuilder();
  b.prompt(0, 'tw', 'run the build workflow');
  b.assistant(1, 'msg_1', OPUS, { in: 1, out: 10 }, [toolUse('tu_wf', 'Workflow', { script: 'export const meta = {}' })]);
  b.toolResult(2, 'tu_wf', 'Workflow launched in background.', false, {
    status: 'async_launched',
    taskId: 'w1',
    taskType: 'local_workflow',
    workflowName: 'demo',
    runId: WF,
  });
  b.assistant(3, 'msg_2', OPUS, { in: 1, out: 10 }, [text('launched')]);
  writeFileSync(file, b.text());
  return file;
}

function writeWfAgent(h: Harness, id: string, label: string, usage: { in: number; out: number }, model = SONNET, extraMeta: Record<string, unknown> = {}) {
  const dir = join(h.projectDir, SESSION, 'subagents', 'workflows', WF);
  mkdirSync(dir, { recursive: true });
  const sub = new TranscriptBuilder(SESSION, { agentId: id });
  sub.prompt(10, `${id}-p`, 'do the task');
  sub.assistant(20, `msg_${id}`, model, usage, [text('done')], 'high');
  writeFileSync(join(dir, `agent-${id}.jsonl`), sub.text());
  writeFileSync(
    join(dir, `agent-${id}.meta.json`),
    JSON.stringify({ agentType: 'workflow-subagent', description: label, workflowPhase: 'Build', spawnDepth: 1, requestShape: 'foreground', model: 'sonnet', ...extraMeta }),
  );
}

const journal = (h: Harness, lines: Record<string, unknown>[]) => {
  const dir = join(h.projectDir, SESSION, 'subagents', 'workflows', WF);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'journal.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
};

const wfStatus = (h: Harness, status: string) => {
  const dir = join(h.projectDir, SESSION, 'workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${WF}.json`), JSON.stringify({ runId: WF, status, script: 'never read' }));
};

describe('claude-code adapter: Workflow sub-agents', () => {
  it('sends finished workflow agents as depth-1 runs of the launching turn and re-sends the turn', async () => {
    const h = setup();
    launchTurn(h);
    await h.hook('Stop', at(4));
    expect(h.events.map((e) => e.type)).toEqual(['session_start', 'turn']);
    expect(byType(h.events, 'turn')[0]!.usage).toEqual([u(OPUS, 'xhigh', 2, 20, 0, 0, 0, 2)]);

    // agent 1 returned, agent 2 still running (not in the journal as finished)
    writeWfAgent(h, 'a1aaa', 'impl-api', { in: 100, out: 400 });
    writeWfAgent(h, 'a2bbb', 'impl-ui', { in: 50, out: 200 });
    journal(h, [
      { type: 'launched' },
      { type: 'started', key: 'k1', agentId: 'a1aaa', label: 'impl-api', phase: 'Build' },
      { type: 'started', key: 'k2', agentId: 'a2bbb', label: 'impl-ui', phase: 'Build' },
      { type: 'result', key: 'k1', agentId: 'a1aaa', result: 'text that is never read' },
    ]);
    await h.hook('UserPromptSubmit', at(100), { prompt: 'next thing' });
    const runs = byType(h.events, 'run');
    expect(runs.map((r) => [r.run_id, r.parent_run_id, r.depth, r.agent_type, r.turn_id])).toEqual([['a1aaa', null, 1, 'workflow:impl-api', 'tw']]);
    expect(runs[0]).toMatchObject({ ext: { workflow_id: WF, workflow_phase: 'build', workflow_label: 'impl-api' }, outcome: { status: 'success' } });
    expect(runs[0]!.usage).toEqual([u(SONNET, 'high', 100, 400, 0, 0, 0, 1)]);
    const turns = byType(h.events, 'turn');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.event_id).not.toBe(turns[0]!.event_id);
    expect(turns[1]!.usage).toEqual([u(OPUS, 'xhigh', 2, 20, 0, 0, 0, 2), u(SONNET, 'high', 100, 400, 0, 0, 0, 1)]);

    // agent 2 returns and the workflow ends; a hook with nothing new adds nothing
    journal(h, [
      { type: 'launched' },
      { type: 'result', key: 'k1', agentId: 'a1aaa' },
      { type: 'result', key: 'k2', agentId: 'a2bbb' },
    ]);
    wfStatus(h, 'completed');
    await h.hook('Stop', at(120));
    expect(byType(h.events, 'run').map((r) => r.run_id)).toEqual(['a1aaa', 'a2bbb']);
    const last = byType(h.events, 'turn').at(-1)!;
    expect(last.usage).toEqual([u(OPUS, 'xhigh', 2, 20, 0, 0, 0, 2), u(SONNET, 'high', 150, 600, 0, 0, 0, 2)]);
    const n = h.events.length;
    await h.hook('Stop', at(121));
    expect(h.events).toHaveLength(n);
    assertValid(h.events);
  });

  it('a failed agent is a failed run; a killed workflow flushes its agents; session end sends the rest', async () => {
    const h = setup();
    launchTurn(h);
    await h.hook('Stop', at(4));
    writeWfAgent(h, 'f1ccc', 'flaky', { in: 5, out: 5 });
    journal(h, [{ type: 'started', agentId: 'f1ccc' }, { type: 'failed', agentId: 'f1ccc' }]);
    writeWfAgent(h, 's1ddd', 'stuck', { in: 7, out: 7 }); // no journal entry at all
    await h.hook('Stop', at(30));
    expect(byType(h.events, 'run').map((r) => [r.run_id, r.outcome.status])).toEqual([['f1ccc', 'failed']]);
    wfStatus(h, 'killed');
    await h.hook('Stop', at(60));
    expect(byType(h.events, 'run').map((r) => r.run_id)).toEqual(['f1ccc', 's1ddd']);
    assertValid(h.events);
  });

  it('SessionEnd sends agents of a workflow that never reported', async () => {
    const h = setup();
    launchTurn(h);
    await h.hook('Stop', at(4));
    writeWfAgent(h, 'e1eee', 'late', { in: 9, out: 9 });
    await h.hook('Stop', at(30));
    expect(byType(h.events, 'run')).toHaveLength(0);
    await h.hook('SessionEnd', at(60), { reason: 'other' });
    expect(byType(h.events, 'run').map((r) => r.run_id)).toEqual(['e1eee']);
    assertValid(h.events);
  });

  it('ignores workflow agents of runs this session never launched, and non-wf directories', async () => {
    const h = setup();
    launchTurn(h);
    const dir = join(h.projectDir, SESSION, 'subagents', 'workflows', 'not-a-workflow');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-zzz.jsonl'), '{}\n');
    await h.hook('Stop', at(4));
    await h.hook('SessionEnd', at(60), { reason: 'other' });
    expect(byType(h.events, 'run')).toHaveLength(0);
  });

  it('does not touch workflow-less sessions (3-turn fixture still has its Explore runs only)', async () => {
    const h = setup();
    const fx = threeTurnSession();
    writeFileSync(join(h.projectDir, `${SESSION}.jsonl`), fx.main.text());
    appendFileSync(join(h.projectDir, `${SESSION}.jsonl`), '');
    await h.hook('Stop', at(30));
    expect(byType(h.events, 'run').every((r) => !r.ext)).toBe(true);
  });
});

describe('shared fixture', () => {
  it('uses turn ids that do not collide with the protocol demo batch', () => {
    const demo = JSON.parse(readFileSync(new URL('../../../protocol/fixtures/valid-batch.json', import.meta.url), 'utf8')) as { events: Array<{ turn_id?: string }> };
    const demoIds = new Set(demo.events.flatMap((e) => (e.turn_id ? [e.turn_id] : [])));
    const mine = threeTurnSession().main.lines.flatMap((l) => (l.type === 'user' && typeof l.uuid === 'string' && l.promptId ? [l.uuid as string] : []));
    expect(mine.length).toBe(3);
    for (const id of mine) {
      expect(id.startsWith('cc-fixture-')).toBe(true);
      expect(demoIds.has(id)).toBe(false);
    }
  });
});

describe('claude-code adapter: very large workflows', () => {
  it('more than 500 emitted agents while the workflow is still running: no run is re-sent, no usage double-counted', async () => {
    const h = setup();
    launchTurn(h);
    const n = 520; // above the session-wide 500-id cap
    const ids = Array.from({ length: n }, (_, i) => `ag${String(i).padStart(4, '0')}`);
    for (const id of ids) writeWfAgent(h, id, 'impl', { in: 1, out: 2 });
    journal(h, ids.map((agentId) => ({ type: 'result', agentId })));
    wfStatus(h, 'running');
    await h.hook('Stop', at(30));
    expect(byType(h.events, 'run')).toHaveLength(n);

    // later hooks re-check the open workflow; the oldest ids fell out of the capped session-wide list
    await h.hook('UserPromptSubmit', at(100), { prompt: 'what next' });
    await h.hook('Stop', at(101));
    expect(byType(h.events, 'run')).toHaveLength(n);
    const last = byType(h.events, 'turn').filter((t) => t.turn_id === 'tw').at(-1)!;
    expect(last.usage.find((x) => x.model === SONNET)).toMatchObject({ input: n, output: 2 * n, requests: n });
  });
});
