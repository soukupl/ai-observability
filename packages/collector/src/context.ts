import type { CollectorContext, HarnessAdapter } from './adapters/types.js';
import { summarizeAndQueue } from './analysis/summaries.js';
import type { CollectorConfig } from './config.js';
import type { Logger } from './log.js';
import { harnessStateDir, type AiObsPaths } from './paths.js';
import { loadPathSecret, resolveProject, type ProjectKeySecrets } from './project-key.js';
import type { ProjectNamingMode, ProjectRef } from './protocol-types.js';
import type { EventQueue } from './queue.js';
import { SessionStateStore } from './state.js';

export interface ContextDeps {
  adapter: HarnessAdapter;
  config: CollectorConfig;
  paths: AiObsPaths;
  queue: Pick<EventQueue, 'enqueue'>;
  log: Logger;
  projectNaming: ProjectNamingMode;
  /** company salt for hashed project keys (cached collector-config `project_salt`), if the server sends one */
  projectSalt?: string | null;
  now?: () => Date;
  /** override project resolution (tests) */
  resolveProject?: (cwd: string, naming: ProjectNamingMode, secrets?: ProjectKeySecrets) => Promise<ProjectRef>;
}

/** Builds the CollectorContext handed to an adapter. */
export function createContext(deps: ContextDeps): CollectorContext {
  const cache = new Map<string, Promise<ProjectRef>>();
  const resolve = deps.resolveProject ?? resolveProject;
  let secrets: ProjectKeySecrets | undefined;
  const ctx: CollectorContext = {
    harness: deps.adapter.name,
    config: deps.config,
    paths: deps.paths,
    queue: deps.queue,
    state: new SessionStateStore(harnessStateDir(deps.paths, deps.adapter.name)),
    log: deps.log,
    projectNaming: deps.projectNaming,
    now: deps.now ?? (() => new Date()),
    projectKey(cwd) {
      let p = cache.get(cwd);
      if (!p) {
        secrets ??= { pathSecret: loadPathSecret(deps.paths.projectSecret), projectSalt: deps.projectSalt ?? null };
        p = resolve(cwd, deps.projectNaming, secrets);
        cache.set(cwd, p);
      }
      return p;
    },
    async summarizeTurns(digests) {
      try {
        await summarizeAndQueue(deps.adapter, digests, ctx);
      } catch (err) {
        deps.log.error('summaries: unexpected failure', { error: String(err) });
      }
    },
  };
  return ctx;
}
