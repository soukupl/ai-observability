import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addSkill,
  applyUsageNaming,
  hashUsageName,
  mergeMcp,
  mergeSkills,
  normalizeMcp,
  normalizeSkills,
  parseMcpTool,
  skillReadBy,
  usageName,
} from '../src/analysis/usage.js';
import { turnEvent } from '../src/events.js';
import type { SkillCounts } from '../src/protocol-types.js';

describe('skill / MCP usage helpers', () => {
  it('splits MCP tool names at the first double underscore after the prefix', () => {
    expect(parseMcpTool('mcp__github__create_pull_request')).toEqual({ server: 'github', tool: 'create_pull_request' });
    expect(parseMcpTool('mcp__claude_ai_Slack__slack_send_message')).toEqual({ server: 'claude_ai_Slack', tool: 'slack_send_message' });
    expect(parseMcpTool('mcp__plugin_x_y__a__b')).toEqual({ server: 'plugin_x_y', tool: 'a__b' });
    expect(parseMcpTool('Bash')).toBeNull();
    expect(parseMcpTool('mcp__only')).toBeNull();
  });

  it('cleans names: no whitespace or control characters, ≤ 128 chars, leading slash of a typed command dropped', () => {
    expect(usageName('  my skill\n')).toBe('my-skill');
    expect(usageName('x'.repeat(200))).toHaveLength(128);
    expect(usageName('   ')).toBeNull();
    const c: SkillCounts = {};
    addSkill(c, '/code-review', 'user');
    addSkill(c, 'code-review', 'model', 2);
    expect(c).toEqual({ 'code-review': { model: 2, user: 1 } });
  });

  it('merges counts, tolerating state written before skills / MCP were tracked', () => {
    expect(mergeSkills(undefined, { a: { model: 1, user: 0 } })).toEqual({ a: { model: 1, user: 0 } });
    expect(mergeMcp({ s: { t: 1 } }, { s: { t: 2, u: 1 } })).toEqual({ s: { t: 3, u: 1 } });
  });

  it('caps wire fields at 100 skills and 50 servers × 100 tools, keeping the most used', () => {
    const skills: SkillCounts = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`s${i}`, { model: i, user: 0 }]));
    const out = normalizeSkills(skills)!;
    expect(Object.keys(out)).toHaveLength(100);
    expect(out.s119).toBeDefined();
    expect(out.s0).toBeUndefined(); // zero uses are dropped
    const mcp = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`srv${i}`, Object.fromEntries(Array.from({ length: 110 }, (_, j) => [`t${j}`, i + 1]))]));
    const m = normalizeMcp(mcp)!;
    expect(Object.keys(m)).toHaveLength(50);
    expect(Object.keys(m.srv59!)).toHaveLength(100);
    expect(normalizeSkills({})).toBeUndefined();
    expect(normalizeMcp({ s: { t: 0 } })).toBeUndefined();
  });

  it('turn events carry skills / mcp only when there are any', () => {
    const base = { harness: 'claude-code', sessionId: 's', turnId: 't', startedAt: 0, endedAt: 1000, model: 'm', effort: null, usage: [], phases: {}, outcome: { status: 'unknown' as const, signals: [], provisional: true } };
    expect(turnEvent(base)).not.toHaveProperty('skills');
    expect(turnEvent(base)).not.toHaveProperty('mcp');
    expect(turnEvent({ ...base, skills: { a: { model: 1, user: 0 } }, mcp: { s: { t: 1 } } })).toMatchObject({ skills: { a: { model: 1, user: 0 } }, mcp: { s: { t: 1 } } });
  });

  it('hashed mode: HMAC with the salt, plain SHA-256 without, namespaced inputs, already-hashed names kept', () => {
    const a = hashUsageName('skill:x', 'salt');
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashUsageName('skill:x', null)).not.toBe(a);
    expect(hashUsageName('skill:x', null)).toBe(`sha256:${createHash('sha256').update('skill:x').digest('hex')}`);
    const turn = turnEvent({
      harness: 'claude-code', sessionId: 's', turnId: 't', startedAt: 0, endedAt: 1, model: 'm', effort: null, usage: [], phases: {},
      outcome: { status: 'unknown', signals: [], provisional: true }, skills: { x: { model: 1, user: 0 } }, mcp: { srv: { tool: 2 } },
    });
    const [plain] = applyUsageNaming([turn], 'plain', 'salt');
    expect(plain).toEqual(turn);
    const [hashed] = applyUsageNaming([turn], 'hashed', 'salt');
    expect(hashed).toMatchObject({ skills: { [a]: { model: 1, user: 0 } }, mcp: { [hashUsageName('mcp:srv', 'salt')]: { [hashUsageName('mcp:srv/tool', 'salt')]: 2 } } });
    expect(applyUsageNaming([hashed!], 'hashed', 'salt')).toEqual([hashed]); // idempotent
  });

  it('recognizes a Codex skill only when a command reads its SKILL.md', () => {
    expect(skillReadBy("cat '/Users/dev/.codex/skills/release-notes/SKILL.md'")).toBe('release-notes');
    expect(skillReadBy('sed -n 1,200p ~/.codex/plugins/cache/x/skills/plugin-creator/SKILL.md')).toBe('plugin-creator');
    expect(skillReadBy('ls skills/x/SKILL.md')).toBeNull();
    expect(skillReadBy('cat README.md')).toBeNull();
  });
});
