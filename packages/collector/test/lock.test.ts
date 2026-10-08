import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tryLock } from '../src/lock.js';
import { cleanupHomes, tmpHome } from './helpers.js';

afterEach(cleanupHomes);

describe('tryLock (C24)', () => {
  it('a live holder refreshes its lock, so a long run is not taken over by age', async () => {
    const path = join(tmpHome().root, 'worker.lock');
    const release = tryLock(path, 4000)!; // heartbeat every second
    expect(release).toBeTypeOf('function');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old); // as if the run had lasted longer than staleMs
    await new Promise((r) => setTimeout(r, 1300));
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(2000);
    expect(tryLock(path, 4000)).toBeNull();
    release();
    expect(existsSync(path)).toBe(false);
  });

  it('release removes the lock only while it is still the holder’s', () => {
    const path = join(tmpHome().root, 'worker.lock');
    const release = tryLock(path)!;
    writeFileSync(path, `${process.pid} ${new Date().toISOString()} someone-else`); // taken over meanwhile
    release();
    expect(readFileSync(path, 'utf8')).toContain('someone-else');
  });
});
