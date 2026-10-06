import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../../src/adapters/codex/index.js';
import { hookCommandFactory } from '../../src/adapters/hook-command.js';
import { aiObsHookPositions, CODEX_HOOK_EVENTS, hooksFeatureDisabled, snakeEvent, readHooksFile, untrustedEvents } from '../../src/adapters/codex/hooks-config.js';
import { cleanupHomes, tmpHome } from '../helpers.js';

afterEach(() => cleanupHomes());

const OTHER = { type: 'command', command: "/bin/sh '/opt/other-tool/hook.sh'" };
const existing = {
  hooks: {
    Stop: [{ hooks: [OTHER] }],
    PreToolUse: [{ matcher: '^Bash$', hooks: [OTHER] }],
  },
  someOtherKey: true,
};

function setup() {
  const paths = tmpHome();
  const home = join(paths.root, '..', 'codex');
  mkdirSync(home, { recursive: true });
  const file = join(home, 'hooks.json');
  writeFileSync(file, JSON.stringify(existing, null, 2));
  const adapter = createCodexAdapter({ home, version: async () => '0.154.0' });
  const hookCommand = hookCommandFactory({ node: '/usr/local/bin/node', entry: '/Users/x/.ai-obs/app/bin/ai-obs.js', harness: 'codex' });
  return { home, file, adapter, hookCommand, projectDir: join(paths.root, '..', 'repo') };
}

describe('codex hooks.json install / uninstall', () => {
  it('appends our handler per event, keeps foreign hooks and keys, and is idempotent', async () => {
    const { file, adapter, hookCommand } = setup();
    await adapter.installHooks({ scope: 'user', hookCommand });
    const once = readFileSync(file, 'utf8');
    const json = JSON.parse(once);
    expect(Object.keys(json.hooks).sort()).toEqual([...CODEX_HOOK_EVENTS, 'PreToolUse'].sort());
    expect(json.someOtherKey).toBe(true);
    expect(json.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    // foreign Stop group stays at index 0 (Codex keys hook trust on indices); ours is appended
    expect(json.hooks.Stop[0]).toEqual({ hooks: [OTHER] });
    expect(json.hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: '/usr/local/bin/node /Users/x/.ai-obs/app/bin/ai-obs.js hook codex Stop' }] });
    expect(json.hooks.SessionEnd[0].hooks[0].timeout).toBe(3);

    await adapter.installHooks({ scope: 'user', hookCommand });
    expect(readFileSync(file, 'utf8')).toBe(once);
    expect((await adapter.detect()).hooksInstalled.user).toBe(true);
  });

  it('re-install with a new node path updates our handler in place (no duplicate)', async () => {
    const { file, adapter, hookCommand } = setup();
    await adapter.installHooks({ scope: 'user', hookCommand });
    const newer = hookCommandFactory({ node: '/opt/node-24/bin/node', entry: '/Users/x/.ai-obs/app/bin/ai-obs.js', harness: 'codex' });
    await adapter.installHooks({ scope: 'user', hookCommand: newer });
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.hooks.Stop).toHaveLength(2);
    expect(json.hooks.Stop[1].hooks[0].command).toContain('/opt/node-24/bin/node');
  });

  it('uninstall removes only our entries, twice is a no-op', async () => {
    const { file, adapter, hookCommand } = setup();
    await adapter.installHooks({ scope: 'user', hookCommand });
    await adapter.uninstallHooks({ scope: 'user' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(existing);
    const after = readFileSync(file, 'utf8');
    await adapter.uninstallHooks({ scope: 'user' });
    expect(readFileSync(file, 'utf8')).toBe(after);
    expect((await adapter.detect()).hooksInstalled.user).toBe(false);
  });

  it('project scope writes <repo>/.codex/hooks.json', async () => {
    const { adapter, hookCommand, projectDir } = setup();
    await adapter.installHooks({ scope: 'project', projectDir, hookCommand });
    const path = join(projectDir, '.codex', 'hooks.json');
    expect(existsSync(path)).toBe(true);
    expect((await adapter.detect({ projectDir })).hooksInstalled).toEqual({ user: false, project: true });
    await adapter.uninstallHooks({ scope: 'project', projectDir });
    expect(readHooksFile(path)).toEqual({ hooks: {} });
  });

  it('refuses to overwrite an unparsable hooks.json', async () => {
    const { file, adapter, hookCommand } = setup();
    writeFileSync(file, '{ not json');
    await expect(adapter.installHooks({ scope: 'user', hookCommand })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });
});

describe('codex hook trust and feature flag (config.toml)', () => {
  it('reports our hooks that Codex has not trusted yet', async () => {
    const { home, file, adapter, hookCommand } = setup();
    await adapter.installHooks({ scope: 'user', hookCommand });
    const toml = [
      'model = "x"',
      `[hooks.state."${file}:stop:0:0"]`,
      'enabled = true',
      'trusted_hash = "sha256:aa"',
      '',
      `[hooks.state."${file}:stop:1:0"]`,
      'enabled = true',
      'trusted_hash = "sha256:bb"',
      '',
      `[hooks.state."${file}:session_start:0:0"]`,
      'enabled = false',
      'trusted_hash = "sha256:cc"',
    ].join('\n');
    const hooks = readHooksFile(file);
    expect(untrustedEvents(toml, file, hooks).sort()).toEqual(['SessionEnd', 'SessionStart', 'SubagentStop', 'UserPromptSubmit']);
    writeFileSync(join(home, 'config.toml'), toml);
    const det = await adapter.detect();
    expect(det).toMatchObject({ installed: true, version: '0.154.0', versionSupported: true });
    expect(det.warnings?.join('\n')).toMatch(/trust pending \(user\).*not trusted 4 ai-obs hook.*\/hooks/);
    expect(det.notes?.join('\n') ?? '').not.toMatch(/are trusted/);

    // once every hook has a trust entry, the warning is replaced by a note
    const trusted = [...aiObsHookPositions(hooks)].map(([e, [g, h]]) => [`[hooks.state."${file}:${snakeEvent(e)}:${g}:${h}"]`, 'enabled = true', 'trusted_hash = "sha256:aa"', ''].join('\n')).join('\n');
    writeFileSync(join(home, 'config.toml'), trusted);
    const ok = await adapter.detect();
    expect(ok.warnings).toBeUndefined();
    expect(ok.notes?.join('\n')).toMatch(/hooks are trusted in Codex \(user\)/);
  });

  it('detects `[features] hooks = false`', () => {
    expect(hooksFeatureDisabled('[features]\njs_repl = false\nhooks = false\n')).toBe(true);
    expect(hooksFeatureDisabled('[features]\nhooks = true\n[other]\nhooks = false\n')).toBe(false);
    expect(hooksFeatureDisabled('features.hooks = false\n')).toBe(true);
  });

  it('old codex versions are flagged as untested', async () => {
    const { home } = setup();
    const det = await createCodexAdapter({ home, version: async () => '0.94.0-alpha.10' }).detect();
    expect(det.versionSupported).toBe(false);
  });
});
