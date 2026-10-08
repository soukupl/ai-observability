import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest 4+ removed vitest.workspace.ts; projects live here instead.
const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/** Tests import workspace packages from source, so no build is needed before `pnpm test`. */
const alias = {
  '@ai-obs/protocol': src('protocol'),
  '@ai-obs/db': src('db'),
};

/**
 * Projects with real-Postgres suites (each creates, migrates and drops its own database) get more headroom than
 * vitest's 5 s / 10 s defaults: with every project's files running in parallel, a migration or a seed can take
 * longer on a busy machine without anything being wrong.
 */
const pgTimeouts = { testTimeout: 30_000, hookTimeout: 60_000 };

const project = (name: string, root: string, timeouts: { testTimeout?: number; hookTimeout?: number } = {}) => ({
  extends: false as const,
  resolve: { alias },
  test: { name, root, environment: 'node' as const, include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'], ...timeouts },
});

export default defineConfig({
  test: {
    projects: [
      project('protocol', './packages/protocol'),
      project('db', './packages/db', pgTimeouts),
      project('collector', './packages/collector'),
      project('worker', './apps/worker', pgTimeouts),
      project('web', './apps/web', pgTimeouts),
    ],
  },
});
