import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hookCommandFactory, hookRuntimeProblems, isVersionManagedNode, parseShellWords, shellQuote } from '../src/adapters/hook-command.js';
import { pendingSummariesPath } from '../src/analysis/summaries.js';
import { main } from '../src/cli.js';
import { sessionEndEvent } from '../src/events.js';
import { type AiObsPaths } from '../src/paths.js';
import { cleanupHomes, fakeAdapter, okResponder, startServer, tmpHome, writeTestConfig } from './helpers.js';
import { bound, enqueueFor, queueStore } from './queue-helpers.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  cleanupHomes();
});

function capture() {
  const lines: string[] = [];
  return { text: () => lines.join('\n'), io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } };
}
const resolveProjectKey = async () => 'github.com/acme/billing';
const fakeRuntime = (node: string) => (paths: AiObsPaths) => ({ entry: `${paths.app}/bin/ai-obs.js`, node, copied: false });
async function server() {
  const srv = await startServer((req) => okResponder('plain')(req));
  closers.push(srv.close);
  return srv;
}

describe('hook command helpers', () => {
  it('parseShellWords reads what shellQuote writes', () => {
    const argv = ['/opt/node 22/bin/node', "/h/it's/ai-obs.js", 'hook', 'codex', 'Stop'];
    expect(parseShellWords(argv.map(shellQuote).join(' '))).toEqual(argv);
    expect(parseShellWords(`node "a b" 'c'  d\\ e`)).toEqual(['node', 'a b', 'c', 'd e']);
  });

  it('reports a missing node binary or script, ignores bare node and good paths', () => {
    const make = (node: string, entry: string) => hookCommandFactory({ node, entry, harness: 'codex' })('Stop').shell;
    expect(hookRuntimeProblems(make(process.execPath, process.execPath))).toEqual([]);
    expect(hookRuntimeProblems(make('node', '/nope/ai-obs.js'))).toEqual(['collector script /nope/ai-obs.js is missing']);
    const stale = hookRuntimeProblems(make('/gone/.nvm/versions/node/v18.0.0/bin/node', process.execPath));
    expect(stale).toEqual(['node binary /gone/.nvm/versions/node/v18.0.0/bin/node is missing or not executable']);
    expect(hookRuntimeProblems(make(process.argv[1] ?? '/etc/hosts', process.execPath)).join()).toContain('not executable'); // exists, but not executable
  });

  it('recognizes version-managed node installs', () => {
    for (const p of ['/Users/x/.nvm/versions/node/v22.1.0/bin/node', '/Users/x/.volta/tools/image/node/22.1.0/bin/node', '/opt/homebrew/Cellar/node/22.1.0/bin/node', '/Users/x/.fnm/node-versions/v22/installation/bin/node', '/Users/x/.asdf/installs/nodejs/22.1.0/bin/node']) {
      expect(isVersionManagedNode(p), p).toBe(true);
    }
    expect(isVersionManagedNode('/usr/local/bin/node')).toBe(false);
    expect(isVersionManagedNode('/usr/bin/node')).toBe(false);
  });
});

describe('init notes', () => {
  it('prints the adapter next steps, the nvm caveat and the project-scope warning', async () => {
    const srv = await server();
    const paths = tmpHome();
    const codex = fakeAdapter({ name: 'codex', displayName: 'Codex', nextSteps: ['Next step: open Codex and run /hooks to trust the hooks.'] });
    const c = capture();
    const code = await main(['init', '--token', 'aiobs_u_abc', '--endpoint', srv.url, '--project', '--project-dir', '/work/repo'], c.io, {
      paths,
      adapters: [codex],
      installRuntime: fakeRuntime('/Users/x/.nvm/versions/node/v22.1.0/bin/node'),
      env: {},
    });
    expect(code).toBe(0);
    expect(c.text()).toContain('→ Codex: Next step: open Codex and run /hooks');
    expect(c.text()).toMatch(/! hooks run \/Users\/x\/\.nvm\/.*version-managed/);
    expect(c.text()).toMatch(/! project hooks contain absolute paths of this machine/);

    const user = capture();
    await main(['init', '--token', 'aiobs_u_abc', '--endpoint', srv.url], user.io, { paths, adapters: [fakeAdapter()], installRuntime: fakeRuntime('/usr/bin/node'), env: {} });
    expect(user.text()).not.toContain('version-managed');
    expect(user.text()).not.toContain('project hooks contain');
    expect(user.text()).not.toContain('→');
  });
});

describe('doctor: stale runtime', () => {
  it('fails with a hint to run init again when the baked-in node path is gone, passes when it exists', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const stale = fakeAdapter({
      async detect() {
        return { installed: true, version: '2.1.0', versionSupported: true, hooksInstalled: { user: true, project: null } };
      },
      async installedHookCommands() {
        return ["'/gone/.nvm/versions/node/v18.0.0/bin/node' /gone/.ai-obs/app/bin/ai-obs.js hook claude-code Stop", "'/gone/.nvm/versions/node/v18.0.0/bin/node' /gone/.ai-obs/app/bin/ai-obs.js hook claude-code SessionEnd"];
      },
    });
    const c = capture();
    expect(await main(['doctor'], c.io, { paths, adapters: [stale], env: {}, resolveProjectKey })).toBe(1);
    expect(c.text()).toMatch(/✗ Fake Claude hooks point to a stale runtime: node binary \/gone\/.*is missing or not executable.*`ai-obs init` again/);
    expect(c.text().match(/stale runtime: node binary/g)).toHaveLength(1); // deduplicated across events

    const entry = `${paths.root}/entry.js`;
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, '');
    const fine = fakeAdapter({
      async detect() {
        return { installed: true, version: '2.1.0', versionSupported: true, hooksInstalled: { user: true, project: null } };
      },
      async installedHookCommands() {
        return [`${process.execPath} ${entry} hook claude-code Stop`];
      },
    });
    const ok = capture();
    expect(await main(['doctor'], ok.io, { paths, adapters: [fine], env: {}, resolveProjectKey })).toBe(0);
    expect(ok.text()).not.toContain('stale');
  });

  it('shows pending-trust warnings from the adapter without failing', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    const a = fakeAdapter({
      async detect() {
        return { installed: true, version: '0.154.0', versionSupported: true, hooksInstalled: { user: true, project: null }, warnings: ['trust pending (user): run /hooks'] };
      },
    });
    const c = capture();
    expect(await main(['doctor'], c.io, { paths, adapters: [a], env: {}, resolveProjectKey })).toBe(0);
    expect(c.text()).toContain('! Fake Claude: trust pending (user): run /hooks');
  });
});

describe('flush: sweep and pending summaries', () => {
  it('runs every adapter sweep and retries pending summaries before sending', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    mkdirSync(dirname(pendingSummariesPath(paths.state, 'codex')), { recursive: true });
    const key = { kind: 'project', pk: 'github.com/acme/billing', bind: bound('acme', srv.url, 'acme', 'aiobs_u_testtoken') };
    const digest = { turnId: 'tp', sessionId: 's', prompt: 'p', toolNames: [], lastAssistantMessage: 'm', attempts: 1, firstFailedAt: Date.now(), key };
    writeFileSync(pendingSummariesPath(paths.state, 'codex'), JSON.stringify([digest]));
    const swept: string[] = [];
    const summarized: string[][] = [];
    const cc = fakeAdapter({
      async sweepCrashedSessions(ctx) {
        swept.push(ctx.harness);
      },
    });
    const codex = fakeAdapter({
      name: 'codex',
      displayName: 'Codex',
      async sweepCrashedSessions(ctx) {
        swept.push(ctx.harness);
        // the sweep pins the session's stream from its state cwd, like the real adapters
        ctx.queue.enqueue([sessionEndEvent({ harness: 'codex', sessionId: 'idle', reason: 'crashed', at: 0 })], await ctx.streamFor({ pkCwd: '/work/repo' }, Date.now()));
      },
      async summarize(digests) {
        summarized.push(digests.map((d) => d.turnId));
        return new Map([['tp', 'Did a thing']]);
      },
    });
    const c = capture();
    expect(await main(['flush'], c.io, { paths, adapters: [cc, codex], env: {}, resolveProjectKey: async () => 'github.com/acme/billing' })).toBe(0);
    expect(swept).toEqual(['claude-code', 'codex']);
    expect(summarized).toEqual([['tp']]);
    expect(c.text()).toContain('Codex: idle-session sweep queued 1 events');
    expect(c.text()).toContain('Codex: summaries 1 of 1 done, 0 still waiting');
    expect(c.text()).toContain('sent 2 events'); // session_end + turn_summary go out in the same flush
    const types = srv.received.flatMap((r) => ((r.json as { events?: Array<{ type: string }> } | null)?.events ?? []).map((e) => e.type)).sort();
    expect(types).toEqual(['session_end', 'turn_summary']);
    expect(queueStore(paths).stats().events).toBe(0);
  });

  it('a failing sweep does not stop the flush', async () => {
    const srv = await server();
    const paths = tmpHome();
    writeTestConfig(paths, srv.url);
    enqueueFor(queueStore(paths), 'github.com/acme/billing', bound('acme', srv.url, 'acme', 'aiobs_u_testtoken'), [
      sessionEndEvent({ harness: 'codex', sessionId: 's', reason: 'exit', at: 0 }),
    ]);
    const broken = fakeAdapter({
      async sweepCrashedSessions() {
        throw new Error('boom');
      },
    });
    const c = capture();
    expect(await main(['flush'], c.io, { paths, adapters: [broken], env: {} })).toBe(0);
    expect(c.text()).toContain('sent 1 events');
  });
});
