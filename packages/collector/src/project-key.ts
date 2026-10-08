import { createHash, createHmac, randomBytes } from 'node:crypto';
import { linkSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { ensureDir } from './fsutil.js';
import { gitRemoteUrlResult, gitRepoRootResult } from './git.js';
import type { ProjectNamingMode, ProjectRef } from './protocol-types.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');

/**
 * Normalizes a git remote to `host/path`: strips protocol, credentials / `user@`, port, `.git` and
 * trailing slashes; lowercases the host. Returns null for local remotes (paths, file://), which
 * would leak a file path.
 *
 *   git@github.com:Acme/billing.git         → github.com/Acme/billing
 *   https://u:p@GitHub.com:443/acme/x.git/  → github.com/acme/x
 */
export function normalizeRemote(remote: string): string | null {
  let s = remote.trim();
  if (!s) return null;
  let host: string;
  let path: string;
  const urlMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (urlMatch) {
    const scheme = (urlMatch[1] ?? '').toLowerCase();
    if (scheme === 'file') return null;
    s = urlMatch[2] ?? '';
    const slash = s.indexOf('/');
    const authority = slash < 0 ? s : s.slice(0, slash);
    path = slash < 0 ? '' : s.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf('@') + 1);
    // ssh://git@host:org/repo (scp-ish inside a URL): a non-numeric "port" is really the path start.
    const colon = host.lastIndexOf(':');
    if (colon >= 0 && !host.startsWith('[')) {
      const port = host.slice(colon + 1);
      if (port && !/^\d+$/.test(port)) path = `${port}/${path}`;
      host = host.slice(0, colon);
    }
  } else {
    // scp-like: [user@]host:path — but not a Windows drive (C:\…) or a plain local path.
    const scp = /^(?:[^@/\\]+@)?([^:/\\\s]+):(?!\/\/)(.+)$/.exec(s);
    if (!scp || /^[a-z]$/i.test(scp[1] ?? '')) return null;
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  }
  host = host.toLowerCase().replace(/\.$/, '');
  path = path
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!host || !path || !/^[a-z0-9.-]+$/.test(host) || /\s/.test(path)) return null;
  return `${host}/${path}`;
}

/** Default git budget of a key resolution outside the hook (worker, sender, `use`): latency does not matter there (C16). */
export const RESOLVE_TIMEOUT_MS = 5000;

/**
 * The plain project key of a working directory (Q4, C2): the normalized git remote, else the git
 * top-level (of the main checkout, for a linked worktree), else `realpath(cwd)` outside a repo
 * (`path.resolve(cwd)` when the directory is gone). Local only, never sent as such (sendRef). Null only
 * when git timed out. `bounded` (the hook) kills git at the deadline instead of waiting for it (C26).
 * Never throws.
 */
export async function resolveProjectKey(cwd: string, opts: { timeoutMs?: number; bounded?: boolean } = {}): Promise<string | null> {
  const d = { until: Date.now() + (opts.timeoutMs ?? RESOLVE_TIMEOUT_MS), bounded: opts.bounded === true };
  const [top, remote] = await Promise.all([gitRepoRootResult(cwd, d), gitRemoteUrlResult(cwd, d)]);
  if (top.timedOut || remote.timedOut) return null;
  const normalized = remote.out ? normalizeRemote(remote.out) : null;
  if (normalized) return normalized;
  if (top.out && isAbsolute(top.out)) return top.out;
  try {
    return realpathSync(cwd);
  } catch {
    return resolvePath(cwd);
  }
}

/** A key that is a local path (no usable remote): always sent as a keyed hash. */
export function isPathKey(pk: string): boolean {
  return isAbsolute(pk);
}

/**
 * Send-time project reference for the receiving token (C3, contract §5.5). Path key →
 * `sha256:` + HMAC(local path secret, `path:` + path) (plain sha256 without a secret); hashed →
 * `sha256:` + HMAC(company salt, key) (plain sha256 without a salt), no name; plain → the key and its
 * last segment as name.
 */
export function sendRef(pk: string, o: { naming: ProjectNamingMode; salt?: string | null; pathSecret: string | null }): ProjectRef {
  if (isPathKey(pk)) {
    const path = `path:${pk}`;
    return { key: `sha256:${o.pathSecret ? hmac(o.pathSecret, path) : sha256(path)}` };
  }
  if (o.naming === 'hashed') return { key: `sha256:${o.salt ? hmac(o.salt, pk) : sha256(pk)}` };
  const name = basename(pk).slice(0, 200);
  return name ? { key: pk, name } : { key: pk };
}

/** What `ctx.projectKey` returns at capture (plain naming); the sender overwrites it from the stream key. */
export function localRef(pk: string, pathSecret: string | null): ProjectRef {
  return sendRef(pk, { naming: 'plain', pathSecret });
}

/**
 * The machine's path secret (32 random bytes, hex), created on first use. Creation is atomic (temp
 * file + hard link), so concurrent workers agree on one value. Null when the file cannot be read or
 * created (the caller then falls back to the unsalted key).
 */
export function loadPathSecret(file: string): string | null {
  const read = () => {
    try {
      const v = readFileSync(file, 'utf8').trim();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    ensureDir(dirname(file));
    writeFileSync(tmp, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    linkSync(tmp, file); // fails with EEXIST if another process won the race
  } catch {
    /* lost the race, or read-only home */
  }
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* nothing was written */
  }
  return read();
}
