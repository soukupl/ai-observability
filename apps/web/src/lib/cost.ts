/**
 * Estimated cost at API list prices (BRIEF §7 "Cost"): token counts x the `model_prices` row that
 * was effective on the day. Computed at query time, never stored; always shown as "≈".
 *
 * Token convention (packages/db): input excludes cache reads/writes; reasoning is part of output
 * and is never billed separately. Prices are USD per million tokens. The SQL function
 * estimate_cost_usd() uses the same rule; TS is used so one price book serves a whole request.
 */

export interface PriceRow {
  model: string;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Cost of one group of tokens; `usd` is null (and `unknown` true) when no price was effective. */
export interface CostResult {
  usd: number | null;
  unknown: boolean;
}

/** Cost of many groups. `usd` null = every group had an unknown model ("n/a"); `partial` = some did. */
export interface CostValue {
  usd: number | null;
  partial: boolean;
  unknownModels: string[];
}

export class PriceBook {
  private readonly byModel = new Map<string, PriceRow[]>();

  constructor(rows: PriceRow[]) {
    for (const r of rows) {
      const list = this.byModel.get(r.model) ?? [];
      list.push(r);
      this.byModel.set(r.model, list);
    }
    for (const list of this.byModel.values()) list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  }

  /**
   * The latest row whose effective_from is on or before `day` (YYYY-MM-DD); for a day before the model's
   * earliest row, that earliest row (DP-03; same rule as estimate_cost_usd and priceInEffect()). Null for
   * a model with no price rows.
   */
  priceFor(model: string | null | undefined, day: string): PriceRow | null {
    if (!model) return null;
    const list = this.byModel.get(model);
    if (!list) return null;
    let found: PriceRow | null = null;
    for (const r of list) {
      if (r.effectiveFrom <= day) found = r;
      else break;
    }
    return found ?? list[0] ?? null;
  }

  cost(model: string | null | undefined, day: string, t: CostTokens): CostResult {
    const p = this.priceFor(model, day);
    if (!p) return { usd: null, unknown: true };
    const usd =
      (t.input * p.inputPerMtok + t.output * p.outputPerMtok + t.cacheRead * p.cacheReadPerMtok + t.cacheWrite * p.cacheWritePerMtok) /
      1_000_000;
    return { usd, unknown: false };
  }

  /** Models that have at least one price row. */
  models(): string[] {
    return [...this.byModel.keys()].sort();
  }
}

/** Adds up costs of many (model, day, tokens) groups. */
export class CostSum {
  private known = 0;
  private usd = 0;
  private readonly unknownSet = new Set<string>();
  private unknownGroups = 0;

  constructor(private readonly book: PriceBook) {}

  add(model: string | null | undefined, day: string, t: CostTokens): CostResult {
    const r = this.book.cost(model, day, t);
    if (r.unknown) {
      this.unknownGroups += 1;
      this.unknownSet.add(model || '(none)');
    } else {
      this.known += 1;
      this.usd += r.usd ?? 0;
    }
    return r;
  }

  value(): CostValue {
    const unknownModels = [...this.unknownSet].sort();
    if (this.unknownGroups > 0 && this.known === 0) return { usd: null, partial: false, unknownModels };
    return { usd: this.usd, partial: this.unknownGroups > 0, unknownModels };
  }
}

/** A cost with nothing in it (no usage): $0, not "n/a". */
export const ZERO_COST: CostValue = { usd: 0, partial: false, unknownModels: [] };
