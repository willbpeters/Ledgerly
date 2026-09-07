import { describe, it, expect } from "vitest";
import { toValueSeries } from "./series";

describe("toValueSeries", () => {
  it("maps snapshots to chart points sorted by date", () => {
    const pts = toValueSeries([
      { date: "2026-02-01", total_value: 200 },
      { date: "2026-01-01", total_value: 100 },
    ]);
    expect(pts).toEqual([
      { date: "2026-01-01", value: 100 },
      { date: "2026-02-01", value: 200 },
    ]);
  });
});
