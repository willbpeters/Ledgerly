/**
 * A moment as `YYYY-MM-DD` on the user's own calendar. Use this, never
 * `toISOString().slice(0, 10)`, for "today": the ISO string is UTC, which in
 * the US evening is already tomorrow.
 */
export function localIsoDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from one `YYYY-MM-DD` to another. UTC, so a clock change never moves it. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Calendar months from one `YYYY-MM-DD` to another. A part month counts as a
 * whole one, so the last payment towards a date is never missed: 25 Oct to 28
 * Oct is one month, 25 Oct to 26 Nov is two. Negative once `to` is past.
 */
export function monthsUntil(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + (td > fd ? 1 : 0);
}
