import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashUsageName } from '../../src/analysis/usage.js';
import { cleanupHomes } from '../helpers.js';
import { at, SESSION, TranscriptBuilder, text, toolUse } from './fixture.js';
import { assertValid, byType, setup } from './helpers.js';

afterEach(cleanupHomes);

const OPUS = 'claude-opus-5-5';
const u = { in: 10, out: 5 };

/**
 * Turn 1: the user types `/code-review` (expanded by Claude Code), the model invokes the `ship-check`
 * skill and calls three MCP tools. Turn 2 starts with the built-in `/model` (no expansion), then a prompt.
 */
function skillSession() {
  const b = new TranscriptBuilder();
  b.prompt(0, 't1', '<command-message>code-review</command-message>\n<command-name>/code-review</command-name>\n<command-args>--fix</command-args>');
  b.prompt(0, 't1-exp', 'Base directory for this skill: /home/dev/.claude/skills/code-review\n\n# Review', { isMeta: true });
  b.assistant(2, 'm1', OPUS, u, [toolUse('s1', 'Skill', { skill: 'ship-check' })]);
  b.toolResult(3, 's1', 'Launching skill: ship-check');
  b.prompt(3, 's1-exp', 'Base directory for this skill: /home/dev/.claude/skills/ship-check', { isMeta: true, sourceToolUseID: 's1' });
  b.assistant(4, 'm2', OPUS, u, [toolUse('g1', 'mcp__github__search_code', { q: 'x' }), toolUse('g2', 'mcp__github__search_code', { q: 'y' })]);
  b.toolResult(5, 'g1', '[]');
  b.toolResult(5, 'g2', '[]');
  b.assistant(6, 'm3', OPUS, u, [toolUse('k1', 'mcp__claude_ai_Slack__slack_send_message', { text: 'hi' })]);
  b.toolResult(7, 'k1', 'ok');
  b.assistant(8, 'm4', OPUS, u, [text('done')]);
  b.prompt(20, 't-model', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>');
  b.prompt(20, 't-model-out', '<local-command-stdout>Set model to Opus</local-command-stdout>');
  b.prompt(30, 't2', 'thanks, now add a test');
  b.assistant(32, 'm5', OPUS, u, [text('ok')]);
  return b;
}

async function run(opts: Parameters<typeof setup>[0] = {}) {
  const h = setup(opts);
  writeFileSync(join(h.projectDir, `${SESSION}.jsonl`), skillSession().text());
  await h.hook('SessionStart', at(-1), { source: 'startup' });
  await h.hook('SessionEnd', at(100), { reason: 'prompt_input_exit' });
  assertValid(h.events);
  return byType(h.events, 'turn');
}

describe('claude-code skill and MCP usage', () => {
  it('counts typed and model-invoked skills apart, MCP calls per server and tool, and skips built-in commands', async () => {
    const turns = await run();
    const t1 = turns.find((t) => t.turn_id === 't1')!;
    expect(t1.skills).toEqual({ 'code-review': { model: 0, user: 1 }, 'ship-check': { model: 1, user: 0 } });
    expect(t1.mcp).toEqual({ github: { search_code: 2 }, claude_ai_Slack: { slack_send_message: 1 } });
    expect(t1.tools).toMatchObject({ skill: 1, mcp: 3 });
    // the expansions are not activity: the turn still ends at its last assistant entry
    expect(t1.ended_at).toBe(new Date(at(8)).toISOString());
    expect(turns.map((t) => t.turn_id)).toEqual(['t1', 't2']);
    const t2 = turns.find((t) => t.turn_id === 't2')!;
    expect(t2.skills).toBeUndefined();
    expect(t2.mcp).toBeUndefined();
  });

  it('hashes skill, server and tool names with the company salt in hashed mode', async () => {
    const salt = 'c0ffee';
    const [t1] = await run({ projectNaming: 'hashed', projectSalt: salt });
    expect(Object.keys(t1!.skills!).sort()).toEqual([hashUsageName('skill:code-review', salt), hashUsageName('skill:ship-check', salt)].sort());
    const gh = hashUsageName('mcp:github', salt);
    expect(t1!.mcp![gh]).toEqual({ [hashUsageName('mcp:github/search_code', salt)]: 2 });
    expect(JSON.stringify(t1)).not.toMatch(/code-review|ship-check|github|Slack/);
  });
});
