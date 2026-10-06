/**
 * CSRF check for state-changing auth POSTs (with SameSite=Lax cookies as the second layer).
 * Accepts the request when Origin matches one of the allowed origins; without Origin, falls back to
 * Referer, then to `Sec-Fetch-Site: same-origin`. Everything else is rejected.
 */
export function isSameOriginRequest(headers: Headers, allowedOrigins: readonly string[]): boolean {
  const allowed = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  const origin = headers.get('origin');
  if (origin && origin !== 'null') return allowed.has(origin.toLowerCase());
  if (origin === 'null') return false;
  const referer = headers.get('referer');
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin.toLowerCase());
    } catch {
      return false;
    }
  }
  return headers.get('sec-fetch-site') === 'same-origin';
}
