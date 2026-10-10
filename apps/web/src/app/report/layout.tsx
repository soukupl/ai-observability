import type { ReactNode } from 'react';
import { ForceLight } from './ForceLight';

/**
 * Printable reports (`/report/…`, the "Download PDF" targets): no app shell, no nav, light colours on paper. The root
 * layout still applies the theme script; the `report` class and the print rules in globals.css keep paper white and
 * hide screen-only controls.
 */
export default function ReportLayout({ children }: { children: ReactNode }) {
  return (
    <div className="report mx-auto max-w-[1040px] px-6 py-6 text-zinc-900 print:max-w-none print:px-0 print:py-0">
      {/* Landscape only for reports (the flow chart and the 14-column steps table need the width); @page cannot be scoped by class. */}
      <style>{'@page { size: landscape; margin: 12mm; }'}</style>
      <ForceLight />
      {children}
    </div>
  );
}
