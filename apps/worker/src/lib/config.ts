import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WorkerConfig {
  /** Directory for the rollup watermark and "last ran" marks (WORKER_STATE_DIR). */
  stateDir: string;
  /** Retention runs once per UTC day, at or after this hour (RETENTION_HOUR_UTC, default 3). */
  retentionHourUtc: number;
  appUrl: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
  };
}

const int = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return value && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    stateDir: env.WORKER_STATE_DIR || join(tmpdir(), 'ai-obs-worker'),
    retentionHourUtc: int(env.RETENTION_HOUR_UTC, 3, 0, 23),
    appUrl: (env.APP_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    smtp: {
      host: env.SMTP_HOST || 'localhost',
      port: int(env.SMTP_PORT, 1025, 1, 65535),
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER || undefined,
      password: env.SMTP_PASSWORD || undefined,
      from: env.SMTP_FROM || 'ai-obs <no-reply@localhost>',
    },
  };
}
