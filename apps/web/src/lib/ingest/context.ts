import { sql, type SQL } from 'drizzle-orm';
import { effectiveRetentionDays, type Database, type Plan, type Tx } from '@ai-obs/db';
import type { ProjectNamingMode, TokenKind } from '@ai-obs/protocol';

export type Attribution = 'verified' | 'matched' | 'unverified';

/**
 * A row of lookup_ingest_token(hash) (packages/db, 0014_company_memberships_tokens.sql). A token belongs to
 * one company and is never bound to a team (ADR-0022): a company token (`aiobs_c_`) matches members by git
 * e-mail, a user token (`aiobs_u_`) is one member of that company.
 */
export interface TokenContext {
  tokenId: string;
  kind: TokenKind;
  companyId: string;
  /** Returned by collector-config; the collector names the token after the slug. */
  company: { name: string; slug: string };
  /** null for company tokens. */
  userId: string | null;
  /** User tokens only (collector-config). */
  userEmail: string | null;
  /** The token user's primary team in this company (from the membership); null for company tokens. */
  userPrimaryTeamId: string | null;
  companyStatus: 'active' | 'suspended';
  projectNaming: ProjectNamingMode;
  /** Plan maximum applied to settings.retentionDays (same rule as the worker's retention pass). */
  retentionDays: number;
}

/** Everything resolved once per batch and shared by its events. */
export interface BatchContext {
  companyId: string;
  token: TokenContext;
  userId: string | null;
  attribution: Attribution;
  /** The attributed user's primary team in this company (second team rule, after the project mapping). */
  primaryTeamId: string | null;
  /** machines.id of the sending machine. */
  machineRowId: string;
  /** projects.id → mapped team (cache for the batch). */
  projectTeams: Map<string, string | null>;
}

/** Runs a query and returns its rows (raw SQL keeps app_ingest's column-level grants explicit). */
export async function rows<T>(db: Tx | Database, query: SQL): Promise<T[]> {
  return [...(await db.execute(query))] as T[];
}

/**
 * Resolves a token hash; null when unknown or revoked, and for a user token whose user is no longer a member
 * of the token's company. Also touches last_used_at (at most once a minute).
 */
export async function lookupToken(db: Database, hash: string): Promise<TokenContext | null> {
  const [row] = await rows<{
    token_id: string;
    kind: TokenKind;
    company_id: string;
    company_name: string;
    company_slug: string;
    user_id: string | null;
    user_email: string | null;
    user_primary_team_id: string | null;
    company_status: 'active' | 'suspended';
    plan: Plan;
    settings: { projectNaming?: string; retentionDays?: unknown } | null;
  }>(db, sql`select * from lookup_ingest_token(${hash})`);
  if (!row) return null;
  return {
    tokenId: row.token_id,
    kind: row.kind,
    companyId: row.company_id,
    company: { name: row.company_name, slug: row.company_slug },
    userId: row.user_id,
    userEmail: row.user_email,
    userPrimaryTeamId: row.user_primary_team_id,
    companyStatus: row.company_status,
    projectNaming: row.settings?.projectNaming === 'hashed' ? 'hashed' : 'plain',
    retentionDays: effectiveRetentionDays(row.plan, row.settings),
  };
}

/**
 * A write that would take over a row owned by another user. Thrown inside the event's savepoint, so
 * the event is rejected alone and is not recorded as seen.
 */
export class OwnerConflictError extends Error {
  constructor(readonly entity: string) {
    super(`${entity} is owned by another user`);
    this.name = 'OwnerConflictError';
  }
}

/**
 * Ownership rule for overwriting existing rows (SEC-3): a row without an owner can be claimed by anyone
 * of the company (an unverified company-token event that is matched to a user later), a row with an owner only by that
 * same user (any token or machine of theirs). An unverified sender (null) never overwrites an owned row.
 */
export function ownerMayWrite(existing: string | null | undefined, sender: string | null): boolean {
  return !existing || existing === sender;
}

export function assertOwner(entity: string, existing: string | null | undefined, sender: string | null): void {
  if (!ownerMayWrite(existing, sender)) throw new OwnerConflictError(entity);
}
