import { describe, it, expect } from "vitest";
import { concentration, marketExposure, MIN_HISTORY_DAYS, TRADING_DAYS } from "./risk";
import type { Holding } from "./types";

function holding(ticker: string, marketValue: number): Holding {
  return {
    security_id: ticker.charCodeAt(0), ticker, type: "etf",
    shares: 1, avgCost: marketValue, costBasis: marketValue,
    lastPrice: marketValue, marketValue,
    unrealized: 0, unrealizedPct: 0, realized: 0,
  };
}

describe("concentration", () => {
  it("gives every holding its share of the invested value", () => {
    const c = concentration([holding("A", 750), holding("B", 250)], 0);
    expect(c.investedValue).toBe(1000);
    expect(c.weights.map((w) => [w.ticker, w.weight])).toEqual([["A", 0.75], ["B", 0.25]]);
  });

  it("orders holdings largest first, so the top one is obvious", () => {
    const c = concentration([holding("S", 10), holding("B", 90), holding("M", 50)], 0);
    expect(c.weights.map((w) => w.ticker)).toEqual(["B", "M", "S"]);
    expect(c.topTicker).toBe("B");
    expect(c.topWeight).toBeCloseTo(0.6);
  });

  it("counts four equal holdings as four effective positions", () => {
    const c = concentration(["A", "B", "C", "D"].map((t) => holding(t, 100)), 0);
    expect(c.effectivePositions).toBeCloseTo(4);
    expect(c.topWeight).toBeCloseTo(0.25);
  });

  it("sees through a portfolio that is one big bet and four small ones", () => {
    // Five holdings, but 80% sits in one. A plain count says "5"; the effective
    // count says this behaves like about 1.5 positions.
    const c = concentration(
      [holding("BIG", 800), holding("A", 50), holding("B", 50), holding("C", 50), holding("D", 50)], 0);
    expect(c.weights).toHaveLength(5);
    expect(c.effectivePositions).toBeCloseTo(1.538, 2);
  });

  it("counts a single holding as exactly one position", () => {
    const c = concentration([holding("ONLY", 500)], 0);
    expect(c.effectivePositions).toBeCloseTo(1);
    expect(c.topWeight).toBe(1);
  });

  it("sums the five largest holdings", () => {
    const c = concentration(
      [holding("A", 100), holding("B", 100), holding("C", 100), holding("D", 100),
       holding("E", 100), holding("F", 100)], 0);
    expect(c.top5Weight).toBeCloseTo(5 / 6);
  });

  it("treats fewer than five holdings as all of them", () => {
    const c = concentration([holding("A", 60), holding("B", 40)], 0);
    expect(c.top5Weight).toBeCloseTo(1);
  });

  it("reports cash as a share of everything you hold", () => {
    const c = concentration([holding("A", 750)], 250);
    expect(c.cashShare).toBeCloseTo(0.25);
    // Cash is not a market position, so it stays out of the weights.
    expect(c.weights).toHaveLength(1);
    expect(c.weights[0].weight).toBe(1);
  });

  it("says nothing rather than NaN when there is nothing invested", () => {
    const c = concentration([], 0);
    expect(c.effectivePositions).toBeNull();
    expect(c.topWeight).toBeNull();
    expect(c.topTicker).toBeNull();
    expect(c.top5Weight).toBeNull();
    expect(c.cashShare).toBe(0);
    expect(c.weights).toEqual([]);
  });

  it("handles a cash-only portfolio without dividing by zero", () => {
    const c = concentration([], 5000);
    expect(c.effectivePositions).toBeNull();
    expect(c.cashShare).toBe(1);
  });

  it("ignores holdings worth nothing instead of giving them a weight", () => {
    const c = concentration([holding("A", 100), holding("SOLD", 0)], 0);
    expect(c.weights.map((w) => w.ticker)).toEqual(["A"]);
    expect(c.effectivePositions).toBeCloseTo(1);
  });
});

/** A benchmark that moves enough to regress against, long enough to qualify. */
function benchmarkSeries(days: number = MIN_HISTORY_DAYS): number[] {
  // Deterministic and not a straight line: a sine keeps variance well away
  // from zero without needing a random seed.
  return Array.from({ length: days }, (_, i) => Math.sin(i) * 0.01);
}

function asset(ticker: string, value: number, returns: number[] | null) {
  return { securityId: ticker.charCodeAt(0), ticker, value, returns };
}

describe("marketExposure", () => {
  const market = benchmarkSeries();

  it("scores a portfolio that is the market as beta 1, alpha 0, R-squared 1", () => {
    const e = marketExposure({
      assets: [asset("SPX", 1000, market)], cash: 0, benchmark: market,
    });
    expect(e.beta).toBeCloseTo(1, 10);
    expect(e.alpha).toBeCloseTo(0, 10);
    expect(e.r2).toBeCloseTo(1, 10);
  });

  it("scores a twice-leveraged copy of the market as beta 2", () => {
    const e = marketExposure({
      assets: [asset("LEV", 1000, market.map((r) => r * 2))], cash: 0, benchmark: market,
    });
    expect(e.beta).toBeCloseTo(2, 10);
  });

  it("annualises a steady daily edge into alpha", () => {
    const e = marketExposure({
      assets: [asset("EDGE", 1000, market.map((r) => r + 0.0001))], cash: 0, benchmark: market,
    });
    expect(e.alpha).toBeCloseTo(0.0001 * TRADING_DAYS, 10);
    expect(e.beta).toBeCloseTo(1, 10);
  });

  it("halves beta when half the portfolio is cash", () => {
    const e = marketExposure({
      assets: [asset("SPX", 1000, market)], cash: 1000, benchmark: market,
    });
    expect(e.beta).toBeCloseTo(0.5, 10);
  });

  it("gives a cash-only portfolio beta 0 rather than dividing by zero", () => {
    const e = marketExposure({ assets: [], cash: 5000, benchmark: market });
    expect(e.beta).toBe(0);
    expect(e.alpha).toBe(0);
    expect(e.volatility).toBe(0);
  });

  it("refuses to report anything against a benchmark that never moved", () => {
    const flat = Array(MIN_HISTORY_DAYS).fill(0);
    const e = marketExposure({ assets: [asset("A", 1000, market)], cash: 0, benchmark: flat });
    expect(e.beta).toBeNull();
    expect(e.alpha).toBeNull();
    expect(e.r2).toBeNull();
  });

  it("suppresses every figure when the window is too short", () => {
    const short = benchmarkSeries(MIN_HISTORY_DAYS - 1);
    const e = marketExposure({ assets: [asset("A", 1000, short)], cash: 0, benchmark: short });
    expect(e.alpha).toBeNull();
    expect(e.beta).toBeNull();
    expect(e.r2).toBeNull();
    expect(e.volatility).toBeNull();
    expect(e.observations).toBe(MIN_HISTORY_DAYS - 1);
  });

  it("gives a constant portfolio series exactly zero volatility", () => {
    const e = marketExposure({
      assets: [asset("FLAT", 1000, Array(MIN_HISTORY_DAYS).fill(0))], cash: 0, benchmark: market,
    });
    expect(e.volatility).toBe(0);
  });

  it("annualises volatility by the square root of the trading year", () => {
    const wobble = Array.from({ length: MIN_HISTORY_DAYS }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const e = marketExposure({
      assets: [asset("W", 1000, wobble)], cash: 0, benchmark: market,
    });
    // stdev of an alternating +/-1% series is ~0.01 (sample, n-1).
    expect(e.volatility!).toBeCloseTo(0.01 * Math.sqrt(TRADING_DAYS), 2);
  });

  it("leaves out an asset with no returns and says how many it left out", () => {
    const e = marketExposure({
      assets: [asset("SPX", 1000, market), asset("SWVXX", 1000, null)],
      cash: 0, benchmark: market,
    });
    expect(e.excludedTickers).toEqual(["SWVXX"]);
    expect(e.includedCount).toBe(1);
    expect(e.beta).toBeCloseTo(1, 10);
  });
});
