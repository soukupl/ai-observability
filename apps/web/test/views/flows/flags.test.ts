import { describe, expect, it } from 'vitest';
import { flaggedFlowHref, flowHref, reportHref } from '../../../src/app/(dashboard)/flows/_helpers';

/** Flow flags + report links (ADR-0024): the flagged list and the "Download PDF" button point where the detail page does. */
describe('flow flags and report hrefs', () => {
  const turnId = '0f2c3a1e-1111-4222-8333-444455556666';

  it('reportHref opens the print report of the same flow, keyed like the detail page', () => {
    expect(reportHref({ turnId, key: 'wf_abc', turn: { startedMs: 1700000000000 } })).toBe(`/report/flows/${turnId}/wf_abc?startedMs=1700000000000`);
    // a key outside FLOW_KEY_RE is URL-encoded, as flowHref does
    expect(reportHref({ turnId, key: 'a b', turn: { startedMs: 5 } })).toBe(`/report/flows/${turnId}/a%20b?startedMs=5`);
  });

  it('flaggedFlowHref is the turn-page flow href of the flag’s turn and key', () => {
    const r = { turnId, key: 'seq-0f2c3a1e-aaaa-4bbb-8ccc-ddddeeeeffff', turn: { startedMs: 42 } };
    expect(flaggedFlowHref(r)).toBe(flowHref({ turnId, key: r.key, turn: { startedMs: 42 } }));
    expect(flaggedFlowHref(r)).toBe(`/turns/${turnId}?startedMs=42#flow-${r.key}`);
  });
});
