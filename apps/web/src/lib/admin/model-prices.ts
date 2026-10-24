import { eq, sql } from 'drizzle-orm';
import { DEFAULT_MODEL_PRICES, modelPrices, type Tx } from '@ai-obs/db';
import { z } from 'zod';
import { rows } from '../queries/sqlutil';
import { audit } from './audit';
import { id, parse } from './input';
import { isAdmin } from './permissions';
import { ensure, type Actor } from './types';

/**
 * Model prices (USD per million tokens, effective from a date) that ≈ cost is computed with at query time. Admins edit
 * them (ADR-0028 E8, audited); ensureDefaultModelPrices keeps adding missing defaults at migration time, so deleting a
 * default row lasts only until the next migration (edits are kept: the seed never overwrites).
 */
export interface ModelPriceRow {
  id: string;
  model: string;
  effectiveFrom: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A built-in default (DEFAULT_MODEL_PRICES): ensureDefaultModelPrices re-adds it at the next migration if deleted. */
  isDefault: boolean;
}

/** Pure: whether a model + date is one of the built-in defaults that every migration re-adds when missing. */
export function isDefaultModelPrice(model: string, effectiveFrom: string): boolean {
  return DEFAULT_MODEL_PRICES.some((d) => d.model === model && d.effectiveFrom === effectiveFrom);
}

export async function listModelPrices(tx: Tx): Promise<ModelPriceRow[]> {
  const list = await rows<{ id: string; model: string; effective_from: string; input: string; output: string; cache_read: string; cache_write: string }>(
    tx,
    sql`select id, model, effective_from::text as effective_from, input_per_mtok as input, output_per_mtok as output,
          cache_read_per_mtok as cache_read, cache_write_per_mtok as cache_write
        from model_prices where currency = 'USD' order by model, effective_from desc`,
  );
  return list.map((p) => ({
    id: p.id,
    model: p.model,
    effectiveFrom: p.effective_from,
    input: Number(p.input),
    output: Number(p.output),
    cacheRead: Number(p.cache_read),
    cacheWrite: Number(p.cache_write),
    isDefault: isDefaultModelPrice(p.model, p.effective_from),
  }));
}

const price = z.coerce.number().min(0, 'must be 0 or more').max(100_000, 'too large');
export const modelPriceInput = z.object({
  model: z.string().trim().min(1, 'required').max(120, 'at most 120 characters'),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD'),
  input: price,
  output: price,
  cacheRead: price,
  cacheWrite: price,
});

const dec = (n: number) => n.toFixed(4);

/** Adds a price row, or replaces the one for the same model and date. */
export async function saveModelPrice(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only admins can change model prices.');
  const p = parse(modelPriceInput, input);
  const values = {
    inputPerMtok: dec(p.input),
    outputPerMtok: dec(p.output),
    cacheReadPerMtok: dec(p.cacheRead),
    cacheWritePerMtok: dec(p.cacheWrite),
  };
  const [before] = await rows<{ id: string; input: string; output: string; cache_read: string; cache_write: string }>(
    tx,
    sql`select id, input_per_mtok as input, output_per_mtok as output, cache_read_per_mtok as cache_read, cache_write_per_mtok as cache_write
        from model_prices where model = ${p.model} and effective_from = ${p.effectiveFrom}::date`,
  );
  const [row] = await tx
    .insert(modelPrices)
    .values({ model: p.model, effectiveFrom: p.effectiveFrom, currency: 'USD', ...values })
    .onConflictDoUpdate({ target: [modelPrices.model, modelPrices.effectiveFrom], set: values })
    .returning({ id: modelPrices.id });
  await audit(tx, actor, before ? 'model_price.update' : 'model_price.create', `model_price:${row!.id}`, {
    model: p.model,
    effectiveFrom: p.effectiveFrom,
    ...(before
      ? { before: { input: Number(before.input), output: Number(before.output), cacheRead: Number(before.cache_read), cacheWrite: Number(before.cache_write) } }
      : {}),
    after: { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite },
  });
  return before ? `Price of ${p.model} from ${p.effectiveFrom} updated.` : `Price of ${p.model} from ${p.effectiveFrom} added.`;
}

export async function deleteModelPrice(tx: Tx, actor: Actor, input: unknown): Promise<string> {
  ensure(isAdmin(actor), 'Only admins can change model prices.');
  const { priceId } = parse(z.object({ priceId: id }), input);
  const gone = await tx
    .delete(modelPrices)
    .where(eq(modelPrices.id, priceId))
    .returning({ model: modelPrices.model, effectiveFrom: modelPrices.effectiveFrom });
  ensure(gone.length === 1, 'Price not found.');
  const { model, effectiveFrom } = gone[0]!;
  const isDefault = isDefaultModelPrice(model, effectiveFrom);
  await audit(tx, actor, 'model_price.delete', `model_price:${priceId}`, { model, effectiveFrom, ...(isDefault ? { default: true } : {}) });
  return isDefault
    ? `Price of ${model} from ${effectiveFrom} deleted. It is a built-in default, so the next migration (deploy) adds it back; to change it for good, save new prices for the same model and date instead.`
    : `Price of ${model} from ${effectiveFrom} deleted. Turns of that model now use the previous price, or none.`;
}
