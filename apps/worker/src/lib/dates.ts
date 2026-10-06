/** UTC calendar helpers. Rollups, budgets and retention all work on UTC days (the SQL functions group by UTC day). */
export const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' of the UTC day containing `d`. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export const dayStart = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

export const addDays = (day: string, n: number): string => utcDay(new Date(dayStart(day).getTime() + n * DAY_MS));

/** First day of the month of `day`, e.g. '2026-10-17' -> '2026-10-01'. */
export const monthStart = (day: string): string => `${day.slice(0, 7)}-01`;

export const startOfUtcDay = (d: Date): Date => dayStart(utcDay(d));

/** First day of the month after `day`, e.g. '2026-12-17' -> '2027-01-01'. */
export const nextMonthStart = (day: string): string => {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
