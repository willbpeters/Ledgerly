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
    expect(s.dayChangePct).toBeCloseTo((50 / 1750) * 100, 6); // vs prior invested+cash
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
});
