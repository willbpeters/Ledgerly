import type { Snapshot, SeriesPoint } from "./types";

export function toValueSeries(snapshots: Snapshot[]): SeriesPoint[] {
  return snapshots
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((s) => ({ date: s.date, value: s.total_value }));
}
