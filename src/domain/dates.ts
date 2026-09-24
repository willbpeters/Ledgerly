/**
 * A moment as `YYYY-MM-DD` on the user's own calendar. Use this, never
 * `toISOString().slice(0, 10)`, for "today": the ISO string is UTC, which in
 * the US evening is already tomorrow.
 */
export function localIsoDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
