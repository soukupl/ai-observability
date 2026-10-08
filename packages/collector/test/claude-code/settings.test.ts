import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommandFactory } from '../../src/adapters/hook-command.js';
import { createClaudeCodeAdapter, extractResultText } from '../../src/adapters/claude-code/index.js';
import { HOOK_EVENTS } from '../../src/adapters/claude-code/settings.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-obs-cc-settings-'));
  dirs.push(d);
  return d;
};

const hookCommand = hookCommandFactory({ node: '/usr/local/bin/node', entry: '/Users/x/.ai-obs/app/bin/ai-obs.js', harness: 'claude-code' });

const USER_SETTINGS = {
  model: 'opus',
  env: { FOO: '1' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard', timeout: 5 }] }],
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }],
  },
};

function setupDir(initial: unknown = USER_SETTINGS) {
  // null = no file
  const claudeDir = tmp();
  const file = join(claudeDir, 'settings.json');
  if (initial !== null) writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 });
  const adapter = createClaudeCodeAdapter({ claudeDir, probe: async () => '2.1.289' });
  return { claudeDir, file, adapter, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

describe('claude-code hooks in settings.json', () => {
  it('installs one entry per event, keeps user config, and is idempotent', async () => {
    const { file, adapter, read } = setupDir();
    await adapter.installHooks({ scope: 'user', hookCommand });
    const once = readFileSync(file, 'utf8');
    await adapter.installHooks({ scope: 'user', hookCommand });
    expect(readFileSync(file, 'utf8')).toBe(once);

    const s = read();
    expect(s.model).toBe('opus');
    expect(s.env).toEqual({ FOO: '1' });
    expect(s.hooks.PreToolUse).toEqual(USER_SETTINGS.hooks.PreToolUse);
    expect(Object.keys(s.hooks).sort()).toEqual([...new Set([...HOOK_EVENTS, 'PreToolUse'])].sort());
    for (const event of HOOK_EVENTS) {
      const ours = s.hooks[event].flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks).filter((h: { command: string }) => h.command.includes('ai-obs'));
      expect(ours).toEqual([
        {
          type: 'command',
          command: `/usr/local/bin/node /Users/x/.ai-obs/app/bin/ai-obs.js hook claude-code ${event}`,
          // only SessionStart (it may print the nudge and run git) gets a 5 s timeout instead of the 60 s default
          ...(event === 'SessionStart' ? { timeout: 5 } : {}),
        },
      ]);
    }
    expect(s.hooks.Stop[0]).toEqual(USER_SETTINGS.hooks.Stop[0]);
    expect(s.hooks.SessionStart[0]).toEqual(USER_SETTINGS.hooks.SessionStart[0]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(`${file}.ai-obs.bak`, 'utf8'))).toEqual(USER_SETTINGS);
  });

  it('re-install with a new command path replaces our entry instead of adding a second one', async () => {
    const { adapter, read } = setupDir();
    await adapter.installHooks({ scope: 'user', hookCommand });
    const moved = hookCommandFactory({ node: '/opt/node/bin/node', entry: '/home/y/.ai-obs/app/bin/ai-obs.js', harness: 'claude-code', home: '/tmp/x y' });
    await adapter.installHooks({ scope: 'user', hookCommand: moved });
    const stop = read().hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command));
    expect(stop).toEqual(['afplay /System/Library/Sounds/Glass.aiff', "/opt/node/bin/node /home/y/.ai-obs/app/bin/ai-obs.js hook claude-code Stop --home '/tmp/x y'"]);
  });

  it('uninstall removes only our entries (twice is fine)', async () => {
    const { file, adapter, read } = setupDir();
    await adapter.installHooks({ scope: 'user', hookCommand });
    await adapter.uninstallHooks({ scope: 'user' });
    expect(read()).toEqual(USER_SETTINGS);
    const after = readFileSync(file, 'utf8');
    await adapter.uninstallHooks({ scope: 'user' });
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('creates a missing file; uninstall then leaves no hooks key', async () => {
    const { file, adapter, read } = setupDir(null);
    await adapter.installHooks({ scope: 'user', hookCommand });
    expect(Object.keys(read().hooks)).toEqual([...HOOK_EVENTS]);
    await adapter.uninstallHooks({ scope: 'user' });
    expect(read()).toEqual({});
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('project scope writes <project>/.claude/settings.json (0644)', async () => {
    const { adapter } = setupDir();
    const projectDir = tmp();
    await adapter.installHooks({ scope: 'project', projectDir, hookCommand });
    const file = join(projectDir, '.claude', 'settings.json');
    expect(statSync(file).mode & 0o777).toBe(0o644);
    const d = await adapter.detect({ projectDir });
    expect(d.hooksInstalled).toEqual({ user: false, project: true });
  });

  it('refuses to touch a settings file it cannot parse', async () => {
    const { file, adapter } = setupDir();
    writeFileSync(file, '{ "hooks": ');
    await expect(adapter.installHooks({ scope: 'user', hookCommand })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": ');
  });
});

describe('claude-code detect', () => {
  it('reports version, support and hook state', async () => {
    const { claudeDir, adapter } = setupDir({ disableAllHooks: true });
    expect(await adapter.detect()).toEqual({
      installed: true,
      version: '2.1.289',
      versionSupported: true,
      hooksInstalled: { user: false, project: null },
      configPath: join(claudeDir, 'settings.json'),
      notes: ['disableAllHooks is set; no hooks run'],
    });
    await adapter.installHooks({ scope: 'user', hookCommand });
    expect((await adapter.detect()).hooksInstalled.user).toBe(true);
  });

  it('old versions are flagged, a missing binary and dir means not installed', async () => {
    const old = createClaudeCodeAdapter({ claudeDir: tmp(), probe: async () => '1.0.80' });
    expect(await old.detect()).toMatchObject({ installed: true, versionSupported: false });
    const none = createClaudeCodeAdapter({ claudeDir: join(tmp(), 'nope'), probe: async () => null });
    expect(await none.detect()).toMatchObject({ installed: false, version: null, versionSupported: null });
  });
});

describe('claude-code summaries', () => {
  it('unwraps the --output-format json envelope', () => {
    expect(extractResultText(JSON.stringify({ type: 'result', is_error: false, result: '{"t1":"x"}' }))).toBe('{"t1":"x"}');
    expect(extractResultText('{"t1": "plain"} trailing')).toBe('{"t1": "plain"} trailing');
    expect(() => extractResultText(JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance too low' }))).toThrow();
  });

  it('summarize() runs the command with the prompt on stdin', async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const { FAKE_SUMMARIZER } = await import('./helpers.js');
    const adapter = createClaudeCodeAdapter({ claudeDir: dir, summaryArgv: FAKE_SUMMARIZER });
    const out = await adapter.summarize([{ turnId: 'T-1', prompt: 'p', tools: ['Edit'], lastAssistantMessage: 'm' }], {} as never);
    expect(out).toEqual(new Map([['T-1', 'Summary 1 (1 tools)']]));
  });
});
