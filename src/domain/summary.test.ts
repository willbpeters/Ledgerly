import { describe, it, expect } from "vitest";
import { buildSummary } from "./summary";
import type { Holding } from "./types";

const h = (p: Partial<Holding>): Holding => ({
  security_id: 1, ticker: "X", type: "stock", shares: 10, avgCost: 100,
  costBasis: 1000, lastPrice: 130, marketValue: 1300, unrealized: 300,
  unrealizedPct: 30, realized: 0, ...p,
});

describe("buildSummary", () => {
  it("totals value, gains, and day change", () => {
    const holdings = [h({ security_id: 1, shares: 10, costBasis: 1000, marketValue: 1300, unrealized: 300, realized: 50 })];
    const prev = new Map([[1, 125]]); // yesterday close
    const s = buildSummary(holdings, 500, prev);
    expect(s.investedValue).toBe(1300);
    expect(s.cash).toBe(500);
    expect(s.totalValue).toBe(1800);
    expect(s.totalCostBasis).toBe(1000);
    expect(s.unrealized).toBe(300);
    expect(s.unrealizedPct).toBeCloseTo(30, 6);
    expect(s.realized).toBe(50);
    expect(s.dayChange).toBe(50);          // 10 * (130 - 125)
    expect(s.dayChangePct).toBeCloseTo((50 / 1250) * 100, 6); // vs prior invested only
  });

  it("day change is zero when no previous price", () => {
    const s = buildSummary([h({})], 0, new Map());
    expect(s.dayChange).toBe(0);
    expect(s.dayChangePct).toBe(0);
  });

  it("keeps a consistent baseline when only some holdings have a previous price", () => {
    const holdings = [
      h({ security_id: 1, shares: 10, lastPrice: 130, marketValue: 1300 }), // has prev
      h({ security_id: 2, shares: 5, lastPrice: 200, marketValue: 1000 }),  // no prev
    ];
    const prev = new Map([[1, 125]]);
    const s = buildSummary(holdings, 0, prev);
    // dayChange only from holding 1: 10*(130-125)=50
    expect(s.dayChange).toBe(50);
    // baseline includes holding 2 at its current price (1000), so 1250+1000=2250
    expect(s.dayChangePct).toBeCloseTo((50 / 2250) * 100, 6);
  });

  it("measures the day change against invested value, not net worth", () => {
    // Holdings rose 2%: 10 shares from 100 to 102. Cash equals the holdings,
    // so the old denominator (invested + cash) would report about half the
    // real move. This case exists to make that regression impossible.
    const holdings = [h({
      security_id: 1, shares: 10, lastPrice: 102, marketValue: 1020,
      costBasis: 1000, unrealized: 20,
    })];
    const prev = new Map([[1, 100]]);
    const s = buildSummary(holdings, 1000, prev);

    expect(s.dayChange).toBeCloseTo(20, 6);      // unchanged: 10 * (102 - 100)
    expect(s.dayChangePct).toBeCloseTo(2, 6);    // 20 / 1000, not 20 / 2000
  });

  it("reports no day change percentage for a portfolio of pure cash", () => {
    const s = buildSummary([], 5000, new Map());
    expect(s.dayChange).toBe(0);
    expect(s.dayChangePct).toBe(0);
    expect(Number.isFinite(s.dayChangePct)).toBe(true);
  });

  it("adds liabilities into net worth rather than subtracting them", () => {
    // The Dashboard headline shows Invested, Cash and Owed beside Net worth and
    // invites the reader to check that they add up. They only do if Owed is
    // *added*: `liabilities` is stored negative and renders with its own minus
    // sign. Subtracting it as well overshoots net worth by twice the debt, which
    // is the mistake this test exists to make impossible.
    const holdings = [h({ shares: 10, marketValue: 1020, costBasis: 1000 })];
    const s = buildSummary(holdings, 500, new Map(), -2000);

    expect(s.liabilities).toBe(-2000);
    expect(s.totalValue).toBe(s.investedValue + s.cash + s.liabilities);
    expect(s.totalValue).toBe(1020 + 500 - 2000);
  });
});
