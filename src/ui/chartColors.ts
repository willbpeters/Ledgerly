import { useMemo } from "react";
import { useTheme } from "./theme";

/** Read chart tokens from CSS so charts follow the active theme. */
export function useChartColors() {
  const { resolved } = useTheme();
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
      series: [1, 2, 3, 4, 5, 6].map((i) => read(`--chart-${i}`, "#4f46e5")),
      grid: read("--chart-grid", "#e5e8ef"),
      text: read("--mut", "#64748b"),
      accent: read("--accent", "#4f46e5"),
      pos: read("--pos", "#15803d"),
      neg: read("--neg", "#b91c1c"),
    };
    // resolved is the dependency: recompute when the theme flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);
}
