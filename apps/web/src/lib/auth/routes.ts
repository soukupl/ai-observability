/**
 * Paths reachable without a session. Everything else — the (dashboard) views, /admin, /super and
 * any other API — needs the session cookie (checked optimistically in proxy.ts; pages and handlers
 * still call requireUser() / getCurrentUser(), which validate it against auth_sessions).
 */
const PUBLIC = [
  /^\/$/,
  /^\/(login|signup|logout|invite)(\/.*)?$/,
  /^\/api\/auth\//,
  // Collector API authenticates with ingest tokens, not cookies.
  /^\/api\/v1\/(ingest|collector-config)(\/.*)?$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC.some((re) => re.test(pathname));
}
