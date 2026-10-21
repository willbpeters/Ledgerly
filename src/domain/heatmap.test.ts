import { describe, it, expect } from "vitest";
import { heatLevel, treemap, sparkPath, sparkArea, trend } from "./heatmap";

describe("heatLevel", () => {
  it("calls a tiny move flat", () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(0.05)).toBe(0);
    expect(heatLevel(-0.09)).toBe(0);
  });

  it("steps up in thirds of the cap, on both sides", () => {
    expect(heatLevel(0.5)).toBe(1);
    expect(heatLevel(1)).toBe(2);
    expect(heatLevel(1.5)).toBe(3);
    expect(heatLevel(-0.5)).toBe(-1);
    expect(heatLevel(-1.5)).toBe(-3);
  });

  it("saturates past the cap, so one wild day does not wash out the rest", () => {
    expect(heatLevel(9)).toBe(3);
    expect(heatLevel(-9)).toBe(-3);
  });
});

describe("treemap", () => {
  const area = (r: { w: number; h: number }) => r.w * r.h;

  it("gives each item an area proportional to its value, filling the box", () => {
    const rects = treemap([{ key: "a", value: 50 }, { key: "b", value: 30 }, { key: "c", value: 20 }], 200, 100);
    const byKey = Object.fromEntries(rects.map((r) => [r.key, r]));
    expect(area(byKey.a)).toBeCloseTo(10000);
    expect(area(byKey.b)).toBeCloseTo(6000);
    expect(area(byKey.c)).toBeCloseTo(4000);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(200 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it("puts the largest first and never overlaps two tiles", () => {
    const items = [5, 1, 8, 3, 2, 13].map((v, i) => ({ key: `k${i}`, value: v }));
    const rects = treemap(items, 160, 90);
    expect(rects[0].key).toBe("k5");
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [a, b] = [rects[i], rects[j]];
        const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(overlapW <= 1e-9 || overlapH <= 1e-9).toBe(true);
      }
    }
    expect(rects.reduce((s, r) => s + area(r), 0)).toBeCloseTo(160 * 90);
  });

  it("drops items worth nothing", () => {
    expect(treemap([{ key: "a", value: 0 }, { key: "b", value: -3 }], 10, 10)).toEqual([]);
    expect(treemap([{ key: "a", value: 4 }], 10, 10)).toEqual([{ key: "a", x: 0, y: 0, w: 10, h: 10 }]);
  });
});

describe("sparkPath", () => {
  it("scales the series into the box, high values at the top", () => {
    expect(sparkPath([1, 3, 2], 60, 20)).toBe("M0 20 L30 0 L60 10");
  });

  it("draws a flat series across the middle", () => {
    expect(sparkPath([5, 5], 60, 20)).toBe("M0 10 L60 10");
  });

  it("draws nothing for fewer than two points", () => {
    expect(sparkPath([5], 60, 20)).toBe("");
  });
});

describe("sparkArea", () => {
  it("closes the line down to the bottom edge, for a fill under it", () => {
    expect(sparkArea([1, 3, 2], 60, 20)).toBe("M0 20 L30 0 L60 10 L60 20 L0 20 Z");
  });

  it("draws nothing for fewer than two points", () => {
    expect(sparkArea([5], 60, 20)).toBe("");
  });
});

describe("trend", () => {
  it("reads the direction from first close to last", () => {
    expect(trend([100, 90, 105])).toBe("up");
    expect(trend([100, 110, 95])).toBe("down");
    expect(trend([100, 120, 100])).toBe("flat");
    expect(trend([100])).toBe("flat");
  });
});
