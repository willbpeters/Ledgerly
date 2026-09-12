import { describe, it, expect } from "vitest";
import { alignedReturns } from "./returns";
import type { Holding } from "./types";

function holding(ticker: string, security_id: number, marketValue: number): Holding {
  return {
    security_id, ticker, type: "etf",
    shares: 1, avgCost: marketValue, costBasis: marketValue,
    lastPrice: marketValue, marketValue,
    unrealized: 0, unrealizedPct: 0, realized: 0,
  };
}

function day(n: number): string {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `days` closes that rise 1% a day from 100. */
function closes(days: number, securityId: number) {
  return Array.from({ length: days }, (_, i) => ({
    security_id: securityId, date: day(i), close: 100 * Math.pow(1.01, i),
  }));
}

const LONG = 260;

function bench(days: number = LONG) {
  return closes(days, 0).map(({ date, close }) => ({ date, close }));
}

describe("alignedReturns", () => {
  it("turns closes into simple daily returns, one fewer than the closes", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: closes(LONG, 1),
      benchmark: bench(),
      minObservations: 10,
    });

    expect(a.dates).toHaveLength(LONG - 1);
    expect(a.benchmark).toHaveLength(LONG - 1);
    expect(a.assets[0].returns![0]).toBeCloseTo(0.01, 12);
  });

  it("drops a date the benchmark did not trade on", () => {
    const gappyBench = bench().filter((_, i) => i !== 5);

    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: closes(LONG, 1),
      benchmark: gappyBench,
      minObservations: 10,
    });

    expect(a.dates).not.toContain(day(5));
    expect(a.dates).toHaveLength(gappyBench.length - 1);
  });

  it("drops a date a holding is missing rather than carrying the last close forward", () => {
    const gappy = closes(LONG, 1).filter((_, i) => i !== 7);

    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: gappy,
      benchmark: bench(),
      minObservations: 10,
    });

    expect(a.dates).not.toContain(day(7));
    // Forward-filling would have produced a 0% day; the return across the gap
    // must be the real two-day move instead.
    const i = a.dates.indexOf(day(8));
    expect(a.assets[0].returns![i]).toBeCloseTo(Math.pow(1.01, 2) - 1, 12);
  });

  it("passes a holding with no price rows through with null returns, and says why", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1000), holding("SWVXX", 2, 500)],
      prices: closes(LONG, 1),
      benchmark: bench(),
      minObservations: 10,
    });

    // Every holding comes through. `marketExposure` owns the decision to drop
    // one, so it can also report how much of the portfolio went with it.
    expect(a.assets.map((x) => x.ticker)).toEqual(["A", "SWVXX"]);
    expect(a.assets.find((x) => x.ticker === "SWVXX")!.returns).toBeNull();
    expect(a.assets.find((x) => x.ticker === "SWVXX")!.value).toBe(500);
    expect(a.excluded).toEqual([{ ticker: "SWVXX", reason: "no history" }]);
  });

  it("excludes a holding too new to measure rather than shortening everyone's window", () => {
    const newcomer = closes(LONG, 2).slice(-20).map((p) => ({ ...p, security_id: 2 }));

    const a = alignedReturns({
      holdings: [holding("A", 1, 1000), holding("NEW", 2, 500)],
      prices: [...closes(LONG, 1), ...newcomer],
      benchmark: bench(),
      minObservations: 200,
    });

    expect(a.excluded).toEqual([{ ticker: "NEW", reason: "short history" }]);
    expect(a.assets.find((x) => x.ticker === "NEW")!.returns).toBeNull();
    expect(a.dates.length).toBeGreaterThan(200);
  });

  it("carries each holding's market value and id through for weighting", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1234)],
      prices: closes(LONG, 1),
      benchmark: bench(),
      minObservations: 10,
    });
    expect(a.assets[0].value).toBe(1234);
    expect(a.assets[0].securityId).toBe(1);
  });

  it("returns an empty alignment when there is no benchmark at all", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: closes(LONG, 1),
      benchmark: [],
      minObservations: 10,
    });
    expect(a.dates).toEqual([]);
    expect(a.benchmark).toEqual([]);
  });

  it("hands every holding to the exposure maths so coverage can be counted", () => {
    // The regression sees a portfolio that is 1000 of measurable A and 3000 of
    // unmeasurable B. If B were dropped here rather than passed through with
    // null returns, marketExposure would report full coverage of a portfolio
    // it had only seen a quarter of.
    const a = alignedReturns({
      holdings: [holding("A", 1, 1000), holding("B", 9, 3000)],
      prices: closes(LONG, 1),
      benchmark: bench(),
      minObservations: 10,
    });
    expect(a.assets).toHaveLength(2);
    expect(a.assets.reduce((sum, x) => sum + x.value, 0)).toBe(4000);
  });
});
