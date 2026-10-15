/** Usage periods are UTC calendar months, identified by their first day ('YYYY-MM-01'). */

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export function periodOf(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-01`;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' -> 'YYYY-MM-01', or null when malformed. */
export function periodFromMonth(month: string): string | null {
  return MONTH_RE.test(month) ? `${month}-01` : null;
}

/** 'YYYY-MM-01' -> 'YYYY-MM'. */
export function monthOf(period: string): string {
  return period.slice(0, 7);
}
