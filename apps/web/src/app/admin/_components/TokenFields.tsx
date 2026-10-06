import { inputCls, labelCls, selectCls } from './ui';

/** Name + team fields of the token form; `kind` is fixed per form. */
export function TokenFields({ kind, teams, defaultTeamId }: { kind: 'user' | 'team'; teams: { id: string; name: string }[]; defaultTeamId?: string | null }) {
  return (
    <>
      <input type="hidden" name="kind" value={kind} />
      <label className={`${labelCls} grow sm:max-w-xs`}>
        Name
        <input name="name" required maxLength={60} placeholder={kind === 'team' ? 'e.g. Laptop fleet 2026' : 'e.g. Work laptop'} className={inputCls} />
      </label>
      <label className={labelCls}>
        Team
        <select name="teamId" required className={selectCls} defaultValue={defaultTeamId ?? teams[0]?.id}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
