/**
 * Ingest warnings (brief appendix C): the server could not use a session's dot-file team. The sender keeps
 * the latest warning per project key in state/warnings.json (local only, mode 0600); `status`, `doctor` and
 * the SessionStart nudge show it. A later batch of the same project whose sessions start without a warning
 * clears it.
 */
import { readJsonFile, writeJsonAtomic } from './fsutil.js';
import type { AiObsPaths } from './paths.js';
import { TEAM_SLUG_RE, type IngestWarning, type IngestWarningCode } from './protocol-types.js';

export interface ProjectWarning {
  code: IngestWarningCode;
  team: string;
  endpoint: string;
  session_id: string;
  at: string;
}

/** Plain project key → latest warning. */
export type WarningsFile = Record<string, ProjectWarning>;

const MAX_WARNINGS = 200;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCode = (v: unknown): v is IngestWarningCode => v === 'team_not_member' || v === 'team_unknown';

/** Validates the `warnings` of an ingest response: known codes, team slugs, string session ids. */
export function parseIngestWarnings(v: unknown): IngestWarning[] {
  if (!Array.isArray(v)) return [];
  const out: IngestWarning[] = [];
  for (const w of v.slice(0, 1000)) {
    if (!isObject(w) || !isCode(w.code) || typeof w.team !== 'string' || !TEAM_SLUG_RE.test(w.team) || typeof w.session_id !== 'string') continue;
    out.push({ code: w.code, team: w.team, session_id: w.session_id.slice(0, 200) });
  }
  return out;
}

export function readWarnings(paths: Pick<AiObsPaths, 'warnings'>): WarningsFile {
  const raw = readJsonFile<unknown>(paths.warnings);
  const out = Object.create(null) as WarningsFile;
  if (!isObject(raw)) return out;
  for (const [pk, w] of Object.entries(raw)) {
    if (!isObject(w) || !isCode(w.code) || typeof w.team !== 'string' || !TEAM_SLUG_RE.test(w.team)) continue;
    if (typeof w.endpoint !== 'string' || typeof w.session_id !== 'string' || typeof w.at !== 'string') continue;
    out[pk] = { code: w.code, team: w.team, endpoint: w.endpoint, session_id: w.session_id, at: w.at };
  }
  return out;
}

/**
 * Records the outcome of one accepted batch of project `pk` sent to `endpoint`: the last warning wins; with
 * no warning, sessions that started in this batch clear the project's earlier warning for that server.
 * Never throws.
 */
export function recordBatchWarnings(
  paths: Pick<AiObsPaths, 'warnings'>,
  pk: string,
  endpoint: string,
  warnings: readonly IngestWarning[],
  startedSessions: number,
  now: Date,
): void {
  try {
    const file = readWarnings(paths);
    const last = warnings.at(-1);
    if (last) {
      file[pk] = { code: last.code, team: last.team, endpoint, session_id: last.session_id, at: now.toISOString() };
    } else if (startedSessions > 0 && file[pk]?.endpoint === endpoint) {
      delete file[pk];
    } else {
      return;
    }
    const kept = Object.entries(file)
      .sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0))
      .slice(0, MAX_WARNINGS);
    writeJsonAtomic(paths.warnings, Object.fromEntries(kept), 0o600);
  } catch {
    /* informational */
  }
}

/** The status / doctor sentence for a warning. */
export function warningText(w: Pick<ProjectWarning, 'code' | 'team'>): string {
  return w.code === 'team_not_member'
    ? `the server ignored team "${w.team}" from the dot file: you are not a member of it (your primary team is used, or no team if you have none)`
    : `the server ignored team "${w.team}" from the dot file: no team has that slug (your primary team is used, or no team if you have none)`;
}
