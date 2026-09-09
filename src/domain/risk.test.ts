import { describe, it, expect } from "vitest";
import { concentration } from "./risk";
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
