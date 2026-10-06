/** companies.settings (jsonb). Keys are camelCase; a CHECK constraint guards the values. */
import type { Plan } from './enums.js';

export const INDIVIDUAL_VISIBILITY_MODES = ['aggregates-only', 'full'] as const;
export type IndividualVisibility = (typeof INDIVIDUAL_VISIBILITY_MODES)[number];

export const PROJECT_NAMING = ['plain', 'hashed'] as const;
export type ProjectNaming = (typeof PROJECT_NAMING)[number];

/** Raw-data retention bounds in days (ADR-0012: 30 days – 24 months; plans may lower the max). */
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 730;

export interface CompanySettings {
  individualVisibility: IndividualVisibility;
  projectNaming: ProjectNaming;
  retentionDays: number;
}

export const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  individualVisibility: 'aggregates-only',
  projectNaming: 'plain',
  retentionDays: 395,
};

/** Placeholder plan limits (BRIEF §10). `null` = unlimited. */
export const PLAN_LIMITS = {
  free: { users: 3, teams: 1, maxRetentionDays: 30, budgets: false, sso: false },
  team: { users: 50, teams: 10, maxRetentionDays: 395, budgets: true, sso: false },
  business: { users: null, teams: null, maxRetentionDays: 730, budgets: true, sso: true },
} as const;

/** Company setting bounded by the plan maximum and the global 30 days – 24 months range (ADR-0012). */
export function effectiveRetentionDays(plan: Plan, settings: { retentionDays?: unknown } | null | undefined): number {
  const configured = Number(settings?.retentionDays);
  const wanted = Number.isFinite(configured) ? Math.floor(configured) : DEFAULT_COMPANY_SETTINGS.retentionDays;
  const planMax = PLAN_LIMITS[plan]?.maxRetentionDays ?? MIN_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.min(wanted, planMax, MAX_RETENTION_DAYS));
}
