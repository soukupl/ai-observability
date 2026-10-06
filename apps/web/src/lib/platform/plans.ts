import { PLAN_LIMITS, type Plan } from '@ai-obs/db';

/**
 * Plan definitions shown by the console (BRIEF §10, no payments). The numbers come from PLAN_LIMITS
 * in @ai-obs/db, the same table the web app (admin/plans.ts) and the worker enforce, so the console
 * cannot drift from what is enforced. Only the display names and the label format live here.
 */
export interface PlanDef {
  id: Plan;
  name: string;
  /** null = unlimited */
  maxUsers: number | null;
  maxTeams: number | null;
  /** Maximum raw-data retention a company on this plan may configure, in days. */
  maxRetentionDays: number;
  retentionLabel: string;
  budgets: boolean;
  sso: boolean;
}

const PLAN_NAMES: Record<Plan, string> = { free: 'Free', team: 'Team', business: 'Business' };

/** 30 -> "30 days", 395 -> "13 months", 730 -> "24 months". */
export function retentionLabel(days: number): string {
  return days <= 60 ? `${days} days` : `${Math.round(days / 30.4)} months`;
}

export const PLANS: readonly PlanDef[] = (Object.keys(PLAN_NAMES) as Plan[]).map((id) => {
  const l = PLAN_LIMITS[id];
  return {
    id,
    name: PLAN_NAMES[id],
    maxUsers: l.users,
    maxTeams: l.teams,
    maxRetentionDays: l.maxRetentionDays,
    retentionLabel: retentionLabel(l.maxRetentionDays),
    budgets: l.budgets,
    sso: l.sso,
  };
});

export const PLAN_IDS: readonly Plan[] = PLANS.map((p) => p.id);

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

export function planDef(id: Plan): PlanDef {
  return PLANS.find((p) => p.id === id)!;
}

/** "3 of 3", "12 of 50", "5 (unlimited)" — plan usage for the companies table. */
export function limitLabel(used: number, max: number | null): string {
  return max === null ? `${used} (unlimited)` : `${used} of ${max}`;
}

export function overLimit(used: number, max: number | null): boolean {
  return max !== null && used > max;
}
