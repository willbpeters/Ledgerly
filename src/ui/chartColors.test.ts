import { describe, it, expect, afterEach } from "vitest";
import { readChartColors } from "./chartColors";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("readChartColors", () => {
  it("falls back to the light palette when no tokens are set", () => {
    const c = readChartColors();
    expect(c.accent).toBe("#4f46e5");
    expect(c.series).toHaveLength(6);
  });

  it("reads whatever tokens are in force, so a dark theme wins", () => {
    const root = document.documentElement;
    root.style.setProperty("--accent", "#818cf8");
    root.style.setProperty("--chart-1", "#818cf8");
    root.style.setProperty("--chart-grid", "#262b37");
    root.style.setProperty("--mut", "#8a90a2");

    const c = readChartColors();
    expect(c.accent).toBe("#818cf8");
    expect(c.series[0]).toBe("#818cf8");
    expect(c.grid).toBe("#262b37");
    expect(c.text).toBe("#8a90a2");
    // untouched tokens keep their fallbacks
    expect(c.series[1]).toBe("#0ea5e9");
  });
});
