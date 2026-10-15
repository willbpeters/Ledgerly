import type { BackupKind } from "./types";

const KIND_LABELS: Record<BackupKind, string> = {
  daily: "Daily",
  "pre-migration": "Before an update",
  "pre-restore": "Before a restore",
  manual: "Manual",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const kindLabel = (kind: BackupKind): string => KIND_LABELS[kind];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The ISO date one day earlier. UTC is right for shifting a date by whole
 *  days; it is only wrong for deciding what "today" is (see `localIsoDate`). */
function dayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** "Today, 09:30", "Yesterday, 18:04" or "2 Oct 2026, 07:15". `today` is the
 *  local ISO date, from `localIsoDate()`. */
export function whenLabel(date: string, time: string, today: string): string {
  const hm = time.slice(0, 5);
  if (date === today) return `Today, ${hm}`;
  if (date === dayBefore(today)) return `Yesterday, ${hm}`;
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}, ${hm}`;
}
