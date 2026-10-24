import { ADAPTERS } from '../adapters/index.js';
import { hookCommandFactory, isVersionManagedNode } from '../adapters/hook-command.js';
import { loadConfig, normalizeEndpoint } from '../config.js';
import { errorMessage } from '../fsutil.js';
import { gitTopLevel } from '../git.js';
import { createLogger } from '../log.js';
import { migrateHome } from '../migrate.js';
import { installRuntime, isDefaultHome, type RuntimeInstall } from '../runtime.js';
import { nowOf, parseOptions, UsageError, withWriteLock, type CliDeps, type Io } from './common.js';
import { checkTokenShape, registerServer, serverOf } from './login.js';

export const INIT_OPTIONS = {
  token: { type: 'string' },
  endpoint: { type: 'string' },
  label: { type: 'string' },
  project: { type: 'boolean', default: false },
  'project-dir': { type: 'string' },
  harness: { type: 'string' },
} as const;

/**
 * `ai-obs init [--token <t> --endpoint <url> [--label <name>]] [--project] [--project-dir d] [--harness a,b]`:
 * machine setup: copies the hook runtime and installs the hooks of every detected harness. With --token it is
 * first the non-interactive form of `ai-obs login --server <url> --token <t>`.
 */
export async function initCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, INIT_OPTIONS);
  const only = values.harness?.split(',').map((s) => s.trim()).filter(Boolean);
  const adapters = (deps.adapters ?? ADAPTERS).filter((a) => !only || only.includes(a.name));
  if (only && !adapters.length) throw new UsageError(`unknown harness: ${values.harness}`);
  if (!values.token && (values.endpoint !== undefined || values.label !== undefined)) {
    throw new UsageError('--endpoint and --label need --token (or run `ai-obs login --server <url>` for the browser login)');
  }

  const cwd = deps.cwd ?? process.cwd();
  const scope = values.project ? 'project' : 'user';
  const projectDir = values['project-dir'] ?? (values.project ? ((await gitTopLevel(cwd)) ?? cwd) : undefined);

  // 1. Token (non-interactive login), then a fresh runtime for the hooks (C25, under the lock).
  if (values.token) {
    const { endpoint: raw } = serverOf(values.endpoint, deps);
    let endpoint: string;
    try {
      endpoint = normalizeEndpoint(raw);
    } catch (err) {
      io.err(`ai-obs: invalid endpoint: ${errorMessage(err)}`);
      return 2;
    }
    if (!checkTokenShape(values.token, io)) return 2;
    const code = await registerServer({ endpoint, token: values.token, source: 'manual', ...(values.label ? { label: values.label } : {}) }, io, deps, { fromInit: true });
    if (code !== 0) return code;
  }
  let runtime: RuntimeInstall | null = null;
  const notes: string[] = [];
  const locked = await withWriteLock(deps, io, () => {
    const refresh = deps.installRuntime ?? installRuntime;
    runtime = refresh(deps.paths); // first: the hooks' runtime must read the config the migration writes
    notes.push(...migrateHome(deps.paths, { log: createLogger(deps.paths, 'cli'), now: new Date(nowOf(deps)), refreshRuntime: refresh }));
  });
  if (!locked) return 1;
  for (const n of notes) io.err(`ai-obs: ${n}`);
  const rt = runtime as RuntimeInstall | null;
  if (!rt) throw new Error('the hook runtime was not installed');
  const home = isDefaultHome(deps.paths) ? undefined : deps.paths.root;
  const config = loadConfig(deps.paths);
  if (!values.token) {
    if (config?.servers.length) io.out(`using the registered servers: ${config.servers.map((s) => s.endpoint).join(', ')}`);
    else io.out('! not logged in to any ai-obs server yet: nothing is recorded until you run `ai-obs login --server <url>`');
  }

  // 2. Harness hooks (re-installed every time, so changes such as the SessionStart timeout reach old installs).
  let installed = 0;
  const nextSteps: string[] = [];
  for (const adapter of adapters) {
    const det = await adapter.detect(projectDir ? { projectDir } : {});
    if (!det.installed) {
      io.out(`– ${adapter.displayName}: not found`);
      continue;
    }
    try {
      await adapter.installHooks({
        scope,
        ...(projectDir ? { projectDir } : {}),
        hookCommand: hookCommandFactory({ node: rt.node, entry: rt.entry, harness: adapter.name, ...(home ? { home } : {}) }),
      });
      installed++;
      const ver = det.version ? ` ${det.version}` : '';
      const warn = det.versionSupported === false ? ' (version not tested — run `ai-obs doctor`)' : '';
      io.out(`✓ ${adapter.displayName}${ver}: hooks installed (${scope === 'project' ? `project ${projectDir}` : 'user'})${warn}`);
      nextSteps.push(...(adapter.nextSteps ?? []).map((s) => `${adapter.displayName}: ${s}`));
    } catch (err) {
      io.err(`✗ ${adapter.displayName}: installing hooks failed: ${errorMessage(err)}`);
    }
  }
  if (!installed) io.out('! no supported harness found (Claude Code, Codex); install one and re-run `ai-obs init`');
  if (installed) {
    // Hooks bake in the absolute path of the node that ran init.
    if (isVersionManagedNode(rt.node)) {
      io.out(`! hooks run ${rt.node}, a version-managed Node (nvm, fnm, Volta, asdf, Homebrew Cellar …): if you remove or upgrade that version the hooks stop working. \`ai-obs doctor\` detects it; run \`ai-obs init\` again then, or init under a stable Node.`);
    }
    if (scope === 'project') {
      io.out(`! project hooks contain absolute paths of this machine (${rt.node}, ${rt.entry}). They do not work for teammates or on CI: keep the file out of git (e.g. in .git/info/exclude) or let each teammate run \`ai-obs init --project\`.`);
    }
  }
  for (const step of nextSteps) io.out(`→ ${step}`);
  if (installed && config?.servers.length) io.out('ai-obs is set up. Usage appears in the dashboard within minutes; check with `ai-obs doctor`.');
  else if (installed) io.out('hooks installed. Run `ai-obs login --server <url>` to start recording.');
  return 0;
}
