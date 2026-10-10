'use server';

import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { userMessage } from '../admin/errors';
import { parse } from '../admin/input';
import { staleCompany } from '../admin/run';
import { AdminError, type ActionState } from '../admin/types';
import { requireUser } from '../auth/session';
import { FLOW_KEY_RE, getFlowDetail } from '../queries/flows';
import { withDashboardContext } from '../queries/page';
import type { QueryCtx } from '../queries/scope';

/**
 * Flag a flow "for later" / remove the flag (ADR-0024). Same shape as the admin actions: the form carries the
 * company it was rendered for (`_companyId`, D10), the operation runs in one RLS transaction as the user, and the
 * result is an ActionState for useActionState. The flow has to be visible to the user (getFlowDetail) before a flag
 * is written, so nobody can bookmark a turn they cannot open; RLS keeps every row private to its user.
 */

const flagInput = z.object({
  turnId: z.uuid({ message: 'invalid turn' }),
  key: z.string().regex(FLOW_KEY_RE, 'invalid flow key'),
  startedMs: z.coerce.number().int().positive().optional(),
  note: z
    .string()
    .trim()
    .max(500, 'at most 500 characters')
    .transform((s) => (s === '' ? null : s))
    .optional(),
});

const unflagInput = z.object({ id: z.uuid({ message: 'invalid flag' }) });

const str = (fd: FormData, k: string): string | undefined => {
  const v = fd.get(k);
  return typeof v === 'string' ? v : undefined;
};

async function run(fd: FormData, fn: (ctx: QueryCtx) => Promise<string>): Promise<ActionState> {
  const user = await requireUser();
  const stale = staleCompany(fd, user.companyId);
  if (stale) return stale;
  try {
    const message = await withDashboardContext(user, fn);
    revalidatePath('/flows', 'layout');
    return { status: 'ok', message };
  } catch (err) {
    if (!(err instanceof AdminError)) console.error('[flows] action failed', err);
    return { status: 'error', message: userMessage(err) };
  }
}

export async function flagFlowAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, async (ctx) => {
    const input = parse(flagInput, { turnId: str(fd, 'turnId'), key: str(fd, 'key'), startedMs: str(fd, 'startedMs') || undefined, note: str(fd, 'note') });
    const flow = await getFlowDetail(ctx, input.turnId, input.key, input.startedMs);
    if (!flow) throw new AdminError('This flow is not visible to you (or no longer exists).');
    const name = flow.name.length > 200 ? `${flow.name.slice(0, 199)}…` : flow.name;
    await ctx.tx.execute(sql`
      insert into flow_flags (company_id, user_id, turn_id, flow_key, flow_name, note)
      values (${ctx.viewer.companyId}::uuid, ${ctx.viewer.id}::uuid, ${input.turnId}::uuid, ${input.key}, ${name}, ${input.note ?? null})
      on conflict (company_id, user_id, turn_id, flow_key) do update set note = coalesce(excluded.note, flow_flags.note)`);
    return 'Flagged for later. Find it at the top of Agent flows.';
  });
}

export async function unflagFlowAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  return run(fd, async (ctx) => {
    const input = parse(unflagInput, { id: str(fd, 'id') });
    const r = await ctx.tx.execute(sql`delete from flow_flags where id = ${input.id}::uuid returning id`);
    if ([...r].length === 0) throw new AdminError('That flag no longer exists.');
    return 'Flag removed.';
  });
}
