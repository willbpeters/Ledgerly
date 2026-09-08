import { describe, it, expect } from "vitest";
import { syncedPositions, mergeCash, manualOnly } from "./synced";
import type { Account, SyncedHolding, Transaction } from "./types";

const acct = (id: number, source: Account["source"], bal: number | null = null): Account => ({
  id, name: `A${id}`, type: "brokerage", institution: null, currency: "USD", created_at: "",
  source, external_id: source === "simplefin" ? `x${id}` : null, synced_balance: bal, last_synced_at: null,
});
const sh = (account_id: number, security_id: number, shares: number, cost: number, mv: number): SyncedHolding =>
  ({ id: security_id, account_id, security_id, shares, cost_basis: cost, market_value: mv, as_of: "2026-09-07" });

describe("syncedPositions", () => {
  it("uses the latest price when known, else the implied price from market value", () => {
    const rows = [sh(1, 10, 10, 2000, 2500), sh(1, 11, 2, 300, 400)];
    const latest = new Map([[10, 260]]);
    const [p1, p2] = syncedPositions(rows, latest);
    expect(p1.lastPrice).toBe(260);
    expect(p1.marketValue).toBe(2600);
    expect(p1.avgCost).toBe(200);
    expect(p1.unrealized).toBe(600);
    expect(p1.realized).toBe(0);
    expect(p2.lastPrice).toBe(200);
    expect(p2.marketValue).toBe(400);
  });
  it("drops zero-share rows", () => {
    expect(syncedPositions([sh(1, 10, 0, 0, 0)], new Map())).toEqual([]);
  });
});

describe("mergeCash", () => {
  it("overrides cash for synced accounts and keeps manual ones", () => {
    const txnCash = new Map([[1, 50], [2, 75]]);
    const out = mergeCash(txnCash, [acct(1, "manual"), acct(2, "simplefin", 999), acct(3, "simplefin", null)]);
    expect(out.get(1)).toBe(50);
    expect(out.get(2)).toBe(999);
    expect(out.get(3)).toBe(0);
  });
});

describe("manualOnly", () => {
  it("filters out transactions belonging to synced accounts", () => {
    const t = (id: number, account_id: number): Transaction =>
      ({ id, account_id, security_id: null, type: "deposit", date: "2026-01-01", quantity: 0, price: 0, amount: 1, fees: 0, note: null });
    const out = manualOnly([t(1, 1), t(2, 2)], [acct(1, "manual"), acct(2, "simplefin")]);
    expect(out.map((x) => x.id)).toEqual([1]);
  });
});
