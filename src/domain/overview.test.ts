import { describe, it, expect } from "vitest";
import { accountOverview, recentActivity, activityWindowStart } from "./overview";
import type { AccountBreakdown } from "./portfolio";
import type { Account, BankTransaction, Security, Transaction } from "./types";

function acct(id: number, name: string, type: Account["type"], hidden = false): Account {
  return { id, name, type, institution: null, currency: "USD", created_at: "", source: "manual",
    external_id: null, synced_balance: null, last_synced_at: null, hidden };
}
const row = (account: Account, value: number): AccountBreakdown =>
  ({ account, holdings: [], holdingsValue: 0, cash: value, value });

describe("accountOverview", () => {
  it("groups brokerage, cash and credit in that order, with totals", () => {
    const groups = accountOverview([
      row(acct(1, "Card", "credit"), -300),
      row(acct(2, "Checking", "cash"), 800),
      row(acct(3, "Roth", "brokerage"), 5000),
      row(acct(4, "Savings", "cash"), 2000),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Brokerage", "Cash", "Credit cards"]);
    expect(groups[1].total).toBe(2800);
    // Largest first within a group.
    expect(groups[1].accounts.map((a) => a.account.name)).toEqual(["Savings", "Checking"]);
    expect(groups[2].total).toBe(-300);
  });

  it("drops empty groups and hidden accounts", () => {
    const groups = accountOverview([row(acct(1, "Old", "credit", true), -50), row(acct(2, "Checking", "cash"), 10)]);
    expect(groups.map((g) => g.label)).toEqual(["Cash"]);
  });
});

function bank(id: number, account_id: number, posted: string, amount: number, p: Partial<BankTransaction> = {}): BankTransaction {
  return { id, account_id, external_id: `e${id}`, posted, amount, description: "POS 1234 WHOLEFDS",
    payee: null, memo: null, mcc: null, pending: false, category_id: null, category_source: "auto",
    reviewed: true, note: null, removed: false, ...p };
}
function txn(id: number, account_id: number, date: string, type: Transaction["type"], p: Partial<Transaction> = {}): Transaction {
  return { id, account_id, security_id: null, type, date, quantity: 0, price: 0, amount: 0, fees: 0, note: null, ...p };
}
const securities: Security[] = [{ id: 10, ticker: "VTI", name: null, type: "etf", currency: "USD" }];
const TODAY = "2026-10-21";

describe("activityWindowStart", () => {
  it("covers today and the six days before", () => {
    expect(activityWindowStart(TODAY, 7)).toBe("2026-10-15");
  });
});

describe("recentActivity", () => {
  const accounts = [acct(1, "Checking", "cash"), acct(2, "Roth", "brokerage"), acct(3, "Hidden", "cash", true)];
  const base = { accounts, securities, today: TODAY, days: 7 };

  it("merges bank and investment transactions, newest first", () => {
    const rows = recentActivity({ ...base,
      bankTxns: [bank(1, 1, "2026-10-18", 3240, { payee: "Payroll" })],
      txns: [txn(2, 2, "2026-10-20", "buy", { security_id: 10, quantity: 5, price: 282.5 })] });
    expect(rows.map((r) => r.description)).toEqual(["Buy 5 VTI", "Payroll"]);
    expect(rows[0]).toMatchObject({ account: "Roth", amount: -1412.5, pending: false });
    expect(rows[1]).toMatchObject({ account: "Checking", amount: 3240 });
  });

  it("keeps the window's edges: today in, seven days back out", () => {
    const rows = recentActivity({ ...base, txns: [],
      bankTxns: [bank(1, 1, "2026-10-14", -1), bank(2, 1, "2026-10-15", -2), bank(3, 1, TODAY, -3), bank(4, 1, "2026-10-22", -4)] });
    expect(rows.map((r) => r.amount)).toEqual([-3, -2]);
  });

  it("leaves out hidden accounts", () => {
    const rows = recentActivity({ ...base, bankTxns: [bank(1, 3, TODAY, -9)], txns: [txn(2, 3, TODAY, "deposit", { amount: 5 })] });
    expect(rows).toEqual([]);
  });

  it("leaves out rows removed in Spending", () => {
    const rows = recentActivity({ ...base, txns: [],
      bankTxns: [bank(1, 1, TODAY, -5), bank(2, 1, TODAY, -40, { removed: true })] });
    expect(rows.map((r) => r.amount)).toEqual([-5]);
  });

  it("falls back to the bank description and flags pending rows", () => {
    const [r] = recentActivity({ ...base, txns: [], bankTxns: [bank(1, 1, TODAY, -84.12, { payee: "  ", pending: true })] });
    expect(r).toMatchObject({ description: "POS 1234 WHOLEFDS", pending: true });
  });

  it("names investment transactions and signs them by their cash effect", () => {
    const rows = recentActivity({ ...base, bankTxns: [], txns: [
      txn(1, 2, TODAY, "sell", { security_id: 10, quantity: 0.12345, price: 100 }),
      txn(2, 2, TODAY, "dividend", { security_id: 10, amount: 12 }),
      txn(3, 2, TODAY, "deposit", { amount: 500 }),
      txn(4, 2, TODAY, "fee", { amount: 3 }),
    ] });
    expect(rows.map((r) => r.description)).toEqual(["Sell 0.123 VTI", "Dividend VTI", "Deposit", "Fee"]);
    expect(rows[0].amount).toBeCloseTo(12.345);
    expect(rows.slice(1).map((r) => r.amount)).toEqual([12, 500, -3]);
  });
});
