/**
 * Dev helper: creates a user ingest token for a seeded user and prints the plaintext.
 *
 *   pnpm dev:token [email]        # default: first member of the oldest company
 *
 * Connects as the schema owner (MIGRATE_DATABASE_URL / DATABASE_URL), so it bypasses RLS.
 * Dev only: never run against production data.
 */
import { createDb } from '../packages/db/src/client.ts';
import { generateToken } from '../apps/web/src/lib/ingest/tokens.ts';

const email = process.argv[2]?.toLowerCase();
const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const { db, close } = createDb({ url, max: 1 });
const sql = db.$client;
try {
  const rows = await sql<{ id: string; company_id: string; email: string; team_id: string }[]>`
    select u.id, u.company_id, u.email, m.team_id
    from users u
    join team_memberships m on m.user_id = u.id and m.company_id = u.company_id
    where u.company_id is not null and (${email ?? null}::text is null or lower(u.email) = ${email ?? ''})
    order by u.created_at
    limit 1`;
  const user = rows[0];
  if (!user) throw new Error(`no seeded user with a team${email ? ` for ${email}` : ''}`);
  const token = generateToken('user');
  await sql`
    insert into ingest_tokens (company_id, team_id, user_id, kind, name, prefix, hash)
    values (${user.company_id}, ${user.team_id}, ${user.id}, 'user', 'dev-token', ${token.prefix}, ${token.hash})`;
  console.error(`token for ${user.email} (company ${user.company_id})`);
  console.log(token.plaintext);
} finally {
  await close();
}
