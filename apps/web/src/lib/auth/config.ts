/** Auth settings read from the environment (ADR-0013). Every reader takes `env` so tests can inject it. */
type Env = NodeJS.ProcessEnv;

export const SESSION_COOKIE = 'ai_obs_session';
export const SIGNUP_COOKIE = 'ai_obs_signup';
export const OAUTH_COOKIE = 'ai_obs_oauth';

const MINUTE = 60_000;
export const SESSION_TTL_MS = 30 * 24 * 60 * MINUTE;
/** The DB expiry slides at most once per this interval (avoids a write per request). */
export const SESSION_SLIDE_EVERY_MS = 60 * MINUTE;
export const MAGIC_LINK_TTL_MS = 15 * MINUTE;
export const SIGNUP_TTL_MS = 30 * MINUTE;
export const OAUTH_TTL_MS = 10 * MINUTE;

/** Public base URL. Redirects and e-mailed links are built from it, never from the Host header. */
export function appUrl(env: Env = process.env): URL {
  return new URL(env.APP_URL || 'http://localhost:3000');
}

/** Cookies get `Secure` whenever the app is served over https. */
export function isSecure(env: Env = process.env): boolean {
  return appUrl(env).protocol === 'https:';
}

export function superAdminEmails(env: Env = process.env): Set<string> {
  return new Set(
    (env.SUPER_ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The server is missing auth configuration it cannot run without (e.g. a placeholder SESSION_SECRET
 * in production). Route handlers turn it into /login?error=config instead of a bare 500.
 */
export class AuthConfigError extends Error {
  override name = 'AuthConfigError';
}

let configErrorLogged = false;

/** Logs an AuthConfigError once per process (every sign-in attempt would hit it again). */
export function reportAuthConfigError(err: AuthConfigError): void {
  if (configErrorLogged) return;
  configErrorLogged = true;
  console.error(`auth is misconfigured: ${err.message}`);
}

/**
 * HMAC key for the short-lived signed cookies (sign-up, OAuth state). Production requires a real
 * SESSION_SECRET (throws AuthConfigError); dev falls back to a fixed value (it must be identical
 * across Next's server bundles).
 */
export function sessionSecret(env: Env = process.env): string {
  const s = env.SESSION_SECRET;
  const real = !!s && s.length >= 16 && !s.startsWith('change-me');
  if (real) return s;
  if (env.NODE_ENV === 'production') {
    throw new AuthConfigError('SESSION_SECRET must be set to a long random string (e.g. `openssl rand -base64 48`)');
  }
  return s || 'ai-obs-insecure-dev-secret';
}

/**
 * Reverse proxies in front of the app that append the client address to X-Forwarded-For
 * (TRUSTED_PROXY_HOPS, default 1, 0–10). 0 = do not trust X-Forwarded-For at all.
 */
export function trustedProxyHops(env: Env = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

export type OAuthProvider = 'google' | 'github';
export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['google', 'github'];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

export function oauthCredentials(provider: OAuthProvider, env: Env = process.env) {
  const prefix = provider.toUpperCase();
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function enabledOAuthProviders(env: Env = process.env): OAuthProvider[] {
  return OAUTH_PROVIDERS.filter((p) => oauthCredentials(p, env));
}
