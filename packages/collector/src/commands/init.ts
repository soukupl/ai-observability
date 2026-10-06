import { ADAPTERS } from '../adapters/index.js';
import { hookCommandFactory, isVersionManagedNode } from '../adapters/hook-command.js';
import { buildConfig, loadConfig, maskToken, saveConfig } from '../config.js';
import { errorMessage } from '../fsutil.js';
import { gitEmail, gitTopLevel } from '../git.js';
import { installRuntime, isDefaultHome } from '../runtime.js';
import { checkEndpoint, getCollectorConfig } from '../sender.js';
import { COLLECTOR_VERSION, compareVersions } from '../version.js';
import { parseOptions, UsageError, type CliDeps, type Io } from './common.js';

export const INIT_OPTIONS = {
  token: { type: 'string' },
  endpoint: { type: 'string' },
  project: { type: 'boolean', default: false },
  'project-dir': { type: 'string' },
  harness: { type: 'string' },
  'git-email': { type: 'string' },
} as const;

/** `ai-obs init --token <t> --endpoint <url> [--project] [--project-dir d] [--harness a,b] [--git-email e]` */
export async function initCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, INIT_OPTIONS);
  const env = deps.env ?? process.env;
  const existing = loadConfig(deps.paths, {});
  const token = values.token ?? existing?.token;
  const endpoint = values.endpoint ?? env.AI_OBS_ENDPOINT ?? existing?.endpoint;
  if (!token) throw new UsageError('--token is required (create one in the dashboard: Settings → Tokens)');
  if (!endpoint) throw new UsageError('--endpoint is required (your ai-obs server URL), or set AI_OBS_ENDPOINT');
  const only = values.harness?.split(',').map((s) => s.trim()).filter(Boolean);
  const adapters = (deps.adapters ?? ADAPTERS).filter((a) => !only || only.includes(a.name));
  if (only && !adapters.length) throw new UsageError(`unknown harness: ${values.harness}`);

  const cwd = deps.cwd ?? process.cwd();
  const scope = values.project ? 'project' : 'user';
  const projectDir = values['project-dir'] ?? (values.project ? ((await gitTopLevel(cwd)) ?? cwd) : undefined);

  let config;
  try {
    config = buildConfig({ endpoint, token, gitEmail: values['git-email'] ?? (await gitEmail(cwd)), existing });
  } catch (err) {
    throw new UsageError(errorMessage(err));
  }

  // 1. Endpoint + token, before touching anything.
  const check = await checkEndpoint({ config, transport: deps.transport });
  if (check.tokenValid === false) {
    io.err(`✗ ${config.endpoint} rejected token ${maskToken(config.token)} (HTTP ${check.status}). Nothing was changed.`);
    return 1;
  }
  saveConfig(deps.paths, config);
  io.out(`✓ config written to ${deps.paths.config} (machine ${config.machine_id})`);
  if (check.reachable && check.tokenValid) io.out(`✓ ${config.endpoint} reachable, token accepted`);
  else io.out(`! ${config.endpoint} not reachable now (${check.error ?? `HTTP ${check.status}`}); events will queue locally and send later`);

  // 2. Stable runtime for hooks.
  const runtime = (deps.installRuntime ?? installRuntime)(deps.paths);
  const home = isDefaultHome(deps.paths) ? undefined : deps.paths.root;

  // 3. Harness hooks.
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
        hookCommand: hookCommandFactory({ node: runtime.node, entry: runtime.entry, harness: adapter.name, ...(home ? { home } : {}) }),
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
    if (isVersionManagedNode(runtime.node)) {
      io.out(`! hooks run ${runtime.node}, a version-managed Node (nvm, fnm, Volta, asdf, Homebrew Cellar …): if you remove or upgrade that version the hooks stop working. \`ai-obs doctor\` detects it; run \`ai-obs init\` again then, or init under a stable Node.`);
    }
    if (scope === 'project') {
      io.out(`! project hooks contain absolute paths of this machine (${runtime.node}, ${runtime.entry}). They do not work for teammates or on CI: keep the file out of git (e.g. in .git/info/exclude) or let each teammate run \`ai-obs init --project\`.`);
    }
  }

  // 4. Company settings.
  const cc = await getCollectorConfig({ config, paths: deps.paths, transport: deps.transport }, { force: true });
  io.out(
    cc.source === 'default'
      ? '! project naming unknown until the server is reached; using hashed project keys meanwhile'
      : `✓ project naming: ${cc.value.project_naming}`,
  );
  if (compareVersions(COLLECTOR_VERSION, cc.value.min_collector_version) < 0) {
    io.out(`! this collector (${COLLECTOR_VERSION}) is older than the server minimum ${cc.value.min_collector_version}; update with \`npx ai-obs@latest init\``);
  }
  for (const step of nextSteps) io.out(`→ ${step}`);
  io.out(installed ? 'ai-obs is set up. Usage appears in the dashboard within minutes; check with `ai-obs doctor`.' : 'ai-obs config saved.');
  return 0;
}
