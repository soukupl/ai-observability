import { createHash, createHmac, randomBytes } from 'node:crypto';
import { linkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { ensureDir } from './fsutil.js';
import { gitRemoteUrl, gitTopLevel } from './git.js';
import type { ProjectNamingMode, ProjectRef } from './protocol-types.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');

/** Keys for hashed project references (SEC-11: plain sha256 of a guessable string is reversible). */
export interface ProjectKeySecrets {
  /**
   * Local per-machine secret for the no-remote fallback (`HMAC(secret, "path:" + absPath)`). It
   * never leaves the machine, so the server cannot reverse the key to a home-directory path.
   */
  pathSecret?: string | null;
  /**
   * Per-company salt from GET /api/v1/collector-config (`project_salt`) for hashed-mode remotes
   * (`HMAC(salt, remote)`): the same on every machine of the company, so keys still agree.
   */
  projectSalt?: string | null;
}

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

/**
 * Project reference for the ingest format. Plain mode: normalized remote + last segment as name.
 * Hashed mode: `sha256:` + hash of the normalized remote, no name — HMAC-SHA256 keyed by the
 * company's `projectSalt` when the server provides one, else plain sha256 (reversible with a
 * dictionary of org/repo names; see README). No (usable) remote: `sha256:` + HMAC of the absolute
 * path keyed by the local `pathSecret`, in both modes — the path never leaves the machine and the key
 * cannot be reversed without the secret. (Without a secret: plain sha256, the pre-SEC-11 key.)
 */
export function projectRef(input: { remote: string | null; absPath: string; naming: ProjectNamingMode } & ProjectKeySecrets): ProjectRef {
  const normalized = input.remote ? normalizeRemote(input.remote) : null;
  if (!normalized) {
    const path = `path:${input.absPath}`;
    return { key: `sha256:${input.pathSecret ? hmac(input.pathSecret, path) : sha256(path)}` };
  }
  if (input.naming === 'hashed') return { key: `sha256:${input.projectSalt ? hmac(input.projectSalt, normalized) : sha256(normalized)}` };
  const name = basename(normalized).slice(0, 200);
  return name ? { key: normalized, name } : { key: normalized };
}

/** Resolves the project of a working directory via git (never throws). */
export async function resolveProject(cwd: string, naming: ProjectNamingMode, secrets: ProjectKeySecrets = {}): Promise<ProjectRef> {
  const [top, remote] = await Promise.all([gitTopLevel(cwd), gitRemoteUrl(cwd)]);
  return projectRef({ remote, absPath: top ?? cwd, naming, ...secrets });
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
