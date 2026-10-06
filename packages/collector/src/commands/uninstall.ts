import { rmSync } from 'node:fs';
import { ADAPTERS } from '../adapters/index.js';
import { errorMessage } from '../fsutil.js';
import { gitTopLevel } from '../git.js';
import { EventQueue } from '../queue.js';
import { parseOptions, type CliDeps, type Io } from './common.js';

/**
 * `ai-obs uninstall [--purge] [--project-dir d]` — removes our hooks (user scope and the current
 * repo's project scope). --purge also deletes ~/.ai-obs (config, token, queue, state).
 */
export async function uninstallCommand(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseOptions(args, { purge: { type: 'boolean', default: false }, 'project-dir': { type: 'string' } });
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
    const unsent = new EventQueue(deps.paths.queue).stats().events;
    rmSync(deps.paths.root, { recursive: true, force: true });
    io.out(`✓ removed ${deps.paths.root}${unsent ? ` (${unsent} unsent events discarded)` : ''}`);
  } else {
    io.out(`config and queue kept in ${deps.paths.root} (use --purge to delete them)`);
  }
  return failed ? 1 : 0;
}
