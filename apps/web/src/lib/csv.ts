/**
 * CSV for the table exports (BRIEF §8): RFC 4180 quoting, CRLF line ends and a UTF-8 BOM so
 * Excel opens non-ASCII text correctly.
 */

export type CsvCell = string | number | boolean | null | undefined;
export const CSV_BOM = '﻿';

const NEEDS_QUOTES = /[",\r\n]/;
/** Spreadsheet formula starters; summaries are free text from a model, so neutralise them. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvEscape(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = value ? 'true' : 'false';
  else {
    s = FORMULA_START.test(value) ? `'${value}` : value;
  }
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: readonly CsvCell[]): string {
  return cells.map(csvEscape).join(',') + '\r\n';
}

/** Whole document as a string (with BOM unless `bom: false`). */
export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[], opts: { bom?: boolean } = {}): string {
  return (opts.bom === false ? '' : CSV_BOM) + csvLine(headers) + rows.map(csvLine).join('');
}

/** Streams the document in chunks so a large export never builds one huge string. */
export function csvStream(headers: readonly string[], rows: readonly (readonly CsvCell[])[], chunkRows = 500): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  let started = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(enc.encode(CSV_BOM + csvLine(headers)));
        return;
      }
      if (i >= rows.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(rows.slice(i, i + chunkRows).map(csvLine).join('')));
      i += chunkRows;
    },
  });
}
