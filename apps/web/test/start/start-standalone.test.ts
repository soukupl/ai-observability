import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { prepareStandalone } from '../../scripts/start-standalone.mjs';

describe('scripts/start-standalone.mjs (visual:V6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-obs-start-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('copies .next/static and public next to the standalone server, idempotently', () => {
    const server = join(dir, '.next', 'standalone', 'apps', 'web');
    mkdirSync(server, { recursive: true });
    writeFileSync(join(server, 'server.js'), '// server');
    mkdirSync(join(dir, '.next', 'static', 'chunks'), { recursive: true });
    writeFileSync(join(dir, '.next', 'static', 'chunks', 'a.js'), 'a');
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(join(dir, 'public', 'icon.svg'), '<svg/>');

    for (let i = 0; i < 2; i++) expect(prepareStandalone(dir)).toBe(join(server, 'server.js'));
    expect(readFileSync(join(server, '.next', 'static', 'chunks', 'a.js'), 'utf8')).toBe('a');
    expect(readFileSync(join(server, 'public', 'icon.svg'), 'utf8')).toBe('<svg/>');
  });

  it('fails with a clear message when there is no standalone build', () => {
    expect(() => prepareStandalone(join(dir, 'nowhere'))).toThrow(/No standalone build/);
  });
});
