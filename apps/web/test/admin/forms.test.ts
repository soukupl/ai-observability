import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * D10 source guard: every mutating form is bound to its company. A new form or action that skips the
 * binding fails here instead of acting on the wrong company after a switch in another tab.
 */
const src = join(__dirname, '../../src');
const roots = [join(src, 'app/admin'), join(src, 'app/(dashboard)/tokens')];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => relative(src, p);

describe('company-bound forms (D10)', () => {
  it('only ActionForm and TokenCreateForm contain a <form, and both render <CompanyField', () => {
    const withForm = roots.flatMap(walk).filter((p) => /\.tsx?$/.test(p) && readFileSync(p, 'utf8').includes('<form'));
    expect(withForm.map(rel).sort()).toEqual(['app/admin/_components/ActionForm.tsx', 'app/admin/_components/TokenCreateForm.tsx']);
    for (const p of withForm) expect(readFileSync(p, 'utf8')).toContain('<CompanyField');
  });

  it('each page provides the company scope from its own user; the shared admin layout does not', () => {
    // A shared layout is not re-rendered on client navigation between /admin/* pages, so a scope there would
    // keep the company of the first page while later pages render another company's rows.
    expect(readFileSync(join(src, 'app/admin/layout.tsx'), 'utf8')).not.toMatch(/<CompanyScopeProvider\b/);
    const pages = roots.flatMap(walk).filter((p) => p.endsWith('page.tsx'));
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) {
      const text = readFileSync(p, 'utf8');
      if (!/<(ActionForm|TokenCreateForm|TokenTable|Confirm)\b/.test(text)) continue;
      expect(text, rel(p)).toMatch(/<CompanyScopeProvider companyId=\{user\.companyId\}>/);
    }
  });

  it('every exported admin action passes its FormData to runAdmin / messageAction', () => {
    const dir = join(src, 'lib/admin/actions');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const actions = text.split(/^export async function /m).slice(1);
      expect(actions.length).toBeGreaterThan(0);
      for (const body of actions) {
        const name = body.slice(0, body.indexOf('('));
        expect(body, `${f}: ${name}`).toMatch(/(runAdmin|messageAction)\('(admin|user)', fd, /);
      }
    }
  });
});
