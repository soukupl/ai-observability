import { ADAPTERS } from '../adapters/index.js';
import { hookCommandFactory, isVersionManagedNode } from '../adapters/hook-command.js';
import { loadConfig } from '../config.js';
import { errorMessage } from '../fsutil.js';
import { gitEmail, gitTopLevel } from '../git.js';
import { installRuntime, isDefaultHome, type RuntimeInstall } from '../runtime.js';
import { movePreUpgrade, nowOf, parseOptions, upgradeBanner, UsageError, withWriteLock, type CliDeps, type Io } from './common.js';
import { afterRegistration, registerToken, type RegisterInput } from './register.js';

export const INIT_OPTIONS = {
  token: { type: 'string' },
  endpoint: { type: 'string' },
  name: { type: 'string' },
  project: { type: 'boolean', default: false },
  'project-dir': { type: 'string' },
  harness: { type: 'string' },
  'git-email': { type: 'string' },
} as const;

/** Where the endpoint of `init` / `token add` comes from (C10): --endpoint, AI_OBS_ENDPOINT, then the last registration. */
export function endpointOf(flag: string | undefined, deps: CliDeps, configured: string | undefined): Pick<RegisterInput, 'endpoint' | 'endpointSource'> {
  const env = deps.env ?? process.env;
  if (flag) return { endpoint: flag, endpointSource: 'flag' };
  if (env.AI_OBS_ENDPOINT) return { endpoint: env.AI_OBS_ENDPOINT, endpointSource: 'env' };
  if (configured) return { endpoint: configured, endpointSource: 'config' };
  throw new UsageError('--endpoint is required (your ai-obs server URL), or set AI_OBS_ENDPOINT');
}

/**
 * `ai-obs init [--token <t>] [--endpoint <url>] [--name n] [--project] [--project-dir d] [--harness a,b] [--git-email e]`:
 * registers a token (design §2.2) and installs the hooks of every detected harness. Without --token it
 * keeps the registered tokens and only refreshes the runtime and the hooks.
 */
export async function initCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, INIT_OPTIONS);
  const existing = loadConfig(deps.paths);
  const only = values.harness?.split(',').map((s) => s.trim()).filter(Boolean);
  const adapters = (deps.adapters ?? ADAPTERS).filter((a) => !only || only.includes(a.name));
  if (only && !adapters.length) throw new UsageError(`unknown harness: ${values.harness}`);
  if (!values.token && !existing?.tokens.length) {
    const banner = upgradeBanner(existing);
    if (banner) io.err(banner);
    throw new UsageError('--token is required (create one in the dashboard: My tokens or Settings → Tokens)');
  }

  const cwd = deps.cwd ?? process.cwd();
  const scope = values.project ? 'project' : 'user';
  const projectDir = values['project-dir'] ?? (values.project ? ((await gitTopLevel(cwd)) ?? cwd) : undefined);

  // 1. Token (or the registered ones) and a fresh runtime for the hooks (C25, under the lock).
  let runtime: RuntimeInstall | null = null;
  const refreshRuntime = () => {
    runtime = (deps.installRuntime ?? installRuntime)(deps.paths);
  };
  let outcome: Awaited<ReturnType<typeof registerToken>> | null = null;
  if (values.token) {
    const ep = endpointOf(values.endpoint, deps, existing?.endpoint);
    const email = values['git-email'] ?? (await gitEmail(cwd));
    outcome = await registerToken(
      { token: values.token, ...ep, ...(values.name !== undefined ? { name: values.name } : {}), gitEmail: email },
      io,
      { ...deps, refreshRuntime },
    );
    if (!outcome.ok) return outcome.code;
    io.out(`✓ config written to ${deps.paths.config} (machine ${outcome.config.machine_id})`);
  } else {
    if (values.name !== undefined || values.endpoint !== undefined) throw new UsageError('--name and --endpoint need --token');
    io.out(`using the registered tokens: ${existing!.tokens.map((t) => t.name).join(', ')}`);
    const locked = await withWriteLock(deps, io, () => {
      const moved = movePreUpgrade(deps.paths, new Date(nowOf(deps)));
      refreshRuntime();
      return moved;
    });
    if (!locked) return 1;
    if (locked.value) {
      io.out(`! ${locked.value.batches} pre-upgrade batches (${locked.value.events} events) moved to ${deps.paths.deadPreUpgrade}: they are not sent, because every token from before the upgrade was reset`);
    }
  }
  const rt = runtime as RuntimeInstall | null;
  if (!rt) throw new Error('the hook runtime was not installed');
  const home = isDefaultHome(deps.paths) ? undefined : deps.paths.root;

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

  // 3. Company settings per token and the "several tokens" hints.
  if (outcome?.ok) await afterRegistration(outcome, io, deps);
  for (const step of nextSteps) io.out(`→ ${step}`);
  io.out(installed ? 'ai-obs is set up. Usage appears in the dashboard within minutes; check with `ai-obs doctor`.' : 'ai-obs config saved.');
  return 0;
}
