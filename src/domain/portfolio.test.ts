import { describe, it, expect } from "vitest";
import { derivePortfolio } from "./portfolio";
import type { Account, Security, SyncedHolding, Transaction } from "./types";

const accounts: Account[] = [
  { id: 1, name: "Manual", type: "brokerage", institution: null, currency: "USD", created_at: "", source: "manual", external_id: null, synced_balance: null, last_synced_at: null, hidden: false },
  { id: 2, name: "Synced", type: "brokerage", institution: "Demo", currency: "USD", created_at: "", source: "simplefin", external_id: "x", synced_balance: 850, last_synced_at: "2026-09-07T00:00:00Z", hidden: false },
];
const securities: Security[] = [{ id: 10, ticker: "VTI", name: null, type: "etf", currency: "USD" }];
const txns: Transaction[] = [
  { id: 1, account_id: 1, security_id: null, type: "deposit", date: "2026-01-01", quantity: 0, price: 0, amount: 1000, fees: 0, note: null },
  { id: 2, account_id: 1, security_id: 10, type: "buy", date: "2026-01-02", quantity: 2, price: 200, amount: 400, fees: 0, note: null },
  // a stray transaction in the synced account must not affect cash or shares
  { id: 3, account_id: 2, security_id: 10, type: "buy", date: "2026-01-03", quantity: 50, price: 1, amount: 50, fees: 0, note: null },
];
const synced: SyncedHolding[] = [{ id: 1, account_id: 2, security_id: 10, shares: 3, cost_basis: 600, market_value: 750, as_of: "2026-09-07" }];

describe("derivePortfolio", () => {
  it("merges manual and synced accounts without double counting", () => {
    const p = derivePortfolio({ txns, securities, accounts, latest: [[10, 250]], previous: [[10, 240]], synced });
    expect(p.holdings).toHaveLength(1);
    expect(p.holdings[0].shares).toBe(5);           // 2 manual + 3 synced
    expect(p.holdings[0].marketValue).toBe(1250);
    expect(p.cash).toBe(600 + 100);                  // manual: 1000 - 400; synced: 100
    expect(p.summary.totalValue).toBe(1250 + 700);
    expect(p.accountValues.get(1)).toBe(600 + 500);
    expect(p.accountValues.get(2)).toBe(100 + 750);
    expect(p.byAccount.find((b) => b.account.id === 2)?.holdings[0].shares).toBe(3);
    expect(p.summary.dayChange).toBe(5 * 10);
  });

  // SimpleFIN's `balance` for an investment account is the whole account,
  // holdings included. Adding the holdings on top of it counted them twice and
  // showed a fully-invested brokerage at double its real worth.
  it("does not count a synced brokerage's holdings twice", () => {
    const fullyInvested: Account[] = [{ ...accounts[1], synced_balance: 750 }];
    const p = derivePortfolio({
      txns: [], securities, accounts: fullyInvested,
      latest: [[10, 250]], previous: [[10, 250]], synced,
    });
    expect(p.accountValues.get(2)).toBe(750);
    expect(p.cash).toBe(0);
    expect(p.summary.totalValue).toBe(750);
  });

  // The uninvested remainder is real cash and must survive.
  it("keeps the part of a synced balance that is not in holdings as cash", () => {
    const p = derivePortfolio({ txns, securities, accounts, latest: [[10, 250]], previous: [[10, 240]], synced });
    expect(p.byAccount.find((b) => b.account.id === 2)?.cash).toBe(100);
  });
});

describe("derivePortfolio with a credit card", () => {
  const card: Account = { id: 3, name: "Card", type: "credit", institution: "Chase", currency: "USD",
    created_at: "", source: "simplefin", external_id: "c", synced_balance: -1200, last_synced_at: null, hidden: false };

  it("subtracts what is owed from net worth without touching cash", () => {
    const withCard = derivePortfolio({ txns, securities, accounts: [...accounts, card],
      latest: [[10, 250]], previous: [[10, 240]], synced });
    const without = derivePortfolio({ txns, securities, accounts, latest: [[10, 250]], previous: [[10, 240]], synced });

    expect(withCard.summary.liabilities).toBe(-1200);
    expect(withCard.summary.cash).toBe(without.summary.cash);
    expect(withCard.summary.totalValue).toBe(without.summary.totalValue - 1200);
  });

  it("keeps a debt out of the allocation chart", () => {
    const p = derivePortfolio({ txns, securities, accounts: [...accounts, card],
      latest: [[10, 250]], previous: [[10, 240]], synced });
    expect(p.allocationAccount.some((s) => s.label === "Card")).toBe(false);
    expect(p.allocationAccount.every((s) => s.value > 0)).toBe(true);
  });

  it("reports no liabilities when there is no credit account", () => {
    const p = derivePortfolio({ txns, securities, accounts, latest: [[10, 250]], previous: [[10, 240]], synced });
    expect(p.summary.liabilities).toBe(0);
  });
});

describe("derivePortfolio with hidden accounts", () => {
  const hiddenManual: Account[] = [{ ...accounts[0], hidden: true }, accounts[1]];
  const hiddenSynced: Account[] = [accounts[0], { ...accounts[1], hidden: true }];
  const prices = { latest: [[10, 250]] as [number, number][], previous: [[10, 240]] as [number, number][] };

  it("leaves a hidden manual account out of cash and net worth", () => {
    const p = derivePortfolio({ txns, securities, accounts: hiddenManual, ...prices, synced });
    // Only the synced account's 100 cash remains; the manual 600 is gone.
    expect(p.cash).toBe(100);
    // And its 2 shares go with it, leaving only the 3 synced shares.
    expect(p.holdings[0].shares).toBe(3);
    expect(p.summary.totalValue).toBe(750 + 100);
  });

  it("leaves a hidden synced account out of cash and net worth", () => {
    const p = derivePortfolio({ txns, securities, accounts: hiddenSynced, ...prices, synced });
    expect(p.cash).toBe(600);
    expect(p.holdings[0].shares).toBe(2);
    expect(p.summary.totalValue).toBe(500 + 600);
  });

  it("gives a hidden account no value of its own", () => {
    const p = derivePortfolio({ txns, securities, accounts: hiddenManual, ...prices, synced });
    expect(p.accountValues.has(1)).toBe(false);
  });

  it("keeps hidden accounts out of the per-account breakdown and allocation", () => {
    const p = derivePortfolio({ txns, securities, accounts: hiddenManual, ...prices, synced });
    expect(p.byAccount.some((b) => b.account.id === 1)).toBe(false);
    expect(p.allocationAccount.some((s) => s.label === "Manual")).toBe(false);
  });

  it("does not list hidden accounts, so the rails and pickers skip them too", () => {
    const p = derivePortfolio({ txns, securities, accounts: hiddenManual, ...prices, synced });
    expect(p.accounts.map((a) => a.id)).toEqual([2]);
  });

  it("changes nothing when no account is hidden", () => {
    const visible = accounts.map((a) => ({ ...a, hidden: false }));
    const p = derivePortfolio({ txns, securities, accounts: visible, ...prices, synced });
    expect(p.summary.totalValue).toBe(1250 + 700);
    expect(p.accounts).toHaveLength(2);
  });
});
