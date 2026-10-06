import { decodeIdToken, generateCodeVerifier, generateState, GitHub, Google } from 'arctic';
import { appUrl, oauthCredentials, type OAuthProvider } from './config';

/** Google / GitHub OAuth via arctic (ADR-0013). Callback: ${APP_URL}/api/auth/<provider>/callback. */

export interface OAuthStart {
  url: URL;
  state: string;
  codeVerifier: string | null;
}

export interface OAuthIdentity {
  accountId: string;
  email: string;
  name: string | null;
}

const callbackUrl = (provider: OAuthProvider, env: NodeJS.ProcessEnv) =>
  new URL(`/api/auth/${provider}/callback`, appUrl(env)).toString();

function client(provider: OAuthProvider, env: NodeJS.ProcessEnv) {
  const creds = oauthCredentials(provider, env);
  if (!creds) return null;
  return provider === 'google'
    ? { provider, google: new Google(creds.clientId, creds.clientSecret, callbackUrl(provider, env)) }
    : { provider, github: new GitHub(creds.clientId, creds.clientSecret, callbackUrl(provider, env)) };
}

/** Authorization URL plus the state (and PKCE verifier for Google) to keep in a cookie; null if not configured. */
export function startOAuth(provider: OAuthProvider, env: NodeJS.ProcessEnv = process.env): OAuthStart | null {
  const c = client(provider, env);
  if (!c) return null;
  const state = generateState();
  if (c.google) {
    const codeVerifier = generateCodeVerifier();
    return { url: c.google.createAuthorizationURL(state, codeVerifier, ['openid', 'email', 'profile']), state, codeVerifier };
  }
  return { url: c.github!.createAuthorizationURL(state, ['read:user', 'user:email']), state, codeVerifier: null };
}

/**
 * Exchanges the code and returns the account with a **verified** e-mail, or null (unverified /
 * missing e-mail, provider error). Only verified e-mails may link to or create users.
 */
export async function finishOAuth(
  provider: OAuthProvider,
  code: string,
  codeVerifier: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OAuthIdentity | null> {
  const c = client(provider, env);
  if (!c) return null;
  if (c.google) {
    if (!codeVerifier) return null;
    const tokens = await c.google.validateAuthorizationCode(code, codeVerifier);
    const claims = decodeIdToken(tokens.idToken()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!claims.sub || !claims.email || claims.email_verified !== true) return null;
    return { accountId: claims.sub, email: claims.email, name: claims.name ?? null };
  }
  const tokens = await c.github!.validateAuthorizationCode(code);
  const headers = { Authorization: `Bearer ${tokens.accessToken()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ai-obs' };
  const [userRes, emailsRes] = await Promise.all([
    fetch('https://api.github.com/user', { headers }),
    fetch('https://api.github.com/user/emails', { headers }),
  ]);
  if (!userRes.ok || !emailsRes.ok) return null;
  const user = (await userRes.json()) as { id?: number; name?: string | null; login?: string };
  const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
  const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
  if (!user.id || !primary) return null;
  return { accountId: String(user.id), email: primary.email, name: user.name || user.login || null };
}
