import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withRlsContext, type Database, type Tx } from '@ai-obs/db';
import { schemas } from '@ai-obs/protocol';
import {
  DEVICE_CODE_RATE_LIMIT,
  DEVICE_GRANT_TYPE,
  DEVICE_MAX_OPEN_CODES,
  generateUserCode,
  handleDeviceCode,
  handleDeviceToken,
  type DeviceDeps,
} from '../../src/lib/ingest/device';
import { handleCollectorConfig } from '../../src/lib/ingest/handler';
import { AuthGuard, TokenBucketLimiter } from '../../src/lib/ingest/rate-limit';
import { hashToken } from '../../src/lib/ingest/tokens';
import { connectIngest, connectOwner, connectRole, dropIngestTestDb, prepareIngestTestDb, useIngestTestDb } from './db-harness';
import { createWorld, type World } from './fixtures';

useIngestTestDb('device');
const skip = await prepareIngestTestDb();

const ENV = { APP_URL: 'https://obs.example.com', INGEST_TRUSTED_PROXY_HOPS: '1' } as unknown as NodeJS.ProcessEnv;

describe.skipIf(skip !== null)(`device login (ADR-0029, Appendix B) against Postgres${skip ? ` (skipped: ${skip})` : ''}`, () => {
  let db: Database;
  let web: Database;
  let owner: ReturnType<typeof connectOwner>;
  let w: World;
  let ipSeq = 0;
  const nextIp = () => `198.51.100.${++ipSeq}`;

  beforeAll(async () => {
    db = connectIngest();
    web = connectRole('web');
    owner = connectOwner();
    w = await owner.run((tx) => createWorld(tx));
  });
  afterAll(async () => {
    await dropIngestTestDb();
  });

  const q = <T = Record<string, unknown>>(query: ReturnType<typeof sql>) =>
    owner.run(async (tx: Tx) => [...(await tx.execute(query))] as T[]);

  const deps = (over: Partial<DeviceDeps> = {}): DeviceDeps => ({
    db,
    codeLimiter: new TokenBucketLimiter(DEVICE_CODE_RATE_LIMIT),
    tokenGuard: new AuthGuard({ failures: { burst: 20, perMinute: 10 } }),
    env: ENV,
    ...over,
  });

  const postJson = (path: string, body: unknown, ip: string) =>
    new Request(`http://test/api/v1/device/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.1, ${ip}` },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  async function requestCode(d = deps(), ip = nextIp(), body: unknown = { client_name: 'mac-alice', client_version: '0.5.0' }) {
    const res = await handleDeviceCode(postJson('code', body, ip), d);
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> };
  }

  async function poll(deviceCode: string, d = deps(), ip = '203.0.113.50') {
    const res = await handleDeviceToken(postJson('token', { grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode }, ip), d);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** Lets the next poll through the interval check. */
  const backdatePoll = (deviceCode: string) =>
    q(sql`update device_codes set last_polled_at = now() - interval '10 seconds' where device_code_hash = ${hashToken(deviceCode)}`);

  const asUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>) => withRlsContext(web, { userId, role: 'member' }, fn);
  const approve = (userId: string, userCode: string) =>
    asUser(userId, async (tx) => [...(await tx.execute(sql`select * from device_approve(${userCode})`))]);
  const deny = (userId: string, userCode: string) =>
    asUser(userId, async (tx) => [...(await tx.execute(sql`select device_deny(${userCode}) as ok`))]);

  describe('POST /api/v1/device/code', () => {
    it('returns a device code, a XXXX-XXXX user code, the verification URI, 600 s and a 5 s interval; stores only the hash', async () => {
      const ip = nextIp();
      const res = await requestCode(deps(), ip);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.body).toEqual({
        device_code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        user_code: expect.stringMatching(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/),
        verification_uri: 'https://obs.example.com/device',
        expires_in: 600,
        interval: 5,
      });
      const [row] = await q(sql`select device_code_hash, user_code, client_name, client_version, requester_ip, status,
          expires_at > now() + interval '590 seconds' and expires_at <= now() + interval '600 seconds' as ttl
        from device_codes where user_code = ${String(res.body.user_code).replace('-', '')}`);
      expect(row).toEqual({
        device_code_hash: hashToken(String(res.body.device_code)),
        user_code: String(res.body.user_code).replace('-', ''),
        client_name: 'mac-alice',
        client_version: '0.5.0',
        requester_ip: ip,
        status: 'pending',
        ttl: true,
      });
    });

    it('user codes are 8 letters of the unambiguous alphabet', () => {
      for (let i = 0; i < 200; i++) expect(generateUserCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    });

    it('400 invalid_request for a body that is not a JSON object with a client name', async () => {
      for (const body of ['{nope', '[]', '"x"', {}, { client_name: '' }, { client_name: 42 }, { client_name: 'x'.repeat(5000) }]) {
        const res = await requestCode(deps(), nextIp(), body);
        expect(res).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
      }
    });

    it('cleans the client name (control characters, 100 characters at most)', async () => {
      const res = await requestCode(deps(), nextIp(), { client_name: `  host\u0007name${'y'.repeat(200)}  ` });
      expect(res.status).toBe(200);
      const [row] = await q<{ client_name: string; client_version: string | null }>(
        sql`select client_name, client_version from device_codes where user_code = ${String(res.body.user_code).replace('-', '')}`,
      );
      expect(row!.client_name).toBe(`hostname${'y'.repeat(92)}`);
      expect(row!.client_version).toBeNull();
    });

    it('rate limits per client IP: burst 10, then 429 with Retry-After; another IP is not affected', async () => {
      const d = deps();
      const ip = nextIp();
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await requestCode(d, ip)).status);
      expect(statuses).toEqual([...Array(10).fill(200), 429]);
      const limited = await requestCode(d, ip);
      expect(limited.body).toEqual({ error: 'rate_limited' });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await requestCode(d, nextIp())).status).toBe(200);
    });
  });

  describe('POST /api/v1/device/token', () => {
    it('pending → slow_down when polled too fast → approved → token, exchanged at most once', async () => {
      const code = await requestCode();
      const deviceCode = String(code.body.device_code);
      const d = deps();

      expect(await poll(deviceCode, d)).toEqual({ status: 400, body: { error: 'authorization_pending' } });
      expect(await poll(deviceCode, d)).toEqual({ status: 400, body: { error: 'slow_down' } });

      expect(await approve(w.users.bob, String(code.body.user_code))).toHaveLength(1);
      const before = Date.now();
      const ok = await poll(deviceCode, d);
      expect(ok).toEqual({
        status: 200,
        body: { token: expect.stringMatching(/^aiobs_u_[A-Za-z0-9_-]{43}$/), expires_at: expect.any(String), label: 'mac-alice' },
      });
      const token = String(ok.body.token);
      const expiresMs = Date.parse(String(ok.body.expires_at));
      expect(expiresMs - before).toBeGreaterThan(90 * 86_400_000 - 120_000);
      expect(expiresMs - before).toBeLessThan(90 * 86_400_000 + 120_000);

      // Minted for the approver, stored as a hash only, audited; the code is consumed.
      const [stored] = await q(sql`select user_id, source, label, name, prefix, created_by_user_id, revoked_at from ingest_tokens
        where hash = ${hashToken(token)}`);
      expect(stored).toEqual({
        user_id: w.users.bob, source: 'device', label: 'mac-alice', name: 'mac-alice', prefix: token.slice(0, 12),
        created_by_user_id: w.users.bob, revoked_at: null,
      });
      expect(await q(sql`select 1 from ingest_tokens where hash = ${token} or prefix = ${token}`)).toEqual([]);
      const [codeRow] = await q(sql`select status, approved_by, token_id is not null as minted from device_codes
        where device_code_hash = ${hashToken(deviceCode)}`);
      expect(codeRow).toEqual({ status: 'consumed', approved_by: w.users.bob, minted: true });
      expect(await q(sql`select actor_user_id, meta->>'source' as source from audit_log where action = 'token.create'`)).toEqual([
        { actor_user_id: w.users.bob, source: 'device' },
      ]);

      // The new token works against collector-config.
      const cfg = await handleCollectorConfig(
        new Request('http://test/api/v1/collector-config', { headers: { authorization: `Bearer ${token}` } }),
        { db, limiter: new TokenBucketLimiter({ burst: 10, perMinute: 60 }), env: ENV },
      );
      const body = (await cfg.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ user: { email: 'bob@acme.test', kind: 'person' }, token: { label: 'mac-alice', source: 'device' } });
      expect(schemas.collectorConfigResponse.safeParse(body).success).toBe(true);

      // A code is exchanged at most once.
      await backdatePoll(deviceCode);
      expect(await poll(deviceCode, d)).toEqual({ status: 400, body: { error: 'invalid_grant' } });
    });

    it('a denied code answers access_denied', async () => {
      const code = await requestCode();
      expect(await deny(w.users.alice, String(code.body.user_code).toLowerCase())).toEqual([{ ok: true }]);
      expect(await poll(String(code.body.device_code))).toEqual({ status: 400, body: { error: 'access_denied' } });
    });

    it('an expired code answers expired_token, also after approval', async () => {
      const pending = await requestCode();
      await q(sql`update device_codes set expires_at = now() - interval '1 second' where device_code_hash = ${hashToken(String(pending.body.device_code))}`);
      expect(await poll(String(pending.body.device_code))).toEqual({ status: 400, body: { error: 'expired_token' } });

      const approved = await requestCode();
      await approve(w.users.alice, String(approved.body.user_code));
      await q(sql`update device_codes set expires_at = now() - interval '1 second' where device_code_hash = ${hashToken(String(approved.body.device_code))}`);
      expect(await poll(String(approved.body.device_code))).toEqual({ status: 400, body: { error: 'expired_token' } });
    });

    it('an approver who lost their membership before the exchange gets no token (access_denied)', async () => {
      const code = await requestCode();
      await approve(w.users.dave, String(code.body.user_code));
      await q(sql`delete from memberships where user_id = ${w.users.dave}`);
      expect(await poll(String(code.body.device_code))).toEqual({ status: 400, body: { error: 'access_denied' } });
      expect(await q(sql`select 1 from ingest_tokens where user_id = ${w.users.dave} and source = 'device'`)).toEqual([]);
    });

    it('a service user cannot approve a device login', async () => {
      const code = await requestCode();
      await expect(approve(w.users.svc, String(code.body.user_code))).rejects.toMatchObject({
        cause: expect.objectContaining({ code: '42501' }),
      });
    });

    it('400 for an unknown code, a wrong grant type or a malformed body', async () => {
      expect(await poll('A'.repeat(43))).toEqual({ status: 400, body: { error: 'invalid_grant' } });
      expect(await poll('short')).toEqual({ status: 400, body: { error: 'invalid_grant' } });
      const wrongGrant = await handleDeviceToken(postJson('token', { grant_type: 'password', device_code: 'A'.repeat(43) }, nextIp()), deps());
      expect([wrongGrant.status, await wrongGrant.json()]).toEqual([400, { error: 'unsupported_grant_type' }]);
      for (const body of ['{nope', '[]', 'null']) {
        const res = await handleDeviceToken(postJson('token', body, nextIp()), deps());
        expect([res.status, await res.json()]).toEqual([400, { error: 'invalid_request' }]);
      }
    });

    it('unknown codes spend a per-IP miss budget (429 beyond it); a valid code from another IP still works', async () => {
      const d = deps({ tokenGuard: new AuthGuard({ failures: { burst: 3, perMinute: 1 } }) });
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await poll(`${'B'.repeat(42)}${i}`, d, '203.0.113.99')).status);
      expect(statuses).toEqual([400, 400, 400, 429, 429]);
      const code = await requestCode();
      expect(await poll(String(code.body.device_code), d, '203.0.113.100')).toEqual({ status: 400, body: { error: 'authorization_pending' } });
    });

    it('never logs device codes, user codes or tokens', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      try {
        const code = await requestCode();
        await poll(String(code.body.device_code));
        await approve(w.users.alice, String(code.body.user_code));
        await backdatePoll(String(code.body.device_code));
        const ok = await poll(String(code.body.device_code));
        expect(ok.status).toBe(200);
        const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
        for (const secret of [code.body.device_code, code.body.user_code, ok.body.token]) expect(logged).not.toContain(String(secret));
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });
  });

  it('the routes export POST only (Next answers other methods with 405)', async () => {
    const code = await import('../../src/app/api/v1/device/code/route');
    const token = await import('../../src/app/api/v1/device/token/route');
    for (const mod of [code, token]) {
      expect(typeof mod.POST).toBe('function');
      expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k))).toEqual(['POST']);
    }
  });

  it(`answers 429 while ${DEVICE_MAX_OPEN_CODES} codes are open, and again 200 once they expire`, async () => {
    const [row] = await q<{ open: number }>(sql`select count(*)::int as open from device_codes where status in ('pending', 'approved') and expires_at > now()`);
    const fill = DEVICE_MAX_OPEN_CODES - row!.open;
    await q(sql`insert into device_codes (device_code_hash, user_code, client_name, expires_at)
      select md5('fill' || g::text), ${'ZZ'} || lpad(translate(to_hex(g), '0123456789abcdef', 'ABCDEFGHJKLMNPQR'), 6, 'A'), 'filler', now() + interval '10 minutes'
      from generate_series(1, ${fill}) g`);
    const capped = await requestCode();
    expect(capped).toMatchObject({ status: 429, body: { error: 'too_many_open_codes' } });
    await q(sql`update device_codes set expires_at = now() - interval '1 second' where client_name = 'filler'`);
    expect((await requestCode()).status).toBe(200);
  });
});
