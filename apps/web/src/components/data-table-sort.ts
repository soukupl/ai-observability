import type { CostValue } from '../lib/cost';
import { formatModel } from '../lib/model-name';

/**
 * How a cell value is shown. Rows are plain serializable objects (a server page passes them to this
 * client component), so formatting is chosen by `kind` instead of a render function.
 *   text      string | null
 *   model     raw model id; shown as "Opus 5.5" (raw id on hover), sorted by that name
 *   int       number
 *   tokens    number              compact: 1.2k, 3.4M
 *   cost      CostValue | number  "≈ $1.23", "n/a" when unknown
 *   percent   fraction 0..1
 *   duration  milliseconds
 *   datetime  epoch milliseconds (UTC)
 *   outcome   success | failed | abandoned | unknown
 *   sparkline number[]
 */
export type CellKind = 'text' | 'model' | 'int' | 'tokens' | 'cost' | 'percent' | 'duration' | 'datetime' | 'outcome' | 'sparkline';

/** Sort key of a cell: empty values are null (always sorted last), strings compare lowercased. */
export function sortValue(kind: CellKind, v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'cost':
      return typeof v === 'number' ? v : (v as CostValue).usd;
    case 'sparkline':
      return (v as number[]).reduce((a, b) => a + b, 0);
    case 'text':
    case 'outcome':
      return String(v).toLowerCase();
    case 'model':
      return v === '' ? null : formatModel(String(v)).toLowerCase();
    default:
      return typeof v === 'number' ? v : Number(v);
  }
}
