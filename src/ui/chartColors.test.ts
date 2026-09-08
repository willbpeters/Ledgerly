import { describe, it, expect, afterEach } from "vitest";
import { readChartColors } from "./chartColors";

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

describe("readChartColors", () => {
  it("falls back to the light palette when no tokens are set", () => {
    const c = readChartColors();
    expect(c.accent).toBe("#0f6b4f");
    expect(c.series).toHaveLength(6);
  });

  it("reads whatever tokens are in force, so a dark theme wins", () => {
    const root = document.documentElement;
    root.style.setProperty("--accent", "#34d399");
    root.style.setProperty("--chart-1", "#34d399");
    root.style.setProperty("--chart-grid", "#262b37");
    root.style.setProperty("--mut", "#8a90a2");

    const c = readChartColors();
    expect(c.accent).toBe("#34d399");
    expect(c.series[0]).toBe("#34d399");
    expect(c.grid).toBe("#262b37");
    expect(c.text).toBe("#8a90a2");
    // untouched tokens keep their fallbacks
    expect(c.series[1]).toBe("#b45309");
  });
});
