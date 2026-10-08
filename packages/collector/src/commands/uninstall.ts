import { rmSync } from 'node:fs';
import { ADAPTERS } from '../adapters/index.js';
import { loadConfig } from '../config.js';
import { errorMessage } from '../fsutil.js';
import { gitTopLevel } from '../git.js';
import { loadProjects, loadRouting } from '../projects.js';
import { openStore, parseOptions, summarizeQueue, type CliDeps, type Io } from './common.js';

/**
 * `ai-obs uninstall [--purge [--yes]] [--project-dir d]` — removes our hooks (user scope and the current
 * repo's project scope). --purge also deletes ~/.ai-obs (tokens, assignments, queue, state); it says
 * what it will delete first and needs --yes while kept events (waiting for a token or a working token)
 * exist (design §2.9).
 */
export async function uninstallCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, {
    purge: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'project-dir': { type: 'string' },
  });
  const config = loadConfig(deps.paths);
  const projects = loadProjects(deps.paths);
  const assignments = projects.status === 'ok' ? Object.keys(projects.entries).length : 0;
  let unsent = 0;
  if (values.purge) {
    const view = loadRouting(deps.paths);
    const q = summarizeQueue(openStore(deps.paths).stats(), view);
    unsent = q.stats.events;
    const tokens = config?.tokens.map((t) => t.name).join(', ') || 'none';
    io.out(
      `will delete ${deps.paths.root}: tokens ${tokens}; ${projects.status === 'ok' ? assignments : '?'} project assignments; ${unsent} unsent events (${q.kept} of them waiting for a token or a working token)`,
    );
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
    io.out(`config (${config?.tokens.length ?? 0} tokens), project assignments and queue kept in ${deps.paths.root} (use --purge to delete them)`);
  }
  return failed ? 1 : 0;
}
