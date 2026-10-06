import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startScheduler, type Job } from '../src/scheduler.js';

const log = { info: vi.fn(), error: vi.fn() };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('startScheduler', () => {
  it('runs on start and on every interval', async () => {
    const run = vi.fn(async () => {});
    const s = startScheduler([{ name: 'a', intervalMs: 1000, run }], log);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);
    await s.stop();
  });

  it('never overlaps a job with itself', async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    const s = startScheduler([{ name: 'slow', intervalMs: 100, run }], log);
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await s.stop();
  });

  it('keeps going after a job fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    const s = startScheduler([{ name: 'bad', intervalMs: 100, run }], log);
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalled();
    await s.stop();
  });

  it('stop() aborts and waits for running jobs, then schedules nothing more', async () => {
    let finished = false;
    const job: Job = {
      name: 'graceful',
      intervalMs: 100,
      run: (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => {
            finished = true;
            resolve();
          }),
        ),
    };
    const spy = vi.spyOn(job, 'run');
    const s = startScheduler([job], log);
    await s.stop();
    expect(finished).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
