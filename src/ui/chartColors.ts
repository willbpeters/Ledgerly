import { useLayoutEffect, useState } from "react";
import { useTheme } from "./theme";

export interface ChartColors {
  series: string[];
  grid: string; text: string; accent: string; pos: string; neg: string;
}

const FALLBACK: ChartColors = {
  series: ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"],
  grid: "#e5e8ef", text: "#64748b", accent: "#4f46e5", pos: "#15803d", neg: "#b91c1c",
};

/** Read the chart tokens currently in force on <html>. */
export function readChartColors(): ChartColors {
  if (typeof document === "undefined") return FALLBACK;
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    series: FALLBACK.series.map((fb, i) => read(`--chart-${i + 1}`, fb)),
    grid: read("--chart-grid", FALLBACK.grid),
    text: read("--mut", FALLBACK.text),
    accent: read("--accent", FALLBACK.accent),
    pos: read("--pos", FALLBACK.pos),
    neg: read("--neg", FALLBACK.neg),
  };
}

/**
 * Chart colours for the active theme.
 *
 * Re-read in a layout effect as well as on the first render: the stylesheet may
 * not be in force when a chart first renders, and colours captured then would
 * otherwise stick for the life of the component.
 */
export function useChartColors(): ChartColors {
  const { resolved } = useTheme();
  const [colors, setColors] = useState<ChartColors>(readChartColors);

  useLayoutEffect(() => {
    const next = readChartColors();
    setColors((prev) => (sameColors(prev, next) ? prev : next));
  }, [resolved]);

  return colors;
}

function sameColors(a: ChartColors, b: ChartColors): boolean {
  return a.grid === b.grid && a.text === b.text && a.accent === b.accent
    && a.pos === b.pos && a.neg === b.neg
    && a.series.length === b.series.length && a.series.every((c, i) => c === b.series[i]);
}
