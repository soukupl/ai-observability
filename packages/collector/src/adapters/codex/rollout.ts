import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Incremental rollout reader. Codex appends one JSON object per line; we only consume COMPLETE lines
 * (ending in "\n"), so a line being written is picked up next time. The cursor is a byte offset.
 */
export interface ReadResult {
  lines: string[];
  /** offset after the last complete line */
  offset: number;
  /** the file shrank below the cursor (rewritten / migrated): caller re-reads from 0 */
  reset: boolean;
}

const CHUNK = 1 << 20;
/** Cap per read so one huge rollout cannot stall the worker; the rest is read on the next hook. */
const MAX_BYTES_PER_READ = 64 << 20;

export function readNewLines(path: string, offset: number): ReadResult {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { lines: [], offset, reset: false };
  }
  try {
    const size = fstatSync(fd).size;
    const reset = size < offset;
    let pos = reset ? 0 : offset;
    const lines: string[] = [];
    let carry = Buffer.alloc(0);
    let consumed = pos;
    const buf = Buffer.alloc(CHUNK);
    while (pos < size && pos - offset < MAX_BYTES_PER_READ) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      let data = Buffer.concat([carry, buf.subarray(0, n)]);
      let nl = data.indexOf(0x0a);
      while (nl >= 0) {
        const line = data.subarray(0, nl).toString('utf8').trim();
        consumed += nl + 1;
        if (line) lines.push(line);
        data = data.subarray(nl + 1);
        nl = data.indexOf(0x0a);
      }
      carry = Buffer.from(data);
    }
    return { lines, offset: consumed, reset };
  } finally {
    closeSync(fd);
  }
}

/** First line of a file (the rollout's session_meta), read in chunks up to 8 MB; null when missing. */
export function readFirstLine(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const parts: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    for (let pos = 0; pos < 8 << 20; ) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      parts.push(Buffer.from(buf.subarray(0, nl >= 0 ? nl : n)));
      if (nl >= 0) break;
      pos += n;
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
