import { index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, tstz } from './columns.js';
import { users } from './tenancy.js';

/**
 * Dashboard login (ADR-0013). Identity tables used before an RLS context exists, so they have no RLS (only app_web
 * may touch them). Secrets are stored as hashes only.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('auth_accounts_provider_uq').on(t.provider, t.providerAccountId), index('auth_accounts_user_idx').on(t.userId)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    lastSeenAt: tstz('last_seen_at'),
    createdAt: createdAt(),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId), index('auth_sessions_expires_idx').on(t.expiresAt)],
);

export const magicLinks = pgTable(
  'magic_links',
  {
    id: pk(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    usedAt: tstz('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('magic_links_email_idx').on(t.email)],
);
