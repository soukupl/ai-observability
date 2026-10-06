import { appendFileSync, renameSync, statSync } from 'node:fs';
import { ensureDir } from './fsutil.js';
import type { AiObsPaths } from './paths.js';

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const MAX_LOG_BYTES = 1_000_000;

/**
 * File logger for ~/.ai-obs/log/collector.log (rotated to .1 at 1 MB). Never throws: hooks and the
 * worker must not fail because logging failed. Never log prompts, messages, code or file paths.
 */
export function createLogger(paths: Pick<AiObsPaths, 'logDir' | 'logFile'>, scope = 'collector'): Logger {
  const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
    try {
      ensureDir(paths.logDir);
      try {
        if (statSync(paths.logFile).size > MAX_LOG_BYTES) renameSync(paths.logFile, `${paths.logFile}.1`);
      } catch {
        /* no log yet */
      }
      const extra = meta ? ` ${JSON.stringify(meta)}` : '';
      appendFileSync(paths.logFile, `${new Date().toISOString()} ${level} [${scope}#${process.pid}] ${msg}${extra}\n`, {
        mode: 0o600,
      });
    } catch {
      /* logging must never break the caller */
    }
  };
  return {
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}

/** Logger that discards everything (tests). */
export const nullLogger: Logger = { info() {}, warn() {}, error() {} };
