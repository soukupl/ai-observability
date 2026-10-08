import { Badge } from '@/components/Badge';
import { formatDateTime } from '@/components/format';
import { revokeTokenAction } from '@/lib/admin/actions/tokens';
import { canRevokeToken } from '@/lib/admin/permissions';
import type { TokenRow } from '@/lib/admin/tokens';
import type { Actor } from '@/lib/admin/types';
import { Confirm } from './Confirm';
import { noteCls, tableCls, tableWrapCls, tdCls, thCls, trCls } from './ui';

/**
 * Ingest tokens of the active company (never the secret: only the display prefix). Revoke only where the viewer may.
 * A user token whose owner left the company has no readable owner: shown as "former member" (it is revoked, D2).
 */
export function TokenTable({ tokens, viewer, showOwner = true }: { tokens: TokenRow[]; viewer: Actor; showOwner?: boolean }) {
  if (tokens.length === 0) return <p className={noteCls}>No tokens yet.</p>;
  const heads = ['Name', 'Kind', 'Prefix', ...(showOwner ? ['User'] : []), 'Created', 'Last used', 'Status'];
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
          {tokens.map((t) => (
            <tr key={t.id} className={`${trCls} ${t.revokedMs ? 'opacity-60' : ''}`}>
              <td className={`${tdCls} font-medium`}>{t.name}</td>
              <td className={tdCls}>
                <Badge tone={t.kind === 'company' ? 'info' : 'neutral'}>{t.kind}</Badge>
              </td>
              <td className={`${tdCls} font-mono text-xs`}>{t.prefix}…</td>
              {showOwner && <td className={tdCls}>{t.kind === 'user' ? (t.userName ?? 'former member') : '—'}</td>}
              <td className={`${tdCls} whitespace-nowrap`}>{formatDateTime(t.createdMs)}</td>
              <td className={`${tdCls} whitespace-nowrap`}>{t.lastUsedMs ? formatDateTime(t.lastUsedMs) : 'never'}</td>
              <td className={tdCls}>
                {t.revokedMs ? (
                  <span className="whitespace-nowrap text-xs">revoked {formatDateTime(t.revokedMs)}</span>
                ) : canRevokeToken(viewer, t) ? (
                  <Confirm label="Revoke…" warning={`Revoke "${t.name}"? Collectors using it stop sending; queued events stay on the machines until a new token is set.`} action={revokeTokenAction} confirmLabel="Revoke token">
                    <input type="hidden" name="tokenId" value={t.id} />
                  </Confirm>
                ) : (
                  <Badge tone="good">active</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
