import { inputCls, labelCls } from './ui';

/** Name field of the token form; `kind` is fixed per form (user token = own, company token = CI / bots / MDM). */
export function TokenFields({ kind }: { kind: 'user' | 'company' }) {
  return (
    <>
      <input type="hidden" name="kind" value={kind} />
      <label className={`${labelCls} grow sm:max-w-xs`}>
        Name
        <input name="name" required maxLength={60} placeholder={kind === 'company' ? 'e.g. CI runners or Laptop fleet 2026' : 'e.g. Work laptop'} className={inputCls} />
      </label>
    </>
  );
}
