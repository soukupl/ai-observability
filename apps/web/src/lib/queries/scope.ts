import { eq } from 'drizzle-orm';
import { effectiveRetentionDays as clampRetentionDays, modelPrices, type Tx } from '@ai-obs/db';
import { PriceBook, type PriceRow } from '../cost';
import type { Filters } from '../filters';
import type { SourceKind } from './range';

/**
 * Who is asking. `CurrentUser` (lib/auth/session) satisfies this structurally; tests build it by hand.
 */
export interface Viewer {
  id: string;
  /** Deployment role (memberships.role). */
  role: 'admin' | 'member';
  teams: { id: string; role: 'member' | 'lead' }[];
  /** `settings.retentionDays` (on the session user) feeds the raw / rollup source choice. */
  deployment: { settings: { individualVisibility: 'aggregates-only' | 'full'; retentionDays?: number } };
}

/**
 * The deployment's effective raw retention in days: the setting (default 395) bounded by the global
 * 30 days - 24 months range. Same rule as the worker (effectiveRetentionDays in @ai-obs/db, ADR-0012).
 * null when the viewer carries no setting (hand-built viewers in tests).
 */
export function effectiveRetentionDays(v: Viewer): number | null {
  const configured = Number(v.deployment.settings.retentionDays);
  if (!Number.isFinite(configured)) return null;
  return clampRetentionDays(v.deployment.settings);
}

export const isLead = (v: Viewer): boolean => v.teams.some((t) => t.role === 'lead');
const isManager = (v: Viewer): boolean => v.role === 'admin' || isLead(v);

/**
 * May this viewer see WHO did something (user column, user filter, per-user rows)? Only leads and
 * admins in the deployment's "full" mode. Members only ever see their own rows, so there is nobody else
 * to show. In aggregates-only mode nobody sees individuals except themselves (ADR-0008).
 */
export function canSeeUsers(v: Viewer): boolean {
  return v.deployment.settings.individualVisibility === 'full' && isManager(v);
}

/**
 * Leads and admins in aggregates-only mode cannot SELECT other people's rows (RLS), so every read
 * goes through the agg_* SQL functions, which never return user_id. Everyone else reads tables.
 */
export function usesAggregateFunctions(v: Viewer): boolean {
  return v.deployment.settings.individualVisibility === 'aggregates-only' && isManager(v);
}

/** The user filter that may actually be applied for this viewer (null when not allowed). */
export function effectiveUserId(v: Viewer, f: Filters): string | null {
  return canSeeUsers(v) ? f.userId : null;
}

/** Everything one dashboard request needs: the RLS-bound transaction, the viewer and the price book. */
export interface QueryCtx {
  tx: Tx;
  viewer: Viewer;
  prices: PriceBook;
  /** true = read through agg_* functions (no per-user data). */
  agg: boolean;
  now: Date;
  /** Overrides the automatic raw / rollup choice (tests, tooling). */
  forceSource?: SourceKind;
  /** Effective raw retention of the deployment (days); ranges reaching back past it read rollups. */
  retentionDays?: number;
}

/** Loads all model prices once and builds the context. Call once per request. */
export async function createQueryContext(tx: Tx, viewer: Viewer, now: Date = new Date()): Promise<QueryCtx> {
  const rows = await tx.select().from(modelPrices).where(eq(modelPrices.currency, 'USD'));
  const prices: PriceRow[] = rows.map((r) => ({
    model: r.model,
    effectiveFrom: r.effectiveFrom,
    inputPerMtok: Number(r.inputPerMtok),
    outputPerMtok: Number(r.outputPerMtok),
    cacheReadPerMtok: Number(r.cacheReadPerMtok),
    cacheWritePerMtok: Number(r.cacheWritePerMtok),
  }));
  return { tx, viewer, prices: new PriceBook(prices), agg: usesAggregateFunctions(viewer), now, retentionDays: effectiveRetentionDays(viewer) ?? undefined };
}
