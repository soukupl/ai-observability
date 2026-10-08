import type { ReactNode } from 'react';
import { Card } from '@/components/Card';
import { PageHeader } from '@/components/PageHeader';
import { updateSettingsAction } from '@/lib/admin/actions/company';
import { loadCompany } from '@/lib/admin/company';
import { RUNAWAY_BOUNDS, RUNAWAY_DEFAULTS } from '@ai-obs/db';
import { requireAdminPage } from '@/lib/admin/guard';
import { retentionBounds } from '@/lib/admin/plans';
import { withUserDb } from '@/lib/auth/rls';
import { CompanyScopeProvider } from '../_components/CompanyScope';
import { ActionForm } from '../_components/ActionForm';
import { inputCls, labelCls, noteCls } from '../_components/ui';

export const metadata = { title: 'Settings' };

function Radio({ name, value, checked, title, children }: { name: string; value: string; checked: boolean; title: string; children: ReactNode }) {
  return (
    <label className="flex gap-2 rounded-md border border-zinc-200 p-3 text-sm has-checked:border-zinc-900 dark:border-zinc-800 dark:has-checked:border-zinc-100">
      <input type="radio" name={name} value={value} defaultChecked={checked} className="mt-1" />
      <span>
        <span className="font-medium">{title}</span>
        <span className={`block ${noteCls}`}>{children}</span>
      </span>
    </label>
  );
}

export default async function SettingsPage() {
  const user = await requireAdminPage();
  const company = await withUserDb(user, (tx) => loadCompany(tx, user.companyId));
  const s = company.settings;
  const { min, max } = retentionBounds(company.plan);

  return (
    <CompanyScopeProvider companyId={user.companyId}>
      <div className="space-y-4">
        <PageHeader title="Settings" description="Company-wide. Every change is written to the audit log." />
        <Card>
          <ActionForm action={updateSettingsAction} submitLabel="Save settings" className="space-y-6">
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold">Individual visibility</legend>
              <p className={noteCls}>The active mode is shown to every user (banner on the dashboard and a line in the footer). Everyone always sees their own detail.</p>
              <div className="grid gap-2 md:grid-cols-2">
                <Radio name="individualVisibility" value="aggregates-only" checked={s.individualVisibility === 'aggregates-only'} title="Aggregates only (default)">
                  Leads and admins see totals by team, project, model, phase and agent, but no per-person rows, no per-person turn lists and no names on turns.
                </Radio>
                <Radio name="individualVisibility" value="full" checked={s.individualVisibility === 'full'} title="Full detail">
                  Leads see every turn of their teams by person; admins see the whole company by person. Tell your people before you switch.
                </Radio>
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold">Project naming</legend>
              <div className="grid gap-2 md:grid-cols-2">
                <Radio name="projectNaming" value="plain" checked={s.projectNaming === 'plain'} title="Plain">
                  Projects are keyed by the normalized git remote (for example github.com/acme/billing).
                </Radio>
                <Radio name="projectNaming" value="hashed" checked={s.projectNaming === 'hashed'} title="Hashed">
                  Collectors send a SHA-256 of the remote instead; name projects on the Projects page.
                </Radio>
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Switching to hashed applies to new data only: projects already stored with a plain key keep it. Collectors pick up the change within their config cache time.
              </p>
            </fieldset>
            <fieldset>
              <legend className="mb-1 text-sm font-semibold">Raw data retention</legend>
              <label className={`${labelCls} max-w-48`}>
                Days ({min}–{max} on the {company.plan} plan)
                <input type="number" name="retentionDays" required min={min} max={max} step={1} defaultValue={Math.min(s.retentionDays, max)} className={inputCls} />
              </label>
              <p className={`mt-1 ${noteCls}`}>
                Sessions, turns, runs and usage older than this are deleted nightly. Daily rollups (no summaries) are kept indefinitely. Default 395 days (13 months).
                {s.retentionDays > max && ` The stored value (${s.retentionDays}) is above the plan maximum.`}
              </p>
            </fieldset>
            <fieldset>
              <legend className="mb-1 text-sm font-semibold">Runaway alerts</legend>
              <p className={noteCls}>
                After a turn ends, it is flagged when it used far more tokens than its user usually does, when its ≈ cost reaches the
                limit below, or when it ran at least the hours below with above-normal tokens. The user is e-mailed (leads too in full
                mode; admins get an anonymous digest in aggregates-only mode), at most one digest per hour. Nothing is blocked.
              </p>
              <div className="mt-2 flex flex-wrap gap-4">
                <label className={`${labelCls} max-w-48`}>
                  ≈ Cost per turn (USD)
                  <input
                    type="number" name="runawayCostUsd" min={RUNAWAY_BOUNDS.costUsd[0]} max={RUNAWAY_BOUNDS.costUsd[1]} step="any"
                    defaultValue={s.runawayCostUsd ?? RUNAWAY_DEFAULTS.costUsd} className={inputCls}
                  />
                </label>
                <label className={`${labelCls} max-w-48`}>
                  Turn duration (hours)
                  <input
                    type="number" name="runawayHours" min={RUNAWAY_BOUNDS.hours[0]} max={RUNAWAY_BOUNDS.hours[1]} step="0.5"
                    defaultValue={s.runawayHours ?? RUNAWAY_DEFAULTS.hours} className={inputCls}
                  />
                </label>
              </div>
            </fieldset>
          </ActionForm>
        </Card>
      </div>
    </CompanyScopeProvider>
  );
}
