export function money(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${abs}`;
}
export function pct(n: number): string {
  // Signed by what is shown, not by the raw value: -0.004 rounds to 0.0, and a
  // "-0.0%" reads as a loss that is not there.
  const shown = Math.abs(n).toFixed(1);
  const sign = Number(shown) === 0 ? "" : n > 0 ? "+" : "-";
  return `${sign}${shown}%`;
}
export function fmtDate(iso: string): string { return iso.slice(0, 10); }
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** A proportion (0..1) as a percentage. Unlike `pct`, no +/- sign: a share of
 *  something is never "negative 40%". */
export function share(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
