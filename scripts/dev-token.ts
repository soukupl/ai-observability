/**
 * Dev helper: creates a manual user ingest token for a seeded person and prints the plaintext.
 *
 *   pnpm dev:token [email] [label] [days]
 *
 * Without arguments: alice@acme.example (the seeded admin member), label `dev-token`, expiry in 90 days.
 * `days` is the lifetime (a number, or `none` for a token that never expires). The token has source `manual`,
 * like one made on "My tokens", and belongs to the user found by e-mail (a person with a membership).
 *
 * Connects as the schema owner (MIGRATE_DATABASE_URL / DATABASE_URL), so it bypasses RLS.
 * Dev only: never run against production data.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createDb } from '../packages/db/src/client.ts';
import { TOKEN_PREFIXES } from '../packages/protocol/src/index.ts';

const email = (process.argv[2]?.trim() || 'alice@acme.example').toLowerCase();
const label = process.argv[3]?.trim() || 'dev-token';
const lifetime = process.argv[4]?.trim().toLowerCase() || '90';
const days = lifetime === 'none' ? null : Number(lifetime);
if (days !== null && (!Number.isFinite(days) || days <= 0)) throw new Error('days must be a positive number or "none"');
const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const { db, close } = createDb({ url, max: 1 });
const sql = db.$client;
try {
  const rows = await sql<{ user_id: string; email: string }[]>`
    select u.id as user_id, u.email
    from users u join memberships m on m.user_id = u.id
    where u.email = ${email} and u.kind = 'person'`;
  const member = rows[0];
  if (!member) throw new Error(`no seeded person with a membership for ${email} (run pnpm db:seed)`);

  const prefix = TOKEN_PREFIXES.user;
  const plaintext = prefix + randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(plaintext, 'utf8').digest('hex');
  await sql`
    insert into ingest_tokens (user_id, name, source, label, prefix, hash, created_by_user_id, expires_at)
    values (${member.user_id}, ${label}, 'manual', ${label}, ${plaintext.slice(0, prefix.length + 4)}, ${hash},
            ${member.user_id}, ${days === null ? null : new Date(Date.now() + days * 86_400_000)})`;
  console.error(`token for ${member.email}, label ${label}, ${days === null ? 'no expiry' : `expires in ${days} days`}`);
  console.log(plaintext);
} finally {
  await close();
}
