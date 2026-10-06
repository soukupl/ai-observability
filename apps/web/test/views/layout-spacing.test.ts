import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const page = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/app/(dashboard)/${rel}`, import.meta.url)), 'utf8');

// Review V5: pages that return a bare fragment have no vertical gap between their cards (the layout's <main> adds none).
describe('dashboard pages stack their sections with space-y-4', () => {
  it.each(['agents/page.tsx', 'models/page.tsx', 'overview/page.tsx', 'skills-mcp/page.tsx'])('%s wraps its content in a space-y-4 container', (rel) => {
    const src = page(rel);
    expect(src).toMatch(/return \(\s*<div className="space-y-4">/);
    expect(src).not.toMatch(/return \(\s*<>/);
  });
});
