/**
 * Upgrading a 0.2 – 0.4 home to 0.5 (brief appendix E): config.json v2 → v3 (the v2 file kept as
 * config.json.v2), projects.json set aside as projects.json.v2, `o-` / `t-` queue streams converted to `s-`
 * streams. An older copied hook runtime (`<home>/app`) is refreshed first: it would read config v3 as "no
 * token" and drop every hook job. Idempotent; the caller holds worker.lock (the worker at the start of every
 * run, CLI commands). queue/dead/pre-upgrade and the 0.1.x root segments are left as they are.
 */
import { chmodSync, copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfigFile, saveConfig } from './config.js';
import { recordDropped } from './delivery.js';
import { errorMessage } from './fsutil.js';
import { nullLogger, type Logger } from './log.js';
import type { AiObsPaths } from './paths.js';
import { QueueStore } from './queue.js';
import { loadRouting } from './routing.js';
import { installedRuntimeVersion, installRuntime } from './runtime.js';
import { ulid } from './ulid.js';
import { COLLECTOR_VERSION, compareVersions } from './version.js';

/** Whether anything is left to migrate (cheap: one config read, one stat, two directory listings). */
export function needsMigration(paths: AiObsPaths): boolean {
  const loaded = loadConfigFile(paths);
  if (loaded?.migration) return true;
  if (existsSync(paths.legacyProjects)) return true;
  return new QueueStore(paths.queue, { routing: () => null }).hasLegacy();
}

export interface MigrateOptions {
  log?: Logger;
  now?: Date;
  /** copies this collector to `<home>/app` (default installRuntime; tests inject a fake) */
  refreshRuntime?: (paths: AiObsPaths) => unknown;
}

const olderThanThis = (v: string | null): boolean => v !== null && compareVersions(v, COLLECTOR_VERSION) < 0;

/** `path` if free, else `path.<ulid>`. */
const freeName = (path: string, now: Date): string => (existsSync(path) ? `${path}.${ulid(now.getTime())}` : path);

/**
 * Runs the migration and returns one line per change (empty when there was nothing to do). Notes are also
 * logged. Never throws: a step that fails is logged and retried by the next run.
 */
export function migrateHome(paths: AiObsPaths, opts: MigrateOptions = {}): string[] {
  const log = opts.log ?? nullLogger;
  const now = opts.now ?? new Date();
  const notes: string[] = [];
  const loaded = loadConfigFile(paths);
  if (loaded?.migration) {
    // The hooks' runtime must read config v3 before it is written; else it drops every hook job until `init`.
    if (olderThanThis(installedRuntimeVersion(paths))) {
      try {
        (opts.refreshRuntime ?? installRuntime)(paths);
      } catch (err) {
        log.error('migrate: cannot refresh the hook runtime', { error: errorMessage(err) });
      }
      const still = installedRuntimeVersion(paths);
      if (olderThanThis(still)) {
        const note = `~/.ai-obs not migrated yet: the hook runtime in ${paths.app} is ${still} and could not be updated to ${COLLECTOR_VERSION}; run \`ai-obs init\``;
        log.warn(`migrate: ${note}`);
        return [note];
      }
    }
    try {
      const backup = freeName(`${paths.config}.v${loaded.migration.from}`, now);
      copyFileSync(paths.config, backup);
      chmodSync(backup, 0o600);
      saveConfig(paths, loaded.config);
      // per-token caches of 0.2 – 0.4 are named after the token; the 0.5 caches are named after the host
      try {
        for (const f of readdirSync(paths.collectorConfigDir)) rmSync(join(paths.collectorConfigDir, f), { force: true });
      } catch {
        /* no cache dir */
      }
      rmSync(join(paths.state, 'collector-config.json'), { force: true });
      const n = loaded.config.servers.length;
      notes.push(`config.json migrated to version 3: ${n} server${n === 1 ? '' : 's'} (${loaded.config.servers.map((s) => s.endpoint).join(', ') || 'none'})`);
      notes.push(...loaded.migration.notes);
      notes.push(`the old config.json is kept as ${backup} (mode 0600; it holds the old tokens: delete it when you no longer need them)`);
    } catch (err) {
      log.error('migrate: cannot write config.json v3', { error: errorMessage(err) });
      return notes;
    }
  }
  if (existsSync(paths.legacyProjects)) {
    const target = freeName(`${paths.legacyProjects}.v2`, now);
    try {
      renameSync(paths.legacyProjects, target);
      notes.push(`projects.json is no longer used (repositories choose their server in .ai-obs.json): kept as ${target}`);
    } catch (err) {
      log.error('migrate: cannot rename projects.json', { error: errorMessage(err) });
    }
  }
  const config = loaded?.config;
  if (config) {
    const store = new QueueStore(paths.queue, { log, routing: () => loadRouting(paths), dropped: (d) => recordDropped(paths, d) });
    if (store.hasLegacy()) {
      try {
        const m = store.migrateLegacy(config);
        if (m.streams) {
          notes.push(
            `${m.events} queued events in ${m.streams} streams converted${m.unassignedEvents ? `; ${m.unassignedEvents} of them wait for a server (several are registered): run \`ai-obs link\` in their repository` : ''}`,
          );
        }
      } catch (err) {
        log.error('migrate: cannot convert queue streams', { error: errorMessage(err) });
      }
    }
  }
  for (const n of notes) log.info(`migrate: ${n}`);
  return notes;
}
