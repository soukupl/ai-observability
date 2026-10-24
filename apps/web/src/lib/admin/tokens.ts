import { and, eq, isNull, sql } from 'drizzle-orm';
import { ingestTokens, type TokenSource, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { generateToken } from '../ingest/tokens';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { id, name, parse } from './input';
import { canCreateTokenFor, canRevokeToken } from './permissions';
import { AdminError, ensure, type Actor, type TokenReveal } from './types';

export interface TokenRow {
  id: string;
  name: string;
  /** `device` = minted by an approved `ai-obs login`; `manual` = created in the dashboard (ADR-0029). */
  source: TokenSource;
  /** The client name of a device login (the machine's hostname); null for most manual tokens. */
  label: string | null;
  prefix: string;
  userId: string;
  /** Null when the owner is no longer a member (their tokens are revoked): the page shows "former member". */
  userName: string | null;
  userKind: 'person' | 'service' | null;
  createdByUserId: string | null;
  createdMs: number;
  /** Null = no expiry (manual tokens created with "none"). */
  expiresMs: number | null;
  lastUsedMs: number | null;
  revokedMs: number | null;
}

/**
 * Tokens the viewer may see (RLS: everyone their own, admins every token of every user, service users included).
 * `onlyUserId` narrows to one owner. Revoked tokens stay listed (D2). Never the hash.
 */
export async function listTokens(tx: Tx, opts: { onlyUserId?: string } = {}): Promise<TokenRow[]> {
  const list = await rows<{
    id: string; name: string; source: TokenSource; label: string | null; prefix: string; user_id: string; created_by_user_id: string | null;
    user_name: string | null; user_kind: 'person' | 'service' | null; created_at: Date | string; expires_at: Date | string | null;
    last_used_at: Date | string | null; revoked_at: Date | string | null;
  }>(
    tx,
    sql`select k.id, k.name, k.source, k.label, k.prefix, k.user_id, k.created_by_user_id, coalesce(u.name, u.email) as user_name, u.kind as user_kind,
          k.created_at, k.expires_at, k.last_used_at, k.revoked_at
        from ingest_tokens k left join users u on u.id = k.user_id
        ${opts.onlyUserId ? sql`where k.user_id = ${opts.onlyUserId}::uuid` : sql``}
        order by (k.revoked_at is null and (k.expires_at is null or k.expires_at > now())) desc, k.created_at desc`,
  );
  const ms = (v: Date | string | null) => (v ? new Date(v).getTime() : null);
  return list.map((k) => ({
    id: k.id,
    name: k.name,
    source: k.source,
    label: k.label,
    prefix: k.prefix,
    userId: k.user_id,
    userName: k.user_name,
    userKind: k.user_kind,
    createdByUserId: k.created_by_user_id,
    createdMs: ms(k.created_at)!,
    expiresMs: ms(k.expires_at),
    lastUsedMs: ms(k.last_used_at),
    revokedMs: ms(k.revoked_at),
  }));
}

/** The collector nudges 14 days before expiry (ADR-0029 T6); the dashboard marks the same window. */
export const EXPIRY_WARNING_DAYS = 14;

export type TokenState = 'active' | 'expiring' | 'expired' | 'revoked';

/** Pure: what the token table shows for a token at `nowMs`. */
export function tokenState(t: Pick<TokenRow, 'revokedMs' | 'expiresMs'>, nowMs = Date.now()): TokenState {
  if (t.revokedMs) return 'revoked';
  if (t.expiresMs === null) return 'active';
  if (t.expiresMs <= nowMs) return 'expired';
  return t.expiresMs - nowMs <= EXPIRY_WARNING_DAYS * 86_400_000 ? 'expiring' : 'active';
}

/** Lifetimes offered for a manual token (Q6): 30, 90 (default), 365 days or none. */
export const TOKEN_LIFETIMES = ['30', '90', '365', 'none'] as const;
export type TokenLifetime = (typeof TOKEN_LIFETIMES)[number];
export const DEFAULT_TOKEN_LIFETIME: TokenLifetime = '90';

/** Pure: the expiry of a token created at `now` with `lifetime`; null for "none". */
export function expiresAtFor(lifetime: TokenLifetime, now = new Date()): Date | null {
  return lifetime === 'none' ? null : new Date(now.getTime() + Number(lifetime) * 86_400_000);
}

/**
 * The one command a developer runs with a pasted token: `ai-obs login` stores it for this server (mode 0600). The
 * interactive way is `ai-obs login --server <url>` and approving the code on /device.
 */
export function collectorCommand(token: string, endpoint: string): string {
  return `npx @soukupl/ai-obs login --server ${endpoint.replace(/\/+$/, '')} --token ${token}`;
}

const lifetime = z.enum(TOKEN_LIFETIMES, { message: 'choose 30, 90, 365 days or none' }).default(DEFAULT_TOKEN_LIFETIME);
export const ownTokenInput = z.object({ name: name(60), lifetime });
export const serviceTokenInput = z.object({ userId: id, name: name(60), lifetime });

export interface CreatedToken extends TokenReveal {
  id: string;
  prefix: string;
}

async function insertToken(tx: Tx, actor: Actor, owner: { id: string; kind: 'person' | 'service' }, t: { name: string; lifetime: TokenLifetime }, endpoint: string): Promise<CreatedToken> {
  ensure(canCreateTokenFor(actor, owner), 'Admins create tokens only for service users; people create their own.');
  const gen = generateToken();
  const expiresAt = expiresAtFor(t.lifetime);
  const [row] = await tx
    .insert(ingestTokens)
    .values({ userId: owner.id, name: t.name, source: 'manual', prefix: gen.prefix, hash: gen.hash, createdByUserId: actor.id, expiresAt })
    .returning({ id: ingestTokens.id });
  await audit(tx, actor, 'token.create', `token:${row!.id}`, {
    source: 'manual',
    name: t.name,
    prefix: gen.prefix,
    userId: owner.id,
    userKind: owner.kind,
    lifetime: t.lifetime,
  });
  return { id: row!.id, prefix: gen.prefix, plaintext: gen.plaintext, command: collectorCommand(gen.plaintext, endpoint), expiresAt: expiresAt?.toISOString() ?? null };
}

/** A manual token for the signed-in user ("My tokens"). The plaintext is returned once; only its SHA-256 is stored. */
export async function createOwnToken(tx: Tx, actor: Actor, input: unknown, endpoint: string): Promise<CreatedToken> {
  const t = parse(ownTokenInput, input);
  return insertToken(tx, actor, { id: actor.id, kind: 'person' }, t, endpoint);
}

/** A token for a service user (admins only, ADR-0029 T7/T8). */
export async function createServiceToken(tx: Tx, actor: Actor, input: unknown, endpoint: string): Promise<CreatedToken> {
  const t = parse(serviceTokenInput, input);
  const [owner] = await rows<{ id: string; kind: 'person' | 'service' }>(
    tx,
    sql`select u.id, u.kind from users u join memberships m on m.user_id = u.id where u.id = ${t.userId}::uuid`,
  );
  if (!owner) throw new AdminError('Service user not found.');
  ensure(owner.kind === 'service', 'Admins create tokens only for service users.');
  return insertToken(tx, actor, owner, t, endpoint);
}

export async function revokeToken(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  const { tokenId } = parse(z.object({ tokenId: id }), input);
  const [tok] = await tx
    .select({ userId: ingestTokens.userId, name: ingestTokens.name, prefix: ingestTokens.prefix, source: ingestTokens.source, revokedAt: ingestTokens.revokedAt })
    .from(ingestTokens)
    .where(eq(ingestTokens.id, tokenId));
  ensure(tok, 'Token not found.');
  ensure(canRevokeToken(actor, tok), 'You are not allowed to revoke this token.');
  if (tok.revokedAt) return 'Already revoked.';
  const done = await tx
    .update(ingestTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(ingestTokens.id, tokenId), isNull(ingestTokens.revokedAt)))
    .returning({ id: ingestTokens.id });
  ensure(done.length === 1, 'You are not allowed to revoke this token.');
  await audit(tx, actor, 'token.revoke', `token:${tokenId}`, { name: tok.name, prefix: tok.prefix, source: tok.source, userId: tok.userId });
  return `Token "${tok.name}" revoked. Collectors using it stop sending within a minute.`;
}
