import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildConfig,
  daysLeft,
  endpointHost,
  isExpired,
  isUserToken,
  loadConfig,
  loadConfigFile,
  maskToken,
  matchServer,
  newMachineConfig,
  normalizeEndpoint,
  removeServer,
  retiredPrefix,
  saveConfig,
  tokenFingerprint,
  upsertServer,
  type ServerEntry,
} from '../src/config.js';
import { ensureDir } from '../src/fsutil.js';
import { cleanupHomes, tmpHome } from './helpers.js';

afterEach(cleanupHomes);

const entry = (endpoint: string, token = 'aiobs_u_a', extra: Partial<ServerEntry> = {}): ServerEntry => ({
  endpoint,
  token,
  email: 'dev@acme.com',
  deployment: { name: 'SPECTADO', slug: 'spectado' },
  label: 'mac',
  expires_at: null,
  source: 'device',
  added_at: '2026-10-01T00:00:00.000Z',
  ...extra,
});

describe('tokens and endpoints', () => {
  it('accepts user tokens only; names the retired prefixes', () => {
    expect(isUserToken('aiobs_u_x')).toBe(true);
    expect(isUserToken('aiobs_u_')).toBe(false);
    expect(isUserToken('aiobs_c_x')).toBe(false);
    expect(retiredPrefix('aiobs_c_x')).toBe('aiobs_c_');
    expect(retiredPrefix('aiobs_t_x')).toBe('aiobs_t_');
    expect(retiredPrefix('aiobs_u_x')).toBeNull();
    expect(() => buildConfig({ endpoint: 'https://x.io', token: 'aiobs_c_x' })).toThrow(/aiobs_u_/);
  });

  it('maskToken keeps the 8-char prefix and the last 4 chars; fingerprints are 16 hex', () => {
    expect(maskToken('aiobs_u_0123456789abcdef')).toBe('aiobs_u_…cdef');
    expect(maskToken('aiobs_c_0123456789abcdef')).toBe('aiobs_c_…cdef');
    expect(tokenFingerprint('aiobs_u_a')).toMatch(/^[0-9a-f]{16}$/);
    expect(tokenFingerprint('aiobs_u_a')).not.toBe(tokenFingerprint('aiobs_u_b'));
  });

  it('normalizes endpoints and refuses credentials; matchServer takes a URL or a unique host', () => {
    expect(normalizeEndpoint('https://Obs.Example.com/')).toBe('https://obs.example.com');
    expect(() => normalizeEndpoint('ftp://x')).toThrow();
    expect(() => normalizeEndpoint('https://u:p@x.io')).toThrow(/credentials/);
    expect(endpointHost('http://localhost:3000')).toBe('localhost:3000');
    const config = { servers: [entry('https://obs.example.com'), entry('http://localhost:3000', 'aiobs_u_b')] };
    expect(matchServer(config, 'https://obs.example.com/')?.token).toBe('aiobs_u_a');
    expect(matchServer(config, 'localhost:3000')?.token).toBe('aiobs_u_b');
    expect(matchServer(config, 'nope.io')).toBeUndefined();
  });

  it('expiry: expired at or after expires_at; days left rounded down', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(isExpired({ expires_at: null }, now)).toBe(false);
    expect(isExpired({ expires_at: '2026-10-24T12:00:00Z' }, now)).toBe(true);
    expect(isExpired({ expires_at: '2026-10-25T12:00:00Z' }, now)).toBe(false);
    expect(daysLeft({ expires_at: '2026-11-07T11:00:00Z' }, now)).toBe(13);
    expect(daysLeft({ expires_at: null }, now)).toBeNull();
  });
});

describe('config.json v3', () => {
  it('round-trips (0600, version 3, one entry per endpoint)', () => {
    const paths = tmpHome();
    const config = { ...newMachineConfig(null), servers: [entry('https://a.io'), entry('https://b.io', 'aiobs_u_b', { email: null, source: 'manual' })] };
    saveConfig(paths, config);
    expect(statSync(paths.config).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(paths.config, 'utf8'));
    expect(raw.version).toBe(3);
    expect(Object.keys(raw.servers[0]).sort()).toEqual(['added_at', 'deployment', 'email', 'endpoint', 'expires_at', 'label', 'source', 'token']);
    expect(loadConfigFile(paths)).toEqual({ config, migration: null });
  });

  it('missing, unparsable or machine-less files are "not configured"; bad entries are skipped', () => {
    const paths = tmpHome();
    expect(loadConfig(paths)).toBeNull();
    ensureDir(paths.root);
    writeFileSync(paths.config, '{nope');
    expect(loadConfig(paths)).toBeNull();
    writeFileSync(paths.config, JSON.stringify({ version: 3, servers: [] }));
    expect(loadConfig(paths)).toBeNull();
    writeFileSync(paths.config, JSON.stringify({ version: 3, machine_id: 'm', servers: [{ endpoint: 'ftp://x', token: 'aiobs_u_a' }, { endpoint: 'https://x.io', token: 'aiobs_c_a' }, entry('https://ok.io')] }));
    expect(loadConfig(paths)!.servers.map((s) => s.endpoint)).toEqual(['https://ok.io']);
  });

  it('migrates a v2 file in memory: user tokens → servers, company tokens dropped with a note, the rest discarded', () => {
    const paths = tmpHome();
    ensureDir(paths.root);
    writeFileSync(
      paths.config,
      JSON.stringify({
        v: 2,
        endpoint: 'http://localhost:3000',
        machine_id: 'machine-1',
        created_at: '2026-01-01T00:00:00.000Z',
        git_email: 'dev@acme.com',
        tokens: [
          { name: 'acme', company: { name: 'Acme', slug: 'acme' }, email: 'dev@acme.com', endpoint: 'http://localhost:3000/', token: 'aiobs_u_acme', added_at: '2026-02-01T00:00:00.000Z', prior_fps: ['x'] },
          { name: 'globex', company: { name: 'Globex', slug: 'globex' }, endpoint: 'https://obs.globex.io', token: 'aiobs_c_globex1234567', added_at: '2026-03-01T00:00:00.000Z' },
          { name: 'plg', endpoint: 'http://localhost:3000', token: 'aiobs_u_plg', added_at: '2026-04-01T00:00:00.000Z' },
        ],
        invalid_tokens: [{ name: 'x' }],
        routing_epochs: [{ since: '2026-01-01T00:00:00.000Z', single: null }],
        legacy: { token_mask: 'aiobs_t_…', found_at: '2026-01-01T00:00:00.000Z' },
      }),
    );
    const loaded = loadConfigFile(paths)!;
    expect(loaded.config).toEqual({
      version: 3,
      machine_id: 'machine-1',
      created_at: '2026-01-01T00:00:00.000Z',
      servers: [
        // two user tokens for one endpoint (the dev DB had several companies there): the later registration wins
        { endpoint: 'http://localhost:3000', token: 'aiobs_u_plg', email: null, deployment: null, label: null, expires_at: null, source: null, added_at: '2026-04-01T00:00:00.000Z' },
      ],
    });
    expect(loaded.migration?.from).toBe(2);
    expect(loaded.migration?.notes.join('\n')).toMatch(/company token globex \(aiobs_c_…4567\) dropped/);
    expect(loaded.migration?.notes.join('\n')).toMatch(/two user tokens for http:\/\/localhost:3000/);
    // nothing written by a load
    expect(JSON.parse(readFileSync(paths.config, 'utf8')).v).toBe(2);
  });

  it('two user tokens of one server: the one projects.json used more wins, and the note names both accounts', () => {
    const paths = tmpHome();
    ensureDir(paths.root);
    const ep = 'http://localhost:3000';
    writeFileSync(
      paths.config,
      JSON.stringify({
        v: 2,
        machine_id: 'm',
        tokens: [
          { name: 'spectado', company: { name: 'SPECTADO', slug: 'spectado' }, email: 'me@gmail.com', endpoint: ep, token: 'aiobs_u_gmail', added_at: '2026-02-01T00:00:00.000Z', prior_fps: ['old-fp'] },
          { name: 'plg', company: { name: 'PLG', slug: 'plg' }, email: 'me@work.cz', endpoint: ep, token: 'aiobs_u_work', added_at: '2026-04-01T00:00:00.000Z' },
        ],
      }),
    );
    const assign = (token: string, fp: string) => ({ token, endpoint: ep, token_fp: fp, assigned_at: '2026-04-02T00:00:00.000Z' });
    writeFileSync(
      paths.legacyProjects,
      JSON.stringify({
        'github.com/a/one': assign('spectado', tokenFingerprint('aiobs_u_gmail')),
        'github.com/a/two': assign('spectado', 'old-fp'), // made before the token was rotated
        'github.com/a/three': assign('renamed', tokenFingerprint('aiobs_u_gmail')),
        'github.com/b/one': assign('plg', 'unknown-fp'), // matched by name
      }),
    );
    const loaded = loadConfigFile(paths)!;
    expect(loaded.config.servers.map((s) => [s.token, s.email])).toEqual([['aiobs_u_gmail', 'me@gmail.com']]);
    const note = loaded.migration!.notes.join('\n');
    expect(note).toContain('kept me@gmail.com (SPECTADO), used by 3 repositories in projects.json');
    expect(note).toContain('dropped me@work.cz (PLG), used by 1 repository in projects.json');
    expect(note).toContain(`run \`ai-obs login --server ${ep}\` and approve with it`);
    // the kept copy of projects.json (a migration renamed it) is read as well
    renameSync(paths.legacyProjects, `${paths.legacyProjects}.v2`);
    expect(loadConfigFile(paths)!.config.servers[0]!.token).toBe('aiobs_u_gmail');
    // without projects.json, the later registration wins
    rmSync(`${paths.legacyProjects}.v2`);
    expect(loadConfigFile(paths)!.config.servers[0]!.token).toBe('aiobs_u_work');
  });

  it('a 0.1.x flat file loads with no servers and keeps the machine identity', () => {
    const paths = tmpHome();
    ensureDir(paths.root);
    writeFileSync(paths.config, JSON.stringify({ endpoint: 'https://x.io', token: 'aiobs_t_old', machine_id: 'm1', created_at: '2026-01-01T00:00:00.000Z' }));
    expect(loadConfigFile(paths)).toMatchObject({ config: { machine_id: 'm1', servers: [] }, migration: { from: 1 } });
  });
});

describe('upsertServer / removeServer / buildConfig', () => {
  it('adds a new endpoint; the same endpoint replaces the token in place', () => {
    const base = { ...newMachineConfig(null), servers: [entry('https://a.io'), entry('https://b.io', 'aiobs_u_b')] };
    const added = upsertServer(base, entry('https://c.io', 'aiobs_u_c'));
    expect(added.kind).toBe('added');
    expect(added.config.servers.map((s) => s.endpoint)).toEqual(['https://a.io', 'https://b.io', 'https://c.io']);
    const replaced = upsertServer(base, entry('https://a.io', 'aiobs_u_new'));
    expect(replaced).toMatchObject({ kind: 'replaced', previous: { token: 'aiobs_u_a' } });
    expect(replaced.config.servers.map((s) => [s.endpoint, s.token])).toEqual([
      ['https://a.io', 'aiobs_u_new'],
      ['https://b.io', 'aiobs_u_b'],
    ]);
    expect(removeServer(base, 'https://a.io').servers.map((s) => s.endpoint)).toEqual(['https://b.io']);
  });

  it('buildConfig keeps the machine of `existing`', () => {
    const a = buildConfig({ endpoint: 'https://x.io/', token: 'aiobs_u_a' });
    expect(a.servers[0]).toMatchObject({ endpoint: 'https://x.io', token: 'aiobs_u_a', expires_at: null });
    expect(buildConfig({ endpoint: 'https://x.io', token: 'aiobs_u_b', existing: a }).machine_id).toBe(a.machine_id);
  });
});
