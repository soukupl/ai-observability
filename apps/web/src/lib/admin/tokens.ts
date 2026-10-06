import { and, eq, isNull, sql } from 'drizzle-orm';
import { ingestTokens, teams, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { generateToken } from '../ingest/tokens';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { id, name, parse } from './input';
import { canCreateToken, canRevokeToken } from './permissions';
import { ensure, type Actor, type TokenReveal } from './types';

export interface TokenRow {
  id: string;
  kind: 'user' | 'team';
  name: string;
  prefix: string;
  teamId: string;
  teamName: string;
  userId: string | null;
  /** Token owner (user tokens); the directory is company-readable. */
  userName: string | null;
  createdMs: number;
  lastUsedMs: number | null;
  revokedMs: number | null;
}

/** Tokens the viewer may see (RLS: own user tokens, team tokens of led teams, admins all). Never the hash. */
export async function listTokens(tx: Tx, companyId: string, opts: { onlyUserId?: string } = {}): Promise<TokenRow[]> {
  const list = await rows<{
    id: string; kind: 'user' | 'team'; name: string; prefix: string; team_id: string; team_name: string; user_id: string | null;
    user_name: string | null; created_at: Date | string; last_used_at: Date | string | null; revoked_at: Date | string | null;
  }>(
    tx,
    sql`select k.id, k.kind, k.name, k.prefix, k.team_id, t.name as team_name, k.user_id, coalesce(u.name, u.email) as user_name,
          k.created_at, k.last_used_at, k.revoked_at
        from ingest_tokens k join teams t on t.id = k.team_id left join users u on u.id = k.user_id
        where k.company_id = ${companyId}::uuid ${opts.onlyUserId ? sql`and k.user_id = ${opts.onlyUserId}::uuid` : sql``}
        order by (k.revoked_at is null) desc, k.created_at desc`,
  );
  const ms = (v: Date | string | null) => (v ? new Date(v).getTime() : null);
  return list.map((k) => ({
    id: k.id,
    kind: k.kind,
    name: k.name,
    prefix: k.prefix,
    teamId: k.team_id,
    teamName: k.team_name,
    userId: k.user_id,
    userName: k.user_name,
    createdMs: ms(k.created_at)!,
    lastUsedMs: ms(k.last_used_at),
    revokedMs: ms(k.revoked_at),
  }));
}

/** The one command a developer runs (BRIEF §5.1). */
export function collectorCommand(token: string, endpoint: string): string {
  return `npx ai-obs init --token ${token} --endpoint ${endpoint.replace(/\/+$/, '')}`;
}

/**
 * Settings for an MDM / dotfiles rollout of a team token. The collector generates its machine_id
 * on `init`, so the rollout script runs `install` (or the same values) on each machine.
 */
export function mdmConfig(token: string, endpoint: string, teamName: string): Record<string, string> {
  const ep = endpoint.replace(/\/+$/, '');
  return { endpoint: ep, token, team: teamName, install: collectorCommand(token, ep) };
}

export const tokenInput = z.object({ kind: z.enum(['user', 'team']), teamId: id, name: name(60) });

export interface CreatedToken extends TokenReveal {
  id: string;
  prefix: string;
  teamName: string;
}

/** Creates a token and returns the plaintext once; only its SHA-256 is stored (ADR-0007). */
export async function createToken(tx: Tx, actor: Actor, input: unknown, endpoint: string): Promise<CreatedToken> {
  const t = parse(tokenInput, input);
  ensure(
    canCreateToken(actor, t.kind, t.teamId),
    t.kind === 'team' ? 'Only admins and leads of this team can create team tokens.' : 'You can create user tokens only in your own teams.',
  );
  const [team] = await tx.select({ name: teams.name }).from(teams).where(and(eq(teams.companyId, actor.companyId), eq(teams.id, t.teamId)));
  ensure(team, 'Team not found.');
  const gen = generateToken(t.kind);
  const [row] = await tx
    .insert(ingestTokens)
    .values({
      companyId: actor.companyId,
      teamId: t.teamId,
      userId: t.kind === 'user' ? actor.id : null,
      kind: t.kind,
      name: t.name,
      prefix: gen.prefix,
      hash: gen.hash,
      createdByUserId: actor.id,
    })
    .returning({ id: ingestTokens.id });
  await audit(tx, actor, 'token.create', `token:${row!.id}`, { kind: t.kind, name: t.name, prefix: gen.prefix, teamId: t.teamId });
  const slug = team.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
  return {
    id: row!.id,
    kind: t.kind,
    prefix: gen.prefix,
    teamName: team.name,
    plaintext: gen.plaintext,
    command: collectorCommand(gen.plaintext, endpoint),
    ...(t.kind === 'team'
      ? { mdmJson: JSON.stringify(mdmConfig(gen.plaintext, endpoint, team.name), null, 2) + '\n', mdmFilename: `ai-obs-${slug}.json` }
      : {}),
  };
}

export async function revokeToken(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  const { tokenId } = parse(z.object({ tokenId: id }), input);
  const [tok] = await tx
    .select({ kind: ingestTokens.kind, teamId: ingestTokens.teamId, userId: ingestTokens.userId, name: ingestTokens.name, prefix: ingestTokens.prefix, revokedAt: ingestTokens.revokedAt })
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
  await audit(tx, actor, 'token.revoke', `token:${tokenId}`, { kind: tok.kind, name: tok.name, prefix: tok.prefix, teamId: tok.teamId });
  return `Token "${tok.name}" revoked. Collectors using it stop sending within a minute.`;
}
