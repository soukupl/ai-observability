import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { deleteModelPriceAction, saveModelPriceAction } from '@/lib/admin/actions/settings';
import { requireAdminPage } from '@/lib/admin/guard';
import { listModelPrices } from '@/lib/admin/model-prices';
import { withUserDb } from '@/lib/auth/rls';
import { ActionForm } from '../_components/ActionForm';
import { Confirm } from '../_components/Confirm';
import { inputCls, labelCls, noteCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from '../_components/ui';

export const metadata = { title: 'Model prices' };

const PRICE_FIELDS = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
] as const;

/** API list prices (USD per million tokens) that ≈ cost is computed with; every change is audited (ADR-0028 E8). */
export default async function ModelPricesPage() {
  const user = await requireAdminPage();
  const prices = await withUserDb(user, (tx) => listModelPrices(tx));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Model prices"
        description="USD per million tokens, effective from a date. Costs use the price in effect on the usage date. Saving a model and date that exists replaces that row."
      />
      <Card title="Add or replace a price">
        <ActionForm action={saveModelPriceAction} submitLabel="Save price">
          <label className={`${labelCls} grow sm:max-w-xs`}>
            Model
            <input name="model" required maxLength={120} placeholder="e.g. claude-sonnet-4-5" className={`${inputCls} font-mono`} />
          </label>
          <label className={labelCls}>
            Effective from
            <input type="date" name="effectiveFrom" required defaultValue={today} className={inputCls} />
          </label>
          {PRICE_FIELDS.map(([name, label]) => (
            <label key={name} className={`${labelCls} w-28`}>
              {label}
              <input type="number" name={name} required min="0" step="any" className={inputCls} />
            </label>
          ))}
        </ActionForm>
        <p className={`mt-2 ${noteCls}`}>
          Defaults are added at migration time, and a deleted default comes back at the next migration (edits are kept). A model without any price shows no cost.
        </p>
      </Card>
      <Card title={`Prices (${prices.length})`}>
        {prices.length === 0 ? (
          <p className={noteCls}>No prices.</p>
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800">
                  {['Model', 'From', 'Input', 'Output', 'Cache read', 'Cache write', ''].map((h) => (
                    <th key={h} className={thCls}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.id} className={trCls}>
                    <td className={`${tdCls} font-mono text-xs`}>{p.model}</td>
                    <td className={`${tdCls} whitespace-nowrap`}>{p.effectiveFrom}</td>
                    <td className={`${tdCls} tabular-nums`}>{p.input}</td>
                    <td className={`${tdCls} tabular-nums`}>{p.output}</td>
                    <td className={`${tdCls} tabular-nums`}>{p.cacheRead}</td>
                    <td className={`${tdCls} tabular-nums`}>{p.cacheWrite}</td>
                    <td className={tdCls}>
                      <Confirm label="Delete…" warning={
                          p.isDefault
                            ? `Delete the ${p.model} price from ${p.effectiveFrom}? It is a built-in default: the next migration adds it back. To change it for good, save new prices for the same model and date instead.`
                            : `Delete the ${p.model} price from ${p.effectiveFrom}?`
                        } action={deleteModelPriceAction} confirmLabel="Delete price">
                        <input type="hidden" name="priceId" value={p.id} />
                      </Confirm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
