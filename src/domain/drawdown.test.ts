import { describe, it, expect } from "vitest";
import { drawdown, holdingsPath } from "./drawdown";
import type { ExposureAsset } from "./risk";

const DATES = ["d1", "d2", "d3", "d4", "d5"];
const asset = (ticker: string, value: number, returns: number[] | null): ExposureAsset =>
  ({ securityId: ticker.charCodeAt(0), ticker, value, returns });

describe("holdingsPath", () => {
  it("values today's shares back through each holding's returns, ending at today's value", () => {
    // One holding worth 120 today; it went 100 → 150 → 120 on d1..d3.
    const path = holdingsPath(["d1", "d2", "d3"], [asset("A", 120, [0.1, 0.5, -0.2])]);
    expect(path.map((p) => p.value)).toEqual([
      expect.closeTo(100), expect.closeTo(150), expect.closeTo(120),
    ]);
  });

  it("holds the shares rather than rebalancing to today's weights", () => {
    // A doubles while B is flat. Held as shares, A's weight grows over time;
    // a fixed-weight blend would understate the path's start.
    const path = holdingsPath(["d1", "d2"], [asset("A", 200, [0, 1]), asset("B", 100, [0, 0])]);
    expect(path[0].value).toBeCloseTo(200); // 100 of A + 100 of B
    expect(path[1].value).toBeCloseTo(300);
  });
});

describe("drawdown", () => {
  // Path: 100, 125, 75, 100, 112.5 — a 40% fall from d2 to d3, not yet recovered.
  const falling = [asset("A", 112.5, [0, 0.25, -0.4, 1 / 3, 0.125])];

  it("finds the worst peak-to-trough fall and its dates", () => {
    const d = drawdown({ dates: DATES, assets: falling }, 3);
    expect(d.worst).toEqual({ fall: expect.closeTo(-0.4), peakDate: "d2", troughDate: "d3", recoveredDate: null });
  });

  it("says how far below the high today is, in percent and dollars", () => {
    const d = drawdown({ dates: DATES, assets: falling }, 3);
    expect(d.fromHigh).toEqual({ fall: expect.closeTo(-0.1), highDate: "d2", below: expect.closeTo(12.5) });
  });

  it("dates the recovery once the old high is regained", () => {
    // 100, 125, 75, 125, 130
    const d = drawdown({ dates: DATES, assets: [asset("A", 130, [0, 0.25, -0.4, 2 / 3, 0.04])] }, 3);
    expect(d.worst?.recoveredDate).toBe("d4");
    expect(d.fromHigh).toEqual({ fall: 0, highDate: "d5", below: 0 });
  });

  it("reports no fall for a path that only rises", () => {
    const d = drawdown({ dates: DATES, assets: [asset("A", 5, [0.1, 0.1, 0.1, 0.1, 0.1])] }, 3);
    expect(d.worst).toBeNull();
    expect(d.fromHigh?.fall).toBe(0);
  });

  it("leaves out holdings with no usable history, and says how much that covers", () => {
    const d = drawdown({ dates: DATES, assets: [...falling, asset("Z", 37.5, null), asset("Gone", 0, null)] }, 3);
    expect(d.worst?.fall).toBeCloseTo(-0.4);
    expect(d.excludedTickers).toEqual(["Z"]);
    expect(d.includedValueShare).toBeCloseTo(0.75);
  });

  it("gives no figures on too short a history", () => {
    const d = drawdown({ dates: DATES, assets: falling }, 200);
    expect(d.worst).toBeNull();
    expect(d.fromHigh).toBeNull();
    expect(d.observations).toBe(5);
  });

  it("gives no figures when nothing could be measured", () => {
    const d = drawdown({ dates: [], assets: [asset("Z", 50, null)] }, 3);
    expect(d.fromHigh).toBeNull();
    expect(d.includedValueShare).toBe(0);
  });
});
