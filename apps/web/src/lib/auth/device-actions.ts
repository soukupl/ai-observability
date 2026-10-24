'use server';

import {
  ageText,
  approveDeviceLogin,
  denyDeviceLogin,
  DEVICE_MESSAGES as M,
  deviceMissLimiter,
  lookupDeviceLogin,
  normalizeUserCode,
  withMissBudget,
  type DeviceState,
} from './device';
import { withUserDb } from './rls';
import { requireUser } from './session';

/**
 * The `/device` form (POST only, so a link cannot carry a code to a one-click Approve). Form field `intent` is
 * `lookup` (the typed code: shows the request to confirm), `approve` or `deny`; field `code` is the code. Every step
 * spends the per-user miss budget (deviceMissLimiter) on a code that is not open, and is refused once it is spent.
 */
export async function deviceAction(_prev: DeviceState, fd: FormData): Promise<DeviceState> {
  const user = await requireUser();
  const raw = fd.get('code');
  const typed = typeof raw === 'string' ? raw.slice(0, 12) : '';
  const code = normalizeUserCode(raw);
  if (!code) return { step: 'enter', tone: 'error', message: M.badFormat, typed };
  const intent = fd.get('intent');

  if (intent === 'approve' || intent === 'deny') {
    const r = await withMissBudget(deviceMissLimiter, user.id, () =>
      withUserDb(user, (tx) => (intent === 'approve' ? approveDeviceLogin(tx, user.id, code) : denyDeviceLogin(tx, user.id, code))),
    );
    if (r.status === 'ok') return { step: 'enter', tone: 'ok', message: intent === 'approve' ? M.approved : M.denied };
    return { step: 'enter', tone: 'error', message: r.status === 'limited' ? M.limited : M.gone };
  }

  const r = await withMissBudget(deviceMissLimiter, user.id, () => withUserDb(user, (tx) => lookupDeviceLogin(tx, code)));
  if (r.status !== 'ok') return { step: 'enter', tone: 'error', message: r.status === 'limited' ? M.limited : M.notFound, typed };
  const p = r.value;
  return { step: 'confirm', code: p.code, clientName: p.clientName, clientVersion: p.clientVersion, requesterIp: p.requesterIp, age: ageText(p.createdMs) };
}
