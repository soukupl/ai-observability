import type { Database } from '@ai-obs/db';
import type { WorkerConfig } from './lib/config.js';
import type { Mailer } from './lib/mailer.js';
import type { StateStore } from './lib/state.js';
import type { Logger } from './scheduler.js';

/** Everything a job needs; injected so tests can pass a test database, a fake clock and a fake mailer. */
export interface WorkerContext {
  /** dbFor('worker') in production. */
  db: Database;
  state: StateStore;
  config: WorkerConfig;
  log: Logger;
  mailer: Mailer;
  now: () => Date;
}
