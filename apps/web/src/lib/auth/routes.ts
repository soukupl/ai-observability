/**
 * Paths reachable without a session. Everything else (the (dashboard) views, /device, /welcome, /admin and any other
 * API) needs the session cookie (checked optimistically in proxy.ts; pages and handlers still call requireUser() /
 * getCurrentUser(), which validate it against auth_sessions). An unauthenticated page visit goes to /login?next=…,
 * so /device lands back on the approval page after sign-in.
 */
const PUBLIC = [
  /^\/$/,
  /^\/(login|logout)(\/.*)?$/,
  /^\/api\/auth\//,
  // Collector API: ingest and collector-config authenticate with ingest tokens; the device-login routes are public
  // (rate limited per IP, ADR-0029) because the CLI has no token yet.
  /^\/api\/v1\/(ingest|collector-config)(\/.*)?$/,
  /^\/api\/v1\/device\/(code|token)$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC.some((re) => re.test(pathname));
}
