import { MIN_RETENTION_DAYS, PLAN_LIMITS, type Plan } from '@ai-obs/db';

/** Plan limits (BRIEF §10) live in @ai-obs/db (schema/settings.ts); `null` = unlimited. */
export { PLAN_LIMITS };
export type PlanLimits = (typeof PLAN_LIMITS)[Plan];
export type LimitedResource = 'users' | 'teams';

export function planLimits(plan: Plan): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

/** How many more fit (null = unlimited, never negative). */
export function remaining(limit: number | null, used: number): number | null {
  return limit === null ? null : Math.max(0, limit - used);
}

/**
 * Error message when adding `adding` more would exceed the plan, else null.
 * Users count members plus pending invitations, so open invitations cannot overshoot the limit.
 */
export function capacityError(plan: Plan, resource: LimitedResource, used: number, adding = 1): string | null {
  const limit = planLimits(plan)[resource];
  if (limit === null || used + adding <= limit) return null;
  const what = resource === 'users' ? 'users (members + pending invitations)' : 'teams';
  return `The ${plan} plan allows ${limit} ${what}; you have ${used}. Ask the platform admin to change the plan.`;
}

export function retentionBounds(plan: Plan): { min: number; max: number } {
  return { min: MIN_RETENTION_DAYS, max: planLimits(plan).maxRetentionDays };
}

export function retentionError(plan: Plan, days: number): string | null {
  const { min, max } = retentionBounds(plan);
  if (!Number.isInteger(days) || days < min || days > max) return `Retention must be a whole number of days between ${min} and ${max} on the ${plan} plan.`;
  return null;
}

export function budgetsAllowed(plan: Plan): boolean {
  return planLimits(plan).budgets;
}

export const formatLimit = (limit: number | null): string => (limit === null ? 'unlimited' : String(limit));

/**
 * Usage that exceeds a plan's limits (e.g. after a downgrade), as human-readable lines; [] when within.
 * Policy: existing over-limit usage is grandfathered, nothing is deleted or blocked. Only new
 * growth is refused (invitations and teams are checked on creation), retention is clamped by the
 * worker, and budgets can only be removed. The admin overview shows these lines; the platform
 * console reuses this to warn before a downgrade.
 */
export function planOverages(
  plan: Plan,
  usage: { users: number; pendingInvitations?: number; teams: number; retentionDays?: number },
): string[] {
  const limits = planLimits(plan);
  const out: string[] = [];
  const seats = usage.users + (usage.pendingInvitations ?? 0);
  if (limits.users !== null && seats > limits.users) out.push(`${seats} users (members + pending invitations) exceed the ${plan} limit of ${limits.users}`);
  if (limits.teams !== null && usage.teams > limits.teams) out.push(`${usage.teams} teams exceed the ${plan} limit of ${limits.teams}`);
  if (usage.retentionDays !== undefined && usage.retentionDays > limits.maxRetentionDays) {
    out.push(`retention of ${usage.retentionDays} days exceeds the ${plan} maximum of ${limits.maxRetentionDays}`);
  }
  return out;
}
