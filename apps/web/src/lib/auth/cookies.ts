import { isSecure, OAUTH_TTL_MS, SESSION_TTL_MS } from './config';

/** Options for the cookies this module sets. httpOnly + SameSite=Lax always; Secure on https. */
export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

function options(maxAgeMs: number, env: NodeJS.ProcessEnv): CookieOptions {
  return { httpOnly: true, secure: isSecure(env), sameSite: 'lax', path: '/', maxAge: Math.floor(maxAgeMs / 1000) };
}

export const sessionCookieOptions = (env: NodeJS.ProcessEnv = process.env) => options(SESSION_TTL_MS, env);
export const oauthCookieOptions = (env: NodeJS.ProcessEnv = process.env) => options(OAUTH_TTL_MS, env);
/** Same attributes with maxAge 0: deletes the cookie. */
export const expiredCookieOptions = (env: NodeJS.ProcessEnv = process.env) => options(0, env);
