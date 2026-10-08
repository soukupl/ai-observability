import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, parseBearer } from '../../src/lib/ingest/tokens';

describe('ingest tokens', () => {
  it('hashes to stable lower-case hex sha256', () => {
    expect(hashToken('aiobs_u_abc')).toBe(hashToken('aiobs_u_abc'));
    expect(hashToken('aiobs_u_abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('aiobs_u_abc')).not.toBe(hashToken('aiobs_u_abd'));
    // sha256("abc")
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it.each([
    ['user', 'aiobs_u_'],
    ['company', 'aiobs_c_'],
  ] as const)('generates a %s token with prefix, display prefix and hash', (kind, prefix) => {
    const t = generateToken(kind);
    expect(t.kind).toBe(kind);
    expect(t.plaintext.startsWith(prefix)).toBe(true);
    expect(t.plaintext.length).toBe(prefix.length + 43); // 32 bytes base64url
    expect(t.plaintext.slice(prefix.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.prefix).toBe(t.plaintext.slice(0, prefix.length + 4));
    expect(t.hash).toBe(hashToken(t.plaintext));
    expect(t.hash).not.toContain(t.plaintext.slice(prefix.length));
  });

  it('generates unique tokens', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateToken('user').plaintext));
    expect(seen.size).toBe(50);
  });

  it('parses Bearer headers and rejects anything else', () => {
    expect(parseBearer('Bearer aiobs_u_xyz')).toEqual({ token: 'aiobs_u_xyz', kind: 'user' });
    expect(parseBearer('bearer aiobs_c_xyz')).toEqual({ token: 'aiobs_c_xyz', kind: 'company' });
    // The retired team-scoped prefix is not an ai-obs token any more (ADR-0022).
    expect(parseBearer('Bearer aiobs_t_xyz')).toBeNull();
    expect(parseBearer('Bearer aiobs_c_')).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer('Bearer ')).toBeNull();
    expect(parseBearer('Bearer aiobs_u_')).toBeNull();
    expect(parseBearer('Basic aiobs_u_xyz')).toBeNull();
    expect(parseBearer('Bearer ghp_xyz')).toBeNull();
    expect(parseBearer(`Bearer aiobs_u_${'x'.repeat(300)}`)).toBeNull();
  });
});
