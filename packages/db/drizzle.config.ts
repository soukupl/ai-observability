import { defineConfig } from 'drizzle-kit';

// Local dev: pick up the repo-root .env (no-op when it does not exist, e.g. in Docker).
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://ai_obs:ai_obs@localhost:5432/ai_obs' },
  strict: true,
  verbose: true,
});
