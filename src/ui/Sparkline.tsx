import { sparkArea, sparkPath } from "../domain/heatmap";

// Drawn in a fixed box and stretched to the space it is given; the stroke
// keeps its width however far the box is stretched.
const W = 100;
const H = 32;

/**
 * Recent closes as a line with a soft fill beneath it. `tone` colours it
 * (`up`, `down`, or `flat` for grey). Decorative: the figures beside it carry
 * the numbers.
 */
export function Sparkline({ values, tone = "flat" }: { values: number[]; tone?: "up" | "down" | "flat" }) {
  const line = sparkPath(values, W, H);
  if (!line) return null;
  return (
    <svg className={`sparkline ${tone}`} viewBox={`0 -2 ${W} ${H + 4}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={sparkArea(values, W, H)} fill="currentColor" fillOpacity={0.13} stroke="none" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round"
        strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
