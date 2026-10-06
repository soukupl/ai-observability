import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';
import { TEAM_TOKEN_PREFIX, USER_TOKEN_PREFIX } from './protocol-types.js';

/** ~/.ai-obs/config.json (mode 0600). The token lives only here — never in a repo. */
export interface CollectorConfig {
  /** base URL of the ai-obs server, without trailing slash */
  endpoint: string;
  /** ingest token: aiobs_u_… (user) or aiobs_t_… (team) */
  token: string;
  /** random UUID generated at first init; identifies this machine */
  machine_id: string;
  created_at: string;
  /** git user.email captured at init (team-token matching only) */
  git_email?: string;
}

export function isIngestToken(token: string): boolean {
  return (
    (token.startsWith(USER_TOKEN_PREFIX) && token.length > USER_TOKEN_PREFIX.length) ||
    (token.startsWith(TEAM_TOKEN_PREFIX) && token.length > TEAM_TOKEN_PREFIX.length)
  );
}

/** Validates and normalizes an endpoint URL (http/https, no trailing slash, no query). Throws on garbage. */
export function normalizeEndpoint(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`endpoint must be http(s): ${raw}`);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export function maskToken(token: string): string {
  const prefix = token.startsWith(USER_TOKEN_PREFIX) || token.startsWith(TEAM_TOKEN_PREFIX) ? token.slice(0, 8) : '';
  return token.length >= prefix.length + 12 ? `${prefix}…${token.slice(-4)}` : `${prefix}…`;
}

/**
 * Reads the config; null when missing or invalid. AI_OBS_ENDPOINT, when set, overrides the stored
 * endpoint (not persisted).
 */
export function loadConfig(paths: Pick<AiObsPaths, 'config'>, env: NodeJS.ProcessEnv = process.env): CollectorConfig | null {
  const raw = readJsonFile<Partial<CollectorConfig>>(paths.config);
  if (!raw || typeof raw.token !== 'string' || typeof raw.endpoint !== 'string' || typeof raw.machine_id !== 'string') {
    return null;
  }
  const config: CollectorConfig = {
    endpoint: raw.endpoint,
    token: raw.token,
    machine_id: raw.machine_id,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString(),
    ...(typeof raw.git_email === 'string' && raw.git_email ? { git_email: raw.git_email } : {}),
  };
  if (env.AI_OBS_ENDPOINT) {
    try {
      config.endpoint = normalizeEndpoint(env.AI_OBS_ENDPOINT);
    } catch {
      /* ignore an invalid override */
    }
  }
  return config;
}

export function saveConfig(paths: Pick<AiObsPaths, 'config'>, config: CollectorConfig): void {
  writeJsonAtomic(paths.config, config, 0o600);
}

/** New config, keeping the machine_id of an existing one so re-running init does not create a new machine. */
export function buildConfig(input: {
  endpoint: string;
  token: string;
  gitEmail?: string | null;
  existing?: CollectorConfig | null;
  now?: Date;
}): CollectorConfig {
  if (!isIngestToken(input.token)) {
    throw new Error(`token must start with ${USER_TOKEN_PREFIX} or ${TEAM_TOKEN_PREFIX}`);
  }
  return {
    endpoint: normalizeEndpoint(input.endpoint),
    token: input.token,
    machine_id: input.existing?.machine_id ?? randomUUID(),
    created_at: input.existing?.created_at ?? (input.now ?? new Date()).toISOString(),
    ...(input.gitEmail ? { git_email: input.gitEmail } : {}),
  };
}
