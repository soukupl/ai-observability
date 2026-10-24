import { DEFAULT_TOKEN_LIFETIME, TOKEN_LIFETIMES, type TokenLifetime } from '@/lib/admin/tokens';
import { inputCls, labelCls, selectCls } from './ui';

const LIFETIME_LABEL: Record<TokenLifetime, string> = { '30': '30 days', '90': '90 days', '365': '365 days', none: 'No expiry' };

/** Name + lifetime of a manual token (Q6: 30 / 90 / 365 days or none, default 90). `userId` = a service user's token. */
export function TokenFields({ userId, placeholder = 'e.g. Work laptop' }: { userId?: string; placeholder?: string }) {
  return (
    <>
      {userId && <input type="hidden" name="userId" value={userId} />}
      <label className={`${labelCls} grow sm:max-w-xs`}>
        Name
        <input name="name" required maxLength={60} placeholder={placeholder} className={inputCls} />
      </label>
      <label className={labelCls}>
        Lifetime
        <select name="lifetime" defaultValue={DEFAULT_TOKEN_LIFETIME} className={selectCls}>
          {TOKEN_LIFETIMES.map((l) => (
            <option key={l} value={l}>
              {LIFETIME_LABEL[l]}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
