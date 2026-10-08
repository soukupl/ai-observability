'use client';

import { createContext, useContext, type ReactNode } from 'react';

const CompanyScopeContext = createContext<string | null>(null);

/**
 * D10: every mutating admin / token form is bound to the company it was rendered for. The active company
 * lives on the session row, which all tabs share; `runAdmin` refuses a form whose `_companyId` differs.
 * Render it in each PAGE from that page's own user, never in a shared layout: layouts are not re-rendered on
 * client navigation, so a layout-level scope can describe another company than the page beneath it.
 */
export function CompanyScopeProvider({ companyId, children }: { companyId: string; children: ReactNode }) {
  return <CompanyScopeContext.Provider value={companyId}>{children}</CompanyScopeContext.Provider>;
}

/** Hidden `_companyId` field; renders nothing outside a provider (the action then fails closed). */
export function CompanyField() {
  const companyId = useContext(CompanyScopeContext);
  return companyId ? <input type="hidden" name="_companyId" value={companyId} /> : null;
}
