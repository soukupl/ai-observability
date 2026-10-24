/** deployment.settings (jsonb). Keys are camelCase; a CHECK constraint guards the values. */

export const INDIVIDUAL_VISIBILITY_MODES = ['aggregates-only', 'full'] as const;
export type IndividualVisibility = (typeof INDIVIDUAL_VISIBILITY_MODES)[number];

export const PROJECT_NAMING = ['plain', 'hashed'] as const;
export type ProjectNaming = (typeof PROJECT_NAMING)[number];

/** Raw-data retention bounds in days (ADR-0012: 30 days – 24 months). Admin-editable, default 395. */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 730;

export interface DeploymentSettings {
  individualVisibility: IndividualVisibility;
  projectNaming: ProjectNaming;
  retentionDays: number;
  /** Runaway alert when one turn's ≈ cost reaches this (USD; docs/briefs/runaway-alerts.md). Default RUNAWAY_DEFAULTS. */
  runawayCostUsd?: number;
  /** Runaway alert when one turn runs this long (hours) with above-normal tokens. Default RUNAWAY_DEFAULTS. */
  runawayHours?: number;
}

/** Runaway thresholds when the deployment has not set its own, and the allowed ranges (CHECK deployment_settings_valid). */
export const RUNAWAY_DEFAULTS = { costUsd: 20, hours: 2 } as const;
export const RUNAWAY_BOUNDS = { costUsd: [1, 100_000], hours: [0.5, 72] } as const;

export const DEFAULT_DEPLOYMENT_SETTINGS: DeploymentSettings = {
  individualVisibility: 'aggregates-only',
  projectNaming: 'plain',
  retentionDays: 395,
};

/** The configured retention, clamped to the global 30 days – 24 months range (ADR-0012); 395 when unset or invalid. */
export function effectiveRetentionDays(settings: { retentionDays?: unknown } | null | undefined): number {
  const configured = Number(settings?.retentionDays);
  const wanted = Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_DEPLOYMENT_SETTINGS.retentionDays;
  return Math.max(MIN_RETENTION_DAYS, Math.min(wanted, MAX_RETENTION_DAYS));
}

/** Team slugs (teams.slug, `.ai-obs.json` "team"): 1–63 of a-z, 0-9 and '-' (ADR-0030). */
export const TEAM_SLUG_RE = /^[a-z0-9-]{1,63}$/;

/**
 * The slug the database derives from a team name (same rule as the SQL function team_slug_base): lower case, every run
 * of other characters becomes '-', no leading / trailing '-', at most 63 characters, 'team' when nothing is left. The
 * database adds '-2', '-3', … when the slug is taken.
 */
export function slugifyTeamName(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return s || 'team';
}
