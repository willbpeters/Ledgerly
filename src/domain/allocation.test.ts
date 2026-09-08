import { describe, it, expect } from "vitest";
import { allocationByType, allocationByAccount } from "./allocation";
import type { Holding, Account } from "./types";

const h = (p: Partial<Holding>): Holding => ({
  security_id: 1, ticker: "X", type: "stock", shares: 1, avgCost: 1, costBasis: 1,
  lastPrice: 1, marketValue: 100, unrealized: 0, unrealizedPct: 0, realized: 0, ...p,
});

describe("allocationByType", () => {
  it("groups holdings market value by type and appends cash", () => {
    const holdings = [h({ type: "stock", marketValue: 600 }), h({ type: "etf", marketValue: 300 })];
    const slices = allocationByType(holdings, 100);
    const byLabel = Object.fromEntries(slices.map((s) => [s.label, s]));
    expect(byLabel["Stocks"].value).toBe(600);
    expect(byLabel["ETFs"].value).toBe(300);
    expect(byLabel["Cash"].value).toBe(100);
    expect(byLabel["Stocks"].pct).toBeCloseTo(60, 6);
  });
});

describe("allocationByAccount", () => {
  it("labels slices by account name", () => {
    const accounts: Account[] = [
      { id: 1, name: "Brokerage", type: "brokerage", institution: null, currency: "USD", created_at: "",
        source: "manual", external_id: null, synced_balance: null, last_synced_at: null },
      { id: 2, name: "Savings", type: "cash", institution: null, currency: "USD", created_at: "",
        source: "manual", external_id: null, synced_balance: null, last_synced_at: null },
    ];
    const values = new Map([[1, 700], [2, 300]]);
    const slices = allocationByAccount(values, accounts);
    const byLabel = Object.fromEntries(slices.map((s) => [s.label, s]));
    expect(byLabel["Brokerage"].value).toBe(700);
    expect(byLabel["Savings"].pct).toBeCloseTo(30, 6);
  });
});
