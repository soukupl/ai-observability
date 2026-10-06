import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Vitest 4+ removed vitest.workspace.ts; projects live here instead.
const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/** Tests import workspace packages from source, so no build is needed before `pnpm test`. */
const alias = {
  '@ai-obs/protocol': src('protocol'),
  '@ai-obs/db': src('db'),
};

const project = (name: string, root: string) => ({
  extends: false as const,
  resolve: { alias },
  test: { name, root, environment: 'node' as const, include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'] },
});

export default defineConfig({
  test: {
    projects: [
      project('protocol', './packages/protocol'),
      project('db', './packages/db'),
      project('collector', './packages/collector'),
      project('worker', './apps/worker'),
      project('web', './apps/web'),
    ],
  },
});
