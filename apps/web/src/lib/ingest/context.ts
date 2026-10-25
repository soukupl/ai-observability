import { sql, type SQL } from 'drizzle-orm';
import { effectiveRetentionDays, type Database, type DeploymentSettings, type Tx } from '@ai-obs/db';
import type { ProjectNamingMode, TokenSource, UserKind } from '@ai-obs/protocol';

/**
 * Attribution of new rows. Always `verified` since every token belongs to one user (ADR-0029); `matched` and
 * `unverified` only survive on old rows (git-e-mail matching is gone).
 */
export type Attribution = 'verified';

/**
 * A row of lookup_ingest_token(hash) (packages/db, 0018_single_deployment.sql). Every token belongs to one user (a
 * person or an admin-created service user) of the one deployment (ADR-0028, ADR-0029); it resolves only while it is
 * not revoked, not expired and its user holds a membership.
 */
export interface TokenContext {
  tokenId: string;
  userId: string;
  /** null for a service user. */
  userEmail: string | null;
  userName: string | null;
  userKind: UserKind;
  /** The user's primary team (memberships.primary_team_id); third step of team resolution (ADR-0030). */
  primaryTeamId: string | null;
  deployment: { name: string; slug: string };
  token: { expiresAt: Date | null; label: string | null; source: TokenSource };
  projectNaming: ProjectNamingMode;
  /** The deployment's project salt (SEC-11); collector-config hands it out. */
  projectSalt: string | null;
  /** settings.retentionDays clamped to 30–730 (same rule as the worker's retention pass). */
  retentionDays: number;
}

/** Everything resolved once per batch and shared by its events. */
export interface BatchContext {
  token: TokenContext;
  /** The token's user: every row this batch writes belongs to them. */
  userId: string;
  attribution: Attribution;
  /** The user's primary team (team resolution step 2; also the team of rows created before their session_start). */
  primaryTeamId: string | null;
  /** machines.id of the sending machine. */
  machineRowId: string;
}

/** Runs a query and returns its rows (raw SQL keeps app_ingest's column-level grants explicit). */
export async function rows<T>(db: Tx | Database, query: SQL): Promise<T[]> {
  return [...(await db.execute(query))] as T[];
}

const toDate = (v: Date | string | null): Date | null => (v === null ? null : v instanceof Date ? v : new Date(v));

/**
 * Resolves a token hash; null when unknown, revoked or expired, or when its user no longer holds a membership. Also
 * touches last_used_at (at most once a minute).
 */
export async function lookupToken(db: Database, hash: string): Promise<TokenContext | null> {
  const [row] = await rows<{
    token_id: string;
    user_id: string;
    user_email: string | null;
    user_name: string | null;
    user_kind: UserKind;
    primary_team_id: string | null;
    settings: Partial<DeploymentSettings> | null;
    project_salt: string | null;
    expires_at: Date | string | null;
    token_label: string | null;
    token_source: TokenSource;
    deployment_name: string;
    deployment_slug: string;
  }>(db, sql`select * from lookup_ingest_token(${hash})`);
  if (!row) return null;
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    userKind: row.user_kind,
    primaryTeamId: row.primary_team_id,
    deployment: { name: row.deployment_name, slug: row.deployment_slug },
    token: { expiresAt: toDate(row.expires_at), label: row.token_label, source: row.token_source },
    projectNaming: row.settings?.projectNaming === 'hashed' ? 'hashed' : 'plain',
    projectSalt: row.project_salt,
    retentionDays: effectiveRetentionDays(row.settings ?? {}),
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
 * Ownership rule for overwriting existing rows (SEC-3): a row without an owner (an old company-token row from before
 * ADR-0029) can be claimed by any token user, a row with an owner only by that same user (any token or machine of
 * theirs). The ingest policies enforce the same rule (`WITH CHECK user_id = app_user()`).
 */
export function ownerMayWrite(existing: string | null | undefined, sender: string | null): boolean {
  return !existing || existing === sender;
}

export function assertOwner(entity: string, existing: string | null | undefined, sender: string | null): void {
  if (!ownerMayWrite(existing, sender)) throw new OwnerConflictError(entity);
}
