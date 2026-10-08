import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JOB_RE, listCrashedJobs, listJobs, writeJob, type JobFile } from '../src/jobs.js';
import { ulid } from '../src/ulid.js';
import { cleanupHomes, tmpHome } from './helpers.js';

afterEach(cleanupHomes);

/** The 0.1.x worker's job pattern, copied verbatim: it must never match a job this collector writes (C25). */
const V1_JOB_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.json$/;

const job = (hook: string): JobFile => ({
  v: 1,
  harness: 'claude-code',
  hook,
  payload: { session_id: 's1' },
  cwd: '/tmp/repo',
  env: {},
  received_at: '2026-10-08T10:00:00.000Z',
});

describe('job files v2 (C25)', () => {
  it('writeJob writes <ulid>.v2.json with v: 2 and the same fields', () => {
    const dir = tmpHome().jobs;
    const file = writeJob(dir, job('Stop'));
    expect(basename(file)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.v2\.json$/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...job('Stop'), v: 2 });
  });

  it('the 0.1.x job pattern does not match a v2 name; the new pattern matches both', () => {
    const dir = tmpHome().jobs;
    const v2 = basename(writeJob(dir, job('Stop')));
    expect(V1_JOB_RE.test(v2)).toBe(false);
    expect(JOB_RE.test(v2)).toBe(true);
    expect(JOB_RE.test(`${ulid()}.json`)).toBe(true);
    expect(JOB_RE.test(`${ulid()}.v3.json`)).toBe(false);
    expect(JOB_RE.test(`${ulid()}.json.processing`)).toBe(false);
  });

  it('listJobs returns v1 and v2 jobs in ULID order', () => {
    const dir = tmpHome().jobs;
    const t = Date.now();
    const a = writeJob(dir, job('A'), t);
    const v1Name = `${ulid(t + 1)}.json`; // the 0.1.x hook, between two new jobs
    writeFileSync(join(dir, v1Name), JSON.stringify(job('B')));
    const c = writeJob(dir, job('C'), t + 2);
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(listJobs(dir).map((f) => basename(f))).toEqual([basename(a), v1Name, basename(c)]);
  });

  it('listCrashedJobs finds both versions', () => {
    const dir = tmpHome().jobs;
    const v2 = writeJob(dir, job('A'));
    renameSync(v2, `${v2}.processing`);
    const v1 = join(dir, `${ulid()}.json`);
    writeFileSync(`${v1}.processing`, '{}');
    expect(listCrashedJobs(dir).map((f) => basename(f)).sort()).toEqual([`${basename(v2)}.processing`, `${basename(v1)}.processing`].sort());
    expect(listJobs(dir)).toEqual([]);
  });
});
