import { describe, it, expect } from "vitest";
import { buildPositions, aggregateHoldings, accountMarketValues } from "./positions";
import type { Transaction, Security } from "./types";

const AAPL: Security = { id: 10, ticker: "AAPL", name: "Apple", type: "stock", currency: "USD" };
const txn = (p: Partial<Transaction>): Transaction => ({
  id: 0, account_id: 1, security_id: 10, type: "buy", date: "2026-01-01",
  quantity: 0, price: 0, amount: 0, fees: 0, note: null, ...p,
});

describe("buildPositions (average cost)", () => {
  it("computes shares, avg cost, market value, unrealized", () => {
    const txns = [
      txn({ type: "buy", date: "2026-01-01", quantity: 10, price: 100 }),
      txn({ type: "buy", date: "2026-02-01", quantity: 10, price: 120 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    expect(pos).toHaveLength(1);
    expect(pos[0].shares).toBe(20);
    expect(pos[0].avgCost).toBe(110);       // (10*100 + 10*120) / 20
    expect(pos[0].costBasis).toBe(2200);
    expect(pos[0].marketValue).toBe(2600);  // 20 * 130
    expect(pos[0].unrealized).toBe(400);
  });

  it("realizes gains on sells at running average cost", () => {
    const txns = [
      txn({ type: "buy", date: "2026-01-01", quantity: 10, price: 100 }),
      txn({ type: "sell", date: "2026-03-01", quantity: 4, price: 150 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 150]]));
    expect(pos[0].shares).toBe(6);
    expect(pos[0].avgCost).toBe(100);
    expect(pos[0].realized).toBe(200);      // 4 * (150 - 100)
    expect(pos[0].costBasis).toBe(600);     // 6 * 100
  });

  it("drops fully-closed positions from holdings but keeps realized", () => {
    const txns = [
      txn({ type: "buy", quantity: 5, price: 100 }),
      txn({ type: "sell", quantity: 5, price: 130 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    expect(pos[0].shares).toBe(0);
    expect(pos[0].realized).toBe(150);
  });
});

describe("aggregateHoldings", () => {
  it("groups positions by security across accounts, weighted avg cost", () => {
    const txns = [
      txn({ account_id: 1, type: "buy", quantity: 10, price: 100 }),
      txn({ account_id: 2, type: "buy", quantity: 10, price: 140 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    const holdings = aggregateHoldings(pos, [AAPL]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].ticker).toBe("AAPL");
    expect(holdings[0].shares).toBe(20);
    expect(holdings[0].avgCost).toBe(120);
    expect(holdings[0].marketValue).toBe(2600);
    expect(holdings[0].unrealizedPct).toBeCloseTo((200 / 2400) * 100, 6);
  });

  it("omits securities with zero shares", () => {
    const txns = [txn({ type: "buy", quantity: 5, price: 100 }), txn({ type: "sell", quantity: 5, price: 130 })];
    const holdings = aggregateHoldings(buildPositions(txns, new Map([[10, 130]])), [AAPL]);
    expect(holdings).toHaveLength(0);
  });
});

describe("accountMarketValues", () => {
  it("adds each account's positions value to its cash", () => {
    const txns = [
      txn({ account_id: 1, type: "deposit", security_id: null, amount: 5000 }),
      txn({ account_id: 1, type: "buy", quantity: 10, price: 100 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    const values = accountMarketValues(pos, txns);
    // cash: 5000 - 1000 = 4000; positions: 10*130 = 1300 → 5300
    expect(values.get(1)).toBe(5300);
  });
});
