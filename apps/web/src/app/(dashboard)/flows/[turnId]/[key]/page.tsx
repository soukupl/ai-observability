import { notFound, permanentRedirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getFlowDetail } from '@/lib/queries/flows';
import { withDashboardContext } from '@/lib/queries/page';
import { parseStartedMs } from '../../../turns/_helpers';
import { flowHref, parseFlowKey } from '../../_helpers';

/**
 * The former flow detail page (ADR-0020 amendment) lives on the turn page since ADR-0025: `/flows/<turnId>/<key>`
 * redirects to `/turns/<turnId>?startedMs=…#flow-<key>` so bookmarks, flags and old report links keep working. As
 * before, a flow that does not exist (or is not visible) is a 404 rather than a turn page with a dead anchor.
 */

type Props = { params: Promise<{ turnId: string; key: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function FlowDetailRedirect({ params, searchParams }: Props) {
  const user = await requireUser();
  const [{ turnId, key: rawKey }, sp] = await Promise.all([params, searchParams]);
  const key = parseFlowKey(rawKey);
  if (!key) notFound();
  const flow = await withDashboardContext(user, (ctx) => getFlowDetail(ctx, turnId, key, parseStartedMs(sp.startedMs)));
  if (!flow) notFound();
  permanentRedirect(flowHref(flow));
}
