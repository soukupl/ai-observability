/**
 * Dev helper: creates a user ingest token for a seeded member and prints the plaintext.
 *
 *   pnpm dev:token [email] [company-slug]
 *
 * Without arguments: the most recently active membership (the company the user last switched to), else the
 * oldest one; on a fresh seed that is alice@acme.example in acme. An e-mail picks that user's active company,
 * a slug overrides it (e.g. `pnpm dev:token alice@acme.example globex`). User tokens are never bound to a team.
 *
 * Connects as the schema owner (MIGRATE_DATABASE_URL / DATABASE_URL), so it bypasses RLS.
 * Dev only: never run against production data.
 */
import { createDb } from '../packages/db/src/client.ts';
import { generateToken } from '../apps/web/src/lib/ingest/tokens.ts';

const email = process.argv[2]?.trim().toLowerCase() || null;
const slug = process.argv[3]?.trim().toLowerCase() || null;
const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const { db, close } = createDb({ url, max: 1 });
const sql = db.$client;
try {
  const rows = await sql<{ user_id: string; email: string; company_id: string; slug: string }[]>`
    select u.id as user_id, u.email, m.company_id, c.slug
    from company_memberships m join users u on u.id = m.user_id join companies c on c.id = m.company_id
    where (${email}::text is null or u.email = ${email}) and (${slug}::text is null or c.slug = ${slug})
    order by m.last_active_at desc nulls last, m.created_at, u.email, c.slug
    limit 1`;
  const member = rows[0];
  if (!member) {
    const who = [email && `user ${email}`, slug && `company ${slug}`].filter(Boolean).join(' in ');
    throw new Error(`no seeded membership${who ? ` for ${who}` : ''}`);
  }
  const token = generateToken('user');
  await sql`
    insert into ingest_tokens (company_id, user_id, kind, name, prefix, hash, created_by_user_id)
    values (${member.company_id}, ${member.user_id}, 'user', 'dev-token', ${token.prefix}, ${token.hash}, ${member.user_id})`;
  console.error(`token for ${member.email} in ${member.slug}`);
  console.log(token.plaintext);
} finally {
  await close();
}
