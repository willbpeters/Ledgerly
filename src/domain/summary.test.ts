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
});
