import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

// Local dev: the single .env lives at the repo root, not in apps/web. Existing env vars win;
// in Docker there is no file and config comes from the environment only.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {}

const config: NextConfig = {
  output: 'standalone',
  // Monorepo: trace files from the repo root so the standalone bundle includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  transpilePackages: ['@ai-obs/protocol', '@ai-obs/db'],
  poweredByHeader: false,
  // Do not let `next dev` write AGENTS.md / CLAUDE.md into the repo.
  agentRules: false,
  // SEC-13: the dashboard must not be framed (clickjacking). CSP frame-ancestors for modern browsers,
  // X-Frame-Options as the legacy twin; Referrer-Policy keeps ids in URLs from leaking to other origins.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default config;
