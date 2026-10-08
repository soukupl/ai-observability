import { sql } from 'drizzle-orm';
import { createDb, type Database } from '@ai-obs/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MailMessage } from '../../src/lib/mail';
import { withRlsContext } from '@ai-obs/db';
import {
  acceptInvitationForSession,
  acceptPendingInvitation,
  completeSignup,
  endSession,
  listPendingInvitations,
  loadSessionUser,
  requestMagicLink,
  resolveIdentity,
  switchActiveCompany,
  verifyMagicLink,
  type AuthDeps,
  type LoginResult,
} from '../../src/lib/auth/login';
import { hashToken, newToken, signPayload } from '../../src/lib/auth/tokens';
import { NextRequest } from 'next/server';
import { magicLinkGet, magicLinkPost } from '../../src/app/api/auth/magic/[token]/handlers';
import { signupPost } from '../../src/app/api/auth/signup/handlers';

/**
 * Magic-link flow end to end against a real Postgres in its own database (ai_obs_auth_test, dropped
 * afterwards): request → fake mailer → verify (single use) → provisioning → session → current user,
 * plus one login in several companies: invitations for existing accounts, the company switcher, the
 * last active company and removal (ADR-0022).
 */
const testUrl = new URL(process.env.TEST_DATABASE_URL || 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs_test');
testUrl.pathname = '/ai_obs_auth_test';
vi.stubEnv('TEST_DATABASE_URL', testUrl.toString());
const harness = await import('../../../../packages/db/test/db-harness');
const skipReason = await harness.prepareTestDatabase();
if (skipReason) console.warn(`[web] auth flow tests skipped: ${skipReason}`);

const SUPER = 'root@platform.example';

describe.skipIf(skipReason !== null)(skipReason ? `auth flow — SKIPPED: ${skipReason}` : 'auth flow (real Postgres)', () => {
  let owner: Database;
  let deps: AuthDeps;
  const outbox: MailMessage[] = [];
  let beta: { companyId: string; teamId: string; bossId: string };

  beforeAll(async () => {
    owner = harness.connectOwner();
    deps = {
      web: harness.connectAs('web'),
      platform: harness.connectAs('platform'),
      mailer: { send: async (m) => void outbox.push(m) },
      env: { APP_URL: 'http://localhost:3000', SESSION_SECRET: 'test-secret-0123456789', SUPER_ADMIN_EMAILS: SUPER },
    };
    beta = await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      const [c] = (await tx.execute(sql`insert into companies (name, slug, plan) values ('Beta', 'beta', 'team') returning id`)) as unknown as { id: string }[];
      const [t] = (await tx.execute(sql`insert into teams (company_id, name) values (${c!.id}, 'Core') returning id`)) as unknown as { id: string }[];
      const [boss] = (await tx.execute(sql`insert into users (email, name) values ('boss@beta.example', 'Boss') returning id`)) as unknown as {
        id: string;
      }[];
      await tx.execute(sql`insert into company_memberships (company_id, user_id, company_role) values (${c!.id}, ${boss!.id}, 'admin')`);
      await tx.execute(sql`insert into invitations (company_id, email, team_id, team_role, invited_by_user_id, expires_at)
        values (${c!.id}, 'invitee@beta.example', ${t!.id}, 'lead', ${boss!.id}, now() + interval '7 days')`);
      return { companyId: c!.id, teamId: t!.id, bossId: boss!.id };
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await harness.closeAll();
    const admin = new URL(testUrl);
    admin.pathname = '/postgres';
    const { db, close } = createDb({ url: admin.toString(), max: 1 });
    await db.execute(sql.raw('drop database if exists "ai_obs_auth_test" with (force)')).catch(() => {});
    await close();
  });

  /** Request a link, read it from the fake mailbox, verify it, resolve the identity. */
  async function loginByMagicLink(email: string, next: string | null = null, ip = '203.0.113.7') {
    const sent = await requestMagicLink(deps, { email, ip, next });
    expect(sent).toEqual({ ok: true });
    const mail = outbox.at(-1)!;
    expect(mail.to).toBe(email.toLowerCase());
    const link = new URL(mail.text.match(/http\S+/)![0]);
    expect(link.origin).toBe('http://localhost:3000');
    const token = link.pathname.split('/').at(-1)!;
    const identity = await verifyMagicLink(deps, token);
    expect(identity?.email).toBe(email.toLowerCase());
    expect(await verifyMagicLink(deps, token)).toBeNull(); // single use
    return { link, result: await resolveIdentity(deps, identity!) };
  }

  const sessionOf = (r: LoginResult) => {
    if (r.kind !== 'session') throw new Error(`expected a session, got ${JSON.stringify(r)}`);
    return r;
  };
  const audit = async (action: string) =>
    (await owner.execute(sql`select company_id, actor_user_id, meta from audit_log where action = ${action}`)) as unknown as Array<{
      company_id: string | null;
      actor_user_id: string;
      meta: Record<string, string>;
    }>;

  it('stores only token hashes', async () => {
    await requestMagicLink(deps, { email: 'hash@check.example', ip: null, next: null });
    const token = outbox.at(-1)!.text.match(/magic\/([\w-]{43})/)![1]!;
    const rows = (await owner.execute(sql`select token_hash, expires_at - now() as ttl from magic_links where email = 'hash@check.example'`)) as unknown as Array<{ token_hash: string; ttl: string }>;
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(rows[0]!.ttl).toMatch(/^00:1[45]:/);
  });

  it('rejects unknown, malformed and expired links', async () => {
    expect(await verifyMagicLink(deps, newToken())).toBeNull();
    expect(await verifyMagicLink(deps, "x' or 1=1 --")).toBeNull();
    const token = newToken();
    await deps.web.execute(sql`insert into magic_links (email, token_hash, expires_at) values ('late@x.example', ${hashToken(token)}, now() - interval '1 minute')`);
    expect(await verifyMagicLink(deps, token)).toBeNull();
    expect(await requestMagicLink(deps, { email: 'nope', ip: null, next: null })).toEqual({ ok: false, error: 'invalid_email' });
  });

  const userCount = async (email: string) =>
    ((await owner.execute(sql`select count(*)::int as n from users where email = ${email}`)) as unknown as Array<{ n: number }>)[0]!.n;

  it('a pending invitation is offered, never auto-accepted; joining it lands in its company and team', async () => {
    const { link, result } = await loginByMagicLink('Invitee@Beta.example', '/turns');
    expect(link.searchParams.get('next')).toBe('/turns');
    if (result.kind !== 'signup') throw new Error(`expected the sign-up step, got ${result.kind}`);
    expect(await userCount('invitee@beta.example')).toBe(0); // nothing joined yet
    const invites = await listPendingInvitations(deps, 'invitee@beta.example');
    expect(invites).toEqual([
      expect.objectContaining({
        companyName: 'Beta',
        teamName: 'Core',
        teamRole: 'lead',
        companyRole: 'member',
        invitedByName: 'Boss',
        invitedByEmail: 'boss@beta.example',
      }),
    ]);
    const s = sessionOf(await acceptPendingInvitation(deps, result.pending, invites[0]!.invitationId));
    expect(s.landing).toBe('/overview');
    const me = await loadSessionUser(deps, s.token);
    expect(me?.user).toMatchObject({ email: 'invitee@beta.example', companyId: beta.companyId, companyRole: 'member' });
    expect(me?.context?.teams).toEqual([{ id: beta.teamId, name: 'Core', role: 'lead' }]);
    expect(me?.context?.primaryTeamId).toBe(beta.teamId);
    expect(me?.context?.company).toMatchObject({ name: 'Beta', plan: 'team' });
    expect(me?.memberships).toEqual([{ companyId: beta.companyId, name: 'Beta', slug: 'beta', role: 'member', plan: 'team' }]);
    expect((await audit('auth.invitation_accepted')).length).toBe(1);
    const logins = await audit('auth.login');
    expect(logins.at(-1)).toMatchObject({ company_id: beta.companyId, meta: { method: 'magic' } });
    expect(await listPendingInvitations(deps, 'invitee@beta.example')).toEqual([]);
  });

  it('SEC-1: a newer invitation from a look-alike company cannot capture the first login', async () => {
    const victim = 'victim@beta.example';
    const ids = await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      // The real company invites first; a solo "Beta" (attacker) invites the same address a minute later.
      const [real] = (await tx.execute(sql`insert into invitations (company_id, email, team_id, invited_by_user_id, expires_at, created_at)
        values (${beta.companyId}, ${victim}, ${beta.teamId}, ${beta.bossId}, now() + interval '7 days', now() - interval '1 minute') returning id`)) as unknown as { id: string }[];
      const [c] = (await tx.execute(sql`insert into companies (name, slug) values ('Beta', 'beta-685412') returning id`)) as unknown as { id: string }[];
      const [m] = (await tx.execute(sql`insert into users (email, name) values ('mallory@evil.example', 'Mallory') returning id`)) as unknown as {
        id: string;
      }[];
      await tx.execute(sql`insert into company_memberships (company_id, user_id, company_role) values (${c!.id}, ${m!.id}, 'admin')`);
      const [evil] = (await tx.execute(sql`insert into invitations (company_id, email, invited_by_user_id, expires_at)
        values (${c!.id}, ${victim}, ${m!.id}, now() + interval '7 days') returning id`)) as unknown as { id: string }[];
      const [foreign] = (await tx.execute(sql`insert into invitations (company_id, email, expires_at)
        values (${c!.id}, 'someone-else@beta.example', now() + interval '7 days') returning id`)) as unknown as { id: string }[];
      return { real: real!.id, evil: evil!.id, foreign: foreign!.id, evilCompany: c!.id };
    });

    const { result } = await loginByMagicLink(victim);
    if (result.kind !== 'signup') throw new Error(`expected the sign-up step, got ${result.kind}`);
    expect(await userCount(victim)).toBe(0);
    // Both are shown, newest first, with who invited — the user decides.
    const invites = await listPendingInvitations(deps, victim);
    expect(invites.map((i) => [i.invitationId, i.invitedByEmail])).toEqual([
      [ids.evil, 'mallory@evil.example'],
      [ids.real, 'boss@beta.example'],
    ]);
    // Another address's invitation or an unknown id is refused (back to the sign-up step, nobody created).
    expect((await acceptPendingInvitation(deps, result.pending, ids.foreign)).kind).toBe('signup');
    expect((await acceptPendingInvitation(deps, result.pending, '00000000-0000-4000-8000-000000000000')).kind).toBe('signup');
    expect(await userCount(victim)).toBe(0);

    const s = sessionOf(await acceptPendingInvitation(deps, result.pending, ids.real));
    expect((await loadSessionUser(deps, s.token))?.user.companyId).toBe(beta.companyId);
    // The sign-up step is over: "accepting" the attacker's invitation with the old cookie just logs the user in to Beta.
    const again = sessionOf(await acceptPendingInvitation(deps, result.pending, ids.evil));
    expect((await loadSessionUser(deps, again.token))?.user.companyId).toBe(beta.companyId);
    expect((await loadSessionUser(deps, again.token))?.memberships.map((m) => m.name)).toEqual(['Beta']);
    // It stays pending (one login may join several companies), offered only on /invitations, never joined by itself.
    expect((await listPendingInvitations(deps, victim)).map((i) => i.invitationId)).toEqual([ids.evil]);
  });

  it('sign-up form: join a picked invitation, reject a bad one, origin-checked', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    vi.stubEnv('SESSION_SECRET', 'test-secret-0123456789');
    const email = 'formjoin@beta.example';
    const [inv] = (await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return tx.execute(sql`insert into invitations (company_id, email, team_id, invited_by_user_id, expires_at)
        values (${beta.companyId}, ${email}, ${beta.teamId}, ${beta.bossId}, now() + interval '7 days') returning id`);
    })) as unknown as { id: string }[];
    const cookie = signPayload({ email, name: null, method: 'magic', next: '/turns' }, 'test-secret-0123456789', 60_000);
    const post = (body: string, origin = 'http://localhost:3000') =>
      signupPost(
        new NextRequest('http://localhost:3000/api/auth/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie: `ai_obs_signup=${cookie}` },
          body,
        }),
        () => deps,
      );
    expect((await post(`invitation=${inv!.id}`, 'https://evil.example')).status).toBe(403);
    expect((await post('invitation=not-a-uuid')).headers.get('location')).toBe('http://localhost:3000/signup?error=invitation');
    expect(await userCount(email)).toBe(0);
    const ok = await post(`invitation=${inv!.id}`);
    expect(ok.headers.get('location')).toBe('http://localhost:3000/turns');
    expect(ok.headers.get('set-cookie')).toMatch(/ai_obs_session=/);
    expect(await userCount(email)).toBe(1);
  });

  it('existing users just log in', async () => {
    const { result } = await loginByMagicLink('boss@beta.example');
    const me = await loadSessionUser(deps, sessionOf(result).token);
    expect(me?.user.companyRole).toBe('admin');
  });

  it('solo sign-up: unknown e-mail → name + company → Free company, one team, admin + lead', async () => {
    const { result } = await loginByMagicLink('solo@dev.example');
    expect(result.kind).toBe('signup');
    if (result.kind !== 'signup') return;
    const s = sessionOf(await completeSignup(deps, result.pending, { name: 'Solo Dev', company: 'Solo Works' }));
    const me = await loadSessionUser(deps, s.token);
    expect(me?.user).toMatchObject({ name: 'Solo Dev', companyRole: 'admin', isSuperAdmin: false });
    expect(me?.context?.company).toMatchObject({ name: 'Solo Works', plan: 'free' });
    expect(me?.context?.teams).toHaveLength(1);
    expect(me?.context?.teams[0]?.role).toBe('lead');
    expect((await audit('auth.signup')).map((r) => r.actor_user_id)).toEqual([me!.user.userId]);
    // A replayed sign-up cookie must not create a second company.
    const again = sessionOf(await completeSignup(deps, result.pending, { name: 'x', company: 'Other' }));
    expect((await loadSessionUser(deps, again.token))?.context?.company.name).toBe('Solo Works');
  });

  it('SUPER_ADMIN_EMAILS get a company-less super admin landing on /super', async () => {
    const { result } = await loginByMagicLink(SUPER);
    const s = sessionOf(result);
    expect(s.landing).toBe('/super');
    const me = await loadSessionUser(deps, s.token);
    expect(me).toMatchObject({ user: { isSuperAdmin: true, companyId: null }, context: null });
    expect((await audit('auth.login')).some((r) => r.company_id === null && r.actor_user_id === me!.user.userId)).toBe(true);
  });

  it('SEC-5: removing an e-mail from SUPER_ADMIN_EMAILS revokes the console, live sessions included', async () => {
    const token = sessionOf((await loginByMagicLink(SUPER)).result).token;
    expect((await loadSessionUser(deps, token))?.user.isSuperAdmin).toBe(true);
    const revoked = { ...deps, env: { ...deps.env, SUPER_ADMIN_EMAILS: 'someone-else@platform.example' } };
    expect(await loadSessionUser(revoked, token)).toBeNull();
    expect(await resolveIdentity(revoked, { email: SUPER, name: null, method: 'magic' })).toEqual({ kind: 'error', code: 'no-company' });
    // Listing the e-mail again restores access (the DB flag is unchanged).
    expect((await loadSessionUser(deps, token))?.user.isSuperAdmin).toBe(true);
  });

  it('suspended companies cannot log in or keep sessions', async () => {
    const { result } = await loginByMagicLink('boss@beta.example');
    const token = sessionOf(result).token;
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`update companies set status = 'suspended' where id = ${beta.companyId}`);
    });
    expect(await loadSessionUser(deps, token)).toBeNull();
    expect((await loginByMagicLink('boss@beta.example')).result).toEqual({ kind: 'error', code: 'suspended' });
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      await tx.execute(sql`update companies set status = 'active' where id = ${beta.companyId}`);
    });
  });

  it('logout deletes the session and is audited', async () => {
    const { result } = await loginByMagicLink('invitee@beta.example');
    const token = sessionOf(result).token;
    expect(await loadSessionUser(deps, token)).not.toBeNull();
    await endSession(deps, token);
    expect(await loadSessionUser(deps, token)).toBeNull();
    expect((await audit('auth.logout')).length).toBe(1);
  });

  it('OAuth: links the provider account by verified e-mail and logs in via the link afterwards', async () => {
    const identity = { email: 'boss@beta.example', name: 'Boss', method: 'github' as const, account: { provider: 'github' as const, id: '4242' } };
    sessionOf(await resolveIdentity(deps, identity));
    // Same GitHub account, different e-mail at the provider → still the linked user.
    const r = sessionOf(await resolveIdentity(deps, { ...identity, email: 'renamed@elsewhere.example' }));
    expect((await loadSessionUser(deps, r.token))?.user.email).toBe('boss@beta.example');
  });

  it('e-mailed link: GET only redirects to the confirm page (scanner-safe); a same-origin POST consumes it', async () => {
    vi.stubEnv('APP_URL', 'http://localhost:3000');
    vi.stubEnv('SESSION_SECRET', 'test-secret-0123456789');
    await requestMagicLink(deps, { email: 'invitee@beta.example', ip: null, next: '/turns' });
    const link = new URL(outbox.at(-1)!.text.match(/http\S+/)![0]);
    const token = link.pathname.split('/').at(-1)!;

    // A mail scanner fetching the link (twice) does not use it up.
    for (let i = 0; i < 2; i++) {
      const res = magicLinkGet(new NextRequest(link), token);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`http://localhost:3000/login/magic/${token}?next=%2Fturns`);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(magicLinkGet(new NextRequest(link), 'not-a-token').headers.get('location')).toBe('http://localhost:3000/login?error=link_invalid');

    const post = (headers: Record<string, string>) =>
      magicLinkPost(
        new NextRequest(`${link.origin}${link.pathname}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
          body: 'next=%2Fturns',
        }),
        token,
        () => deps,
      );
    // Cross-site or origin-less POSTs are refused before the token is touched.
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({})).status).toBe(403);

    const ok = await post({ origin: 'http://localhost:3000' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('http://localhost:3000/turns');
    expect(ok.headers.get('set-cookie')).toMatch(/ai_obs_session=/);
    const replay = await post({ origin: 'http://localhost:3000' });
    expect(replay.headers.get('location')).toBe('http://localhost:3000/login?error=link_invalid');
  });

  it('rate-limits magic links per e-mail', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await requestMagicLink(deps, { email: 'spam@x.example', ip: `198.51.100.${i}`, next: null }));
    expect(results.at(-1)).toEqual({ ok: false, error: 'rate_limited' });
  });

  // ---- one login, many companies (ADR-0022) ----------------------------------------------------

  type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
  const asDefiner = <T>(fn: (tx: Tx) => Promise<T>) =>
    owner.transaction(async (tx) => {
      await tx.execute(sql`set local role app_definer`);
      return fn(tx);
    });
  const idOf = async (tx: Tx, q: ReturnType<typeof sql>) => ((await tx.execute(q)) as unknown as { id: string }[])[0]!.id;
  /** A company with one team (named after the company). */
  const mkCompany = (name: string, slug: string) =>
    asDefiner(async (tx) => {
      const id = await idOf(tx, sql`insert into companies (name, slug, plan) values (${name}, ${slug}, 'team') returning id`);
      const teamId = await idOf(tx, sql`insert into teams (company_id, name) values (${id}, ${name}) returning id`);
      return { id, teamId };
    });
  const mkUser = (email: string, name: string) => asDefiner((tx) => idOf(tx, sql`insert into users (email, name) values (${email}, ${name}) returning id`));
  /** Company membership (+ team membership in the company's team when `teamRole` is given). */
  const addMember = (c: { id: string; teamId: string }, userId: string, role: 'admin' | 'member', teamRole?: 'member' | 'lead') =>
    asDefiner(async (tx) => {
      await tx.execute(sql`insert into company_memberships (company_id, user_id, company_role, primary_team_id)
        values (${c.id}, ${userId}, ${role}, ${teamRole ? c.teamId : null})`);
      if (teamRole) await tx.execute(sql`insert into team_memberships (company_id, team_id, user_id, role) values (${c.id}, ${c.teamId}, ${userId}, ${teamRole})`);
    });
  const invite = (c: { id: string; teamId: string }, email: string, invitedBy: string) =>
    asDefiner((tx) =>
      idOf(tx, sql`insert into invitations (company_id, email, team_id, team_role, invited_by_user_id, expires_at)
        values (${c.id}, ${email}, ${c.teamId}, 'member', ${invitedBy}, now() + interval '7 days') returning id`),
    );
  const setStatus = (companyId: string, status: 'active' | 'suspended') =>
    asDefiner((tx) => tx.execute(sql`update companies set status = ${status} where id = ${companyId}`));
  /** External ids of the turns visible under a session user's RLS context (what withUserDb would see). */
  const visibleTurns = async (token: string) => {
    const me = (await loadSessionUser(deps, token))!;
    return withRlsContext(deps.web, { companyId: me.user.companyId!, userId: me.user.userId, role: me.user.companyRole }, async (tx) =>
      ((await tx.execute(sql`select external_id from turns order by external_id`)) as unknown as { external_id: string }[]).map((r) => r.external_id),
    );
  };
  const IP = '203.0.113.8';

  it('switcher end to end: invitation while signed in, switch, last active company, refused switches, removal', async () => {
    const A = await mkCompany('Alpha', 'alpha');
    const B = await mkCompany('Bravo', 'bravo');
    const C = await mkCompany('Charlie', 'charlie');
    const S = await mkCompany('Sierra', 'sierra');
    const alice = await mkUser('alice@alpha.example', 'Alice');
    const bob = await mkUser('bob@bravo.example', 'Bob');
    await addMember(A, alice, 'admin', 'lead');
    await addMember(S, alice, 'member');
    await addMember(B, bob, 'admin', 'lead');
    await setStatus(S.id, 'suspended');
    await asDefiner((tx) =>
      tx.execute(sql`insert into turns (company_id, team_id, user_id, attribution, external_id, harness, started_at, ended_at) values
        (${A.id}, ${A.teamId}, ${alice}, 'verified', 'alpha-1', 'claude-code', now(), now()),
        (${B.id}, ${B.teamId}, ${bob}, 'verified', 'bravo-1', 'claude-code', now(), now()),
        (${B.id}, ${B.teamId}, ${alice}, 'verified', 'bravo-alice', 'claude-code', now(), now())`),
    );
    const invitationId = await invite(B, 'alice@alpha.example', bob);

    // Login lands in A, her only active company (S is suspended and not offered).
    const s1 = sessionOf((await loginByMagicLink('alice@alpha.example', null, IP)).result);
    let me = await loadSessionUser(deps, s1.token);
    expect(me?.user).toMatchObject({ companyId: A.id, companyRole: 'admin' });
    expect(me?.memberships.map((m) => m.companyId)).toEqual([A.id]);
    expect(await visibleTurns(s1.token)).toEqual(['alpha-1']);

    // B's invitation is listed for the signed-in user; joining it adds a membership, no second identity.
    expect((await listPendingInvitations(deps, 'alice@alpha.example')).map((i) => [i.invitationId, i.companyName])).toEqual([[invitationId, 'Bravo']]);
    expect(await acceptInvitationForSession(deps, s1.token, invitationId)).toEqual({ companyId: B.id });
    expect(await userCount('alice@alpha.example')).toBe(1);
    expect(await acceptInvitationForSession(deps, s1.token, invitationId)).toBeNull(); // used up
    me = await loadSessionUser(deps, s1.token);
    expect(me?.user).toMatchObject({ userId: alice, companyId: B.id, companyRole: 'member' });
    expect(me?.context?.company.name).toBe('Bravo');
    expect(me?.context?.teams).toEqual([{ id: B.teamId, name: 'Bravo', role: 'member' }]);
    expect(me?.context?.primaryTeamId).toBe(B.teamId);
    expect(me?.memberships.map((m) => m.companyId).sort()).toEqual([A.id, B.id].sort());
    // Her own turns in B only (a member of B, aggregates-only): never her A turn, never Bob's.
    expect(await visibleTurns(s1.token)).toEqual(['bravo-alice']);
    const accepted = (await audit('auth.invitation_accepted')).filter((r) => r.actor_user_id === alice);
    expect(accepted).toEqual([{ company_id: B.id, actor_user_id: alice, meta: { method: 'session' } }]);

    // Switch to A and back to B: one audit row per switch, in the destination only, with empty meta.
    expect(await switchActiveCompany(deps, s1.token, A.id)).toBe(true);
    expect((await loadSessionUser(deps, s1.token))?.user.companyId).toBe(A.id);
    expect(await visibleTurns(s1.token)).toEqual(['alpha-1']);
    expect(await switchActiveCompany(deps, s1.token, B.id)).toBe(true);
    expect((await loadSessionUser(deps, s1.token))?.user.companyId).toBe(B.id);
    expect(await visibleTurns(s1.token)).toEqual(['bravo-alice']);
    const switches = (await audit('auth.company_switch')).filter((r) => r.actor_user_id === alice);
    expect(switches).toEqual([
      { company_id: A.id, actor_user_id: alice, meta: {} },
      { company_id: B.id, actor_user_id: alice, meta: {} },
    ]);
    const leaks = (await owner.execute(
      sql`select count(*)::int as n from audit_log where company_id = ${B.id} and (meta::text like ${'%' + A.id + '%'} or target like ${'%' + A.id + '%'})`,
    )) as unknown as { n: number }[];
    expect(leaks[0]!.n).toBe(0);

    // A company she is not in, a suspended one of hers, or garbage: refused, the active company stays B.
    expect(await switchActiveCompany(deps, s1.token, C.id)).toBe(false);
    expect(await switchActiveCompany(deps, s1.token, S.id)).toBe(false);
    expect(await switchActiveCompany(deps, s1.token, 'not-a-uuid')).toBe(false);
    expect((await loadSessionUser(deps, s1.token))?.user.companyId).toBe(B.id);
    expect((await audit('auth.company_switch')).filter((r) => r.actor_user_id === alice)).toHaveLength(2);

    // D4: log out and in again → the last active company (B), not the oldest membership.
    await endSession(deps, s1.token);
    expect((await audit('auth.logout')).filter((r) => r.actor_user_id === alice)).toEqual([{ company_id: B.id, actor_user_id: alice, meta: {} }]);
    const s2 = sessionOf((await loginByMagicLink('alice@alpha.example', null, IP)).result);
    expect((await loadSessionUser(deps, s2.token))?.user.companyId).toBe(B.id);

    // Bob removes her from B: her next request falls back to A, and the session is repointed.
    await withRlsContext(deps.web, { companyId: B.id, userId: bob, role: 'admin' }, (tx) => tx.execute(sql`select * from admin_remove_member(${alice}::uuid)`));
    me = await loadSessionUser(deps, s2.token);
    expect(me?.user.companyId).toBe(A.id);
    expect(me?.memberships.map((m) => m.companyId)).toEqual([A.id]);
    expect(await visibleTurns(s2.token)).toEqual(['alpha-1']);
    const [row] = (await owner.execute(sql`select active_company_id from auth_sessions where token_hash = ${hashToken(s2.token)}`)) as unknown as {
      active_company_id: string;
    }[];
    expect(row!.active_company_id).toBe(A.id);
  });

  it('D5: an OAuth account linked to an identity with another e-mail signs up and joins on the identity, never a second user', async () => {
    const E = await mkCompany('Echo', 'echo');
    const F = await mkCompany('Foxtrot', 'foxtrot');
    const ann = await mkUser('ann@a.example', 'Ann');
    const fox = await mkUser('fox@foxtrot.example', 'Fox');
    await addMember(E, ann, 'member', 'member');
    await addMember(F, fox, 'admin', 'lead');
    await deps.web.execute(sql`insert into auth_accounts (user_id, provider, provider_account_id) values (${ann}, 'github', '42')`);
    // Removed from her only company: the identity stays, without memberships.
    await asDefiner((tx) => tx.execute(sql`delete from company_memberships where user_id = ${ann}`));
    const invitationId = await invite(F, 'ann@a.example', fox);

    const oauth = { email: 'ann@gmail.example', name: 'Ann G', method: 'github' as const, account: { provider: 'github' as const, id: '42' } };
    const r = await resolveIdentity(deps, oauth);
    if (r.kind !== 'signup') throw new Error(`expected the sign-up step, got ${JSON.stringify(r)}`);
    expect(r.pending.email).toBe('ann@a.example');
    expect(r.pending.invitationsOnly).toBeUndefined();
    expect((await listPendingInvitations(deps, r.pending.email)).map((i) => i.invitationId)).toEqual([invitationId]);

    const s = sessionOf(await acceptPendingInvitation(deps, r.pending, invitationId));
    const both = (await owner.execute(
      sql`select count(*)::int as n from users where email in ('ann@a.example', 'ann@gmail.example')`,
    )) as unknown as { n: number }[];
    expect(both[0]!.n).toBe(1);
    expect((await loadSessionUser(deps, s.token))?.user).toMatchObject({ userId: ann, companyId: F.id });
    const again = sessionOf(await resolveIdentity(deps, oauth));
    expect((await loadSessionUser(deps, again.token))?.user).toMatchObject({ userId: ann, companyId: F.id });
  });

  it('all companies suspended: the invitations-only sign-up step; joining works, solo sign-up is refused', async () => {
    const G = await mkCompany('Golf', 'golf');
    const H = await mkCompany('Hotel', 'hotel');
    const carl = await mkUser('carl@golf.example', 'Carl');
    const hank = await mkUser('hank@hotel.example', 'Hank');
    await addMember(G, carl, 'member', 'member');
    await addMember(H, hank, 'admin', 'lead');
    await setStatus(G.id, 'suspended');
    expect((await loginByMagicLink('carl@golf.example', null, IP)).result).toEqual({ kind: 'error', code: 'suspended' });

    const invitationId = await invite(H, 'carl@golf.example', hank);
    const { result } = await loginByMagicLink('carl@golf.example', null, IP);
    if (result.kind !== 'signup') throw new Error(`expected the sign-up step, got ${JSON.stringify(result)}`);
    expect(result.pending).toMatchObject({ email: 'carl@golf.example', invitationsOnly: true });
    expect(await completeSignup(deps, result.pending, { name: 'Carl', company: 'Carl Co' })).toEqual({ kind: 'error', code: 'suspended' });
    // Even a forged cookie without the flag cannot create a company: the rules are re-run from the DB.
    expect(await completeSignup(deps, { ...result.pending, invitationsOnly: false }, { name: 'Carl', company: 'Carl Co' })).toEqual({
      kind: 'error',
      code: 'suspended',
    });

    const s = sessionOf(await acceptPendingInvitation(deps, result.pending, invitationId));
    const me = await loadSessionUser(deps, s.token);
    expect(me?.user).toMatchObject({ userId: carl, companyId: H.id });
    expect(me?.memberships.map((m) => m.companyId)).toEqual([H.id]);
    expect(await userCount('carl@golf.example')).toBe(1);
  });
});
