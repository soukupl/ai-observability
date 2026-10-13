import { and, eq, isNull, sql } from 'drizzle-orm';
import { ingestTokens, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { generateToken } from '../ingest/tokens';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { id, name, parse } from './input';
import { canCreateToken, canRevokeToken } from './permissions';
import { ensure, type Actor, type TokenReveal } from './types';

export interface TokenRow {
  id: string;
  kind: 'user' | 'company';
  name: string;
  prefix: string;
  userId: string | null;
  createdByUserId: string | null;
  /** Token owner (user tokens). Null for a user token of a removed member: the page shows "former member". */
  userName: string | null;
  createdMs: number;
  lastUsedMs: number | null;
  revokedMs: number | null;
}

/**
 * Tokens of the company the viewer may see (RLS: admins all, leads company tokens, everyone their own user tokens).
 * Revoked tokens of a removed member stay listed (D2). Never the hash.
 */
export async function listTokens(tx: Tx, companyId: string, opts: { onlyUserId?: string; createdBy?: string } = {}): Promise<TokenRow[]> {
  const list = await rows<{
    id: string; kind: 'user' | 'company'; name: string; prefix: string; user_id: string | null; created_by_user_id: string | null;
    user_name: string | null; created_at: Date | string; last_used_at: Date | string | null; revoked_at: Date | string | null;
  }>(
    tx,
    sql`select k.id, k.kind, k.name, k.prefix, k.user_id, k.created_by_user_id, coalesce(u.name, u.email) as user_name,
          k.created_at, k.last_used_at, k.revoked_at
        from ingest_tokens k left join users u on u.id = k.user_id
        where k.company_id = ${companyId}::uuid
          ${opts.onlyUserId ? sql`and k.user_id = ${opts.onlyUserId}::uuid` : sql``}
          ${opts.createdBy ? sql`and k.created_by_user_id = ${opts.createdBy}::uuid` : sql``}
        order by (k.revoked_at is null) desc, k.created_at desc`,
  );
  const ms = (v: Date | string | null) => (v ? new Date(v).getTime() : null);
  return list.map((k) => ({
    id: k.id,
    kind: k.kind,
    name: k.name,
    prefix: k.prefix,
    userId: k.user_id,
    createdByUserId: k.created_by_user_id,
    userName: k.user_name,
    createdMs: ms(k.created_at)!,
    lastUsedMs: ms(k.last_used_at),
    revokedMs: ms(k.revoked_at),
  }));
}

/** The one command a developer runs (BRIEF §5.1). */
export function collectorCommand(token: string, endpoint: string): string {
  return `npx @soukupl/ai-obs init --token ${token} --endpoint ${endpoint.replace(/\/+$/, '')}`;
}

/**
 * Settings for an MDM / dotfiles rollout of a company token. The collector generates its machine_id
 * on `init`, so the rollout script runs `install` (or the same values) on each machine.
 */
export function mdmConfig(token: string, endpoint: string, company: { slug: string }): Record<string, string> {
  const ep = endpoint.replace(/\/+$/, '');
  return { endpoint: ep, token, company: company.slug, install: collectorCommand(token, ep) };
}

export const tokenInput = z.object({ kind: z.enum(['user', 'company']), name: name(60) });

export interface CreatedToken extends TokenReveal {
  id: string;
  prefix: string;
  companyName: string;
}

/**
 * Creates a token in the active company and returns the plaintext once; only its SHA-256 is stored
 * (ADR-0007). User tokens are always the actor's own; company tokens need an admin or a lead (Q9).
 */
export async function createToken(tx: Tx, actor: Actor, input: unknown, endpoint: string): Promise<CreatedToken> {
  const t = parse(tokenInput, input);
  ensure(canCreateToken(actor, t.kind), 'Only admins and leads can create company tokens.');
  const [company] = await rows<{ name: string; slug: string }>(tx, sql`select name, slug from companies where id = ${actor.companyId}::uuid`);
  ensure(company, 'Company not found.');
  const gen = generateToken(t.kind);
  const [row] = await tx
    .insert(ingestTokens)
    .values({
      companyId: actor.companyId,
      userId: t.kind === 'user' ? actor.id : null,
      kind: t.kind,
      name: t.name,
      prefix: gen.prefix,
      hash: gen.hash,
      createdByUserId: actor.id,
    })
    .returning({ id: ingestTokens.id });
  await audit(tx, actor, 'token.create', `token:${row!.id}`, { kind: t.kind, name: t.name, prefix: gen.prefix });
  return {
    id: row!.id,
    kind: t.kind,
    prefix: gen.prefix,
    companyName: company.name,
    plaintext: gen.plaintext,
    command: collectorCommand(gen.plaintext, endpoint),
    ...(t.kind === 'company'
      ? { mdmJson: JSON.stringify(mdmConfig(gen.plaintext, endpoint, company), null, 2) + '\n', mdmFilename: `ai-obs-${company.slug}.json` }
      : {}),
  };
}

export async function revokeToken(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  const { tokenId } = parse(z.object({ tokenId: id }), input);
  const [tok] = await tx
    .select({ kind: ingestTokens.kind, userId: ingestTokens.userId, name: ingestTokens.name, prefix: ingestTokens.prefix, revokedAt: ingestTokens.revokedAt })
    .from(ingestTokens)
    .where(and(eq(ingestTokens.companyId, actor.companyId), eq(ingestTokens.id, tokenId)));
  ensure(tok, 'Token not found.');
  ensure(canRevokeToken(actor, tok), 'You are not allowed to revoke this token.');
  if (tok.revokedAt) return 'Already revoked.';
  const done = await tx
    .update(ingestTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(ingestTokens.id, tokenId), isNull(ingestTokens.revokedAt)))
    .returning({ id: ingestTokens.id });
  ensure(done.length === 1, 'You are not allowed to revoke this token.');
  await audit(tx, actor, 'token.revoke', `token:${tokenId}`, { kind: tok.kind, name: tok.name, prefix: tok.prefix });
  return `Token "${tok.name}" revoked. Collectors using it stop sending within a minute.`;
}

/**
 * D2/Q9: company tokens whose creator is no longer an admin or a lead of any team in this company are
 * revoked (they are the broader capability: they match any member). User tokens are never touched.
 * Runs under the acting admin's RLS context (every caller is admin-gated; admins may update any token, D6).
 * One `token.revoke` audit entry per token. Returns the number revoked.
 */
export async function revokeStrandedCompanyTokens(tx: Tx, actor: Actor, userId: string, reason: string): Promise<number> {
  const revoked = await rows<{ id: string; name: string; prefix: string }>(
    tx,
    sql`update ingest_tokens k set revoked_at = now()
        where k.company_id = ${actor.companyId}::uuid and k.kind = 'company' and k.created_by_user_id = ${userId}::uuid
          and k.revoked_at is null
          and not exists (select 1 from company_memberships m
                          where m.company_id = k.company_id and m.user_id = ${userId}::uuid and m.company_role = 'admin')
          and not exists (select 1 from team_memberships tm
                          where tm.company_id = k.company_id and tm.user_id = ${userId}::uuid and tm.role = 'lead')
        returning k.id, k.name, k.prefix`,
  );
  for (const k of revoked) {
    await audit(tx, actor, 'token.revoke', `token:${k.id}`, { kind: 'company', name: k.name, prefix: k.prefix, createdBy: userId, reason });
  }
  return revoked.length;
}

/** " N company token(s) they created were revoked." for success messages; '' when none. */
export const strandedMessage = (n: number): string => (n > 0 ? ` ${n} company token${n === 1 ? '' : 's'} they created ${n === 1 ? 'was' : 'were'} revoked.` : '');
