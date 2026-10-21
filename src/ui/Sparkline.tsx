import { sparkPath } from "../domain/heatmap";

/** A few closes as a small line, no axes. Decorative: the figures beside it say the numbers. */
export function Sparkline({ values, width = 64, height = 18 }: { values: number[]; width?: number; height?: number }) {
  const d = sparkPath(values, width, height);
  if (!d) return null;
  return (
    <svg className="sparkline" width={width} height={height + 2} viewBox={`0 -1 ${width} ${height + 2}`} aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
