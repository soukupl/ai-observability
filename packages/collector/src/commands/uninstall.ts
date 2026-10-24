import { rmSync } from 'node:fs';
import { ADAPTERS } from '../adapters/index.js';
import { loadConfig } from '../config.js';
import { errorMessage } from '../fsutil.js';
import { gitTopLevel } from '../git.js';
import { loadRouting } from '../routing.js';
import { openStore, parseOptions, summarizeQueue, type CliDeps, type Io } from './common.js';

/**
 * `ai-obs uninstall [--purge [--yes]] [--project-dir d]` — removes our hooks (user scope and the current
 * repo's project scope). --purge also deletes ~/.ai-obs (tokens and queue, with all local state); it says
 * what it will delete first and needs --yes while kept events (waiting for a server or a working token)
 * exist. Repository dot files are not touched.
 */
export async function uninstallCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, {
    purge: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'project-dir': { type: 'string' },
  });
  const config = loadConfig(deps.paths);
  let unsent = 0;
  if (values.purge) {
    const view = loadRouting(deps.paths);
    const q = summarizeQueue(openStore(deps.paths).stats(), view);
    unsent = q.stats.events;
    const servers = config?.servers.map((s) => s.endpoint).join(', ') || 'none';
    io.out(`will delete ${deps.paths.root}: tokens for ${servers}; queue of ${unsent} unsent events (${q.kept} of them waiting for a server or a working token)`);
    if (q.kept > 0 && !values.yes) {
      io.err('✗ add --yes to delete them. Nothing was removed.');
      return 1;
    }
  }

  const projectDir = values['project-dir'] ?? (await gitTopLevel(deps.cwd ?? process.cwd())) ?? undefined;
  let failed = 0;
  for (const adapter of deps.adapters ?? ADAPTERS) {
    try {
      await adapter.uninstallHooks({ scope: 'user' });
      if (projectDir) await adapter.uninstallHooks({ scope: 'project', projectDir });
      io.out(`✓ ${adapter.displayName}: hooks removed`);
    } catch (err) {
      failed++;
      io.err(`✗ ${adapter.displayName}: ${errorMessage(err)}`);
    }
  }
  if (values.purge) {
    rmSync(deps.paths.root, { recursive: true, force: true });
    io.out(`✓ removed ${deps.paths.root}${unsent ? ` (${unsent} unsent events discarded)` : ''}`);
  } else {
    io.out(`tokens (${config?.servers.length ?? 0} servers) and queue kept in ${deps.paths.root} (use --purge to delete them)`);
  }
  return failed ? 1 : 0;
}
