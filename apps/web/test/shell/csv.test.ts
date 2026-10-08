import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvEscape, csvStream, toCsv } from '../../src/lib/csv';
import { EXPORT_VIEWS, isExportView } from '../../src/lib/queries/exports';

describe('csv', () => {
  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('cr\rhere')).toBe('"cr\rhere"');
  });

  it('renders numbers, booleans, null and undefined', () => {
    expect(csvEscape(12.5)).toBe('12.5');
    expect(csvEscape(-3)).toBe('-3');
    expect(csvEscape(Number.NaN)).toBe('');
    expect(csvEscape(true)).toBe('true');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('neutralises spreadsheet formulas in text', () => {
    expect(csvEscape('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvEscape('+1')).toBe("'+1");
    expect(csvEscape('-1+2')).toBe("'-1+2");
    expect(csvEscape('@cmd')).toBe("'@cmd");
    expect(csvEscape('=1,2')).toBe('"\'=1,2"');
  });

  it('writes a BOM, CRLF line ends and a header', () => {
    const out = toCsv(['a', 'b'], [[1, 'x,y'], [null, 'é']]);
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(out.slice(1)).toBe('a,b\r\n1,"x,y"\r\n,é\r\n');
    expect(toCsv(['a'], [], { bom: false })).toBe('a\r\n');
  });

  it('streams the same bytes as toCsv', async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => [i, `row ${i}, "q"`]);
    const chunks: Uint8Array[] = [];
    const reader = csvStream(['n', 'text'], rows, 100).getReader();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
    }
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(chunks));
    expect(text).toBe(toCsv(['n', 'text'], rows));
    expect(chunks.length).toBeGreaterThan(5);
  });

  it('the Agent flows view has a CSV export', () => {
    expect(EXPORT_VIEWS).toContain('flows');
    expect(isExportView('flows')).toBe(true);
  });
});
