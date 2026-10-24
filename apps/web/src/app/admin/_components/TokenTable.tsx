import { Badge } from '@/components/Badge';
import { formatDateTime } from '@/components/format';
import { revokeTokenAction } from '@/lib/admin/actions/tokens';
import { canRevokeToken } from '@/lib/admin/permissions';
import { tokenState, type TokenRow } from '@/lib/admin/tokens';
import type { Actor } from '@/lib/admin/types';
import { Confirm } from './Confirm';
import { noteCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from './ui';

const STATE_TONE = { active: 'good', expiring: 'warn', expired: 'neutral', revoked: 'neutral' } as const;

/**
 * Ingest tokens (never the secret: only the display prefix) with their source (device login or manual), label,
 * expiry and last use. Revoke only where the viewer may. A token whose owner is no longer a member has no readable
 * owner: shown as "former member" (it is revoked, D2).
 */
export function TokenTable({ tokens, viewer, showOwner = true, nowMs = Date.now() }: { tokens: TokenRow[]; viewer: Actor; showOwner?: boolean; nowMs?: number }) {
  if (tokens.length === 0) return <p className={noteCls}>No tokens yet.</p>;
  const heads = ['Name', 'Source', 'Prefix', ...(showOwner ? ['Owner'] : []), 'Created', 'Expires', 'Last used', 'Status'];
  return (
    <div className={tableWrapCls}>
      <table className={tableCls}>
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800">
            {heads.map((h) => (
              <th key={h} className={thCls}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => {
            const state = tokenState(t, nowMs);
            const live = state === 'active' || state === 'expiring';
            return (
              <tr key={t.id} className={`${trCls} ${live ? '' : 'opacity-60'}`}>
                <td className={tdCls}>
                  <div className="font-medium">{t.name}</div>
                  {t.label && t.label !== t.name && <div className={noteCls}>{t.label}</div>}
                </td>
                <td className={tdCls}>
                  <Badge tone={t.source === 'device' ? 'info' : 'neutral'}>{t.source === 'device' ? 'device login' : 'manual'}</Badge>
                </td>
                <td className={`${tdCls} font-mono text-xs`}>{t.prefix}…</td>
                {showOwner && (
                  <td className={tdCls}>
                    {t.userName ?? 'former member'}
                    {t.userKind === 'service' && (
                      <>
                        {' '}
                        <Badge>service</Badge>
                      </>
                    )}
                  </td>
                )}
                <td className={`${tdCls} whitespace-nowrap`}>{formatDateTime(t.createdMs)}</td>
                <td className={`${tdCls} whitespace-nowrap`}>{t.expiresMs ? formatDateTime(t.expiresMs) : 'never'}</td>
                <td className={`${tdCls} whitespace-nowrap`}>{t.lastUsedMs ? formatDateTime(t.lastUsedMs) : 'never'}</td>
                <td className={tdCls}>
                  <div className="flex flex-wrap items-center gap-2">
                    {state === 'revoked' ? (
                      <span className="whitespace-nowrap text-xs">revoked {formatDateTime(t.revokedMs!)}</span>
                    ) : (
                      <Badge tone={STATE_TONE[state]}>{state === 'expiring' ? 'expires soon' : state}</Badge>
                    )}
                    {live && canRevokeToken(viewer, t) && (
                      <Confirm
                        label="Revoke…"
                        warning={`Revoke "${t.name}"? Collectors using it stop sending; queued events stay on the machines until they log in again.`}
                        action={revokeTokenAction}
                        confirmLabel="Revoke token"
                      >
                        <input type="hidden" name="tokenId" value={t.id} />
                      </Confirm>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
