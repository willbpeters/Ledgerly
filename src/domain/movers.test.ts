import { describe, it, expect } from "vitest";
import { buildMovers, attentionItems } from "./movers";
import type { Account, Holding } from "./types";

const holding = (security_id: number, ticker: string, shares: number, lastPrice: number): Holding => ({
  security_id, ticker, type: "stock", shares, avgCost: 0, costBasis: 0,
  lastPrice, marketValue: shares * lastPrice, unrealized: 0, unrealizedPct: 0, realized: 0,
});

const account = (id: number, source: Account["source"], last_synced_at: string | null): Account => ({
  id, name: `A${id}`, type: "brokerage", institution: null, currency: "USD", created_at: "",
  source, external_id: null, synced_balance: null, last_synced_at,
});

describe("buildMovers", () => {
  it("computes the day change per holding and sorts by size of move", () => {
    const holdings = [holding(1, "VTI", 10, 110), holding(2, "AAPL", 5, 90), holding(3, "MSFT", 2, 100)];
    const previous = new Map([[1, 100], [2, 100], [3, 99]]);
    const movers = buildMovers(holdings, previous);
    expect(movers.map((m) => m.ticker)).toEqual(["VTI", "AAPL", "MSFT"]);
    expect(movers[0].change).toBe(100);   // 10 * +10
    expect(movers[1].change).toBe(-50);   // 5 * -10
    expect(movers[2].change).toBe(2);     // 2 * +1
    expect(movers[0].changePct).toBeCloseTo(10);
    expect(movers[1].changePct).toBeCloseTo(-10);
  });

  it("skips holdings with no previous close rather than showing a fake zero", () => {
    const movers = buildMovers([holding(1, "VTI", 10, 110), holding(2, "NEW", 3, 50)], new Map([[1, 100]]));
    expect(movers).toHaveLength(1);
    expect(movers[0].ticker).toBe("VTI");
  });

  it("scales each bar against the largest absolute move", () => {
    const movers = buildMovers([holding(1, "A", 10, 110), holding(2, "B", 1, 95)], new Map([[1, 100], [2, 100]]));
    expect(movers[0].weight).toBe(1);
    expect(movers[1].weight).toBeCloseTo(0.05);
  });

  it("returns nothing when there are no holdings", () => {
    expect(buildMovers([], new Map())).toEqual([]);
  });
});

describe("attentionItems", () => {
  const fresh = "2026-09-07T11:30:00Z";
  const now = new Date("2026-09-07T12:00:00Z");

  it("is empty when everything is healthy", () => {
    const items = attentionItems({
      accounts: [account(1, "simplefin", fresh)],
      holdings: [holding(1, "VTI", 10, 110)],
      connected: true, skippedHoldings: 0, now,
    });
    expect(items).toEqual([]);
  });

  it("flags a sync that has not run for over a day", () => {
    const items = attentionItems({
      accounts: [account(1, "simplefin", "2026-09-05T12:00:00Z")],
      holdings: [], connected: true, skippedHoldings: 0, now,
    });
    expect(items).toHaveLength(1);
    expect(items[0].tone).toBe("warn");
    expect(items[0].title).toMatch(/2 days/);
  });

  it("flags holdings that have no price yet", () => {
    const items = attentionItems({
      accounts: [], holdings: [holding(1, "VTI", 10, 0), holding(2, "AAPL", 5, 0)],
      connected: false, skippedHoldings: 0, now,
    });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("2 holdings have no price yet");
  });

  it("flags holdings SimpleFIN skipped for having no ticker", () => {
    const items = attentionItems({
      accounts: [account(1, "simplefin", fresh)], holdings: [],
      connected: true, skippedHoldings: 3, now,
    });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("3 synced holdings had no ticker");
  });

  it("says nothing about syncing when SimpleFIN is not connected", () => {
    const items = attentionItems({
      accounts: [account(1, "manual", null)], holdings: [],
      connected: false, skippedHoldings: 0, now,
    });
    expect(items).toEqual([]);
  });
});
