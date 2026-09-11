import { describe, it, expect } from "vitest";
import { monthWindow, monthLabel, shiftMonth, summariseMonth, limitFor, fromVisibleAccounts } from "./spending";
import type { Account, BankTransaction, Budget, Category } from "./types";

const cats: Category[] = [
  { id: 1, name: "Groceries", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true },
  { id: 2, name: "Dining", kind: "spending", colour: "chart-2", sort: 20, is_builtin: true },
  { id: 3, name: "Income", kind: "income", colour: "chart-3", sort: 30, is_builtin: true },
  { id: 4, name: "Transfer", kind: "transfer", colour: "chart-6", sort: 40, is_builtin: true },
];

let n = 0;
const txn = (amount: number, category_id: number | null, posted = "2026-09-10"): BankTransaction => ({
  id: ++n, account_id: 1, external_id: `e${n}`, posted, amount,
  description: "x", payee: null, memo: null, mcc: null, pending: false,
  category_id, category_source: "auto",
});

describe("month helpers", () => {
  it("gives the first and last day of a month, including February", () => {
    expect(monthWindow("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(monthWindow("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthWindow("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthWindow("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("steps across a year boundary in both directions", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-09", 0)).toBe("2026-09");
  });

  it("labels a month for a human", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
  });
});

describe("summariseMonth", () => {
  it("separates money out, money in, and ignores transfers entirely", () => {
    const s = summariseMonth([
      txn(-85.5, 1), txn(-30, 1), txn(-42, 2),
      txn(2400, 3),
      txn(-500, 4), txn(500, 4),   // a transfer between own accounts
    ], cats, [], "2026-09");

    expect(s.spent).toBe(157.5);
    expect(s.income).toBe(2400);
    expect(s.net).toBe(2400 - 157.5);
    expect(s.transferred).toBe(500);
  });

  it("reports spending as a positive number per category, largest first", () => {
    const s = summariseMonth([txn(-30, 1), txn(-42, 2), txn(-85.5, 1)], cats, [], "2026-09");
    const spending = s.categories.filter((c) => c.category.kind === "spending");
    expect(spending.map((c) => c.category.name)).toEqual(["Groceries", "Dining"]);
    expect(spending[0].spent).toBe(115.5);
    expect(spending[1].spent).toBe(42);
  });

  it("counts what is not categorised yet", () => {
    const s = summariseMonth([txn(-10, null), txn(-5, null), txn(-1, 1)], cats, [], "2026-09");
    expect(s.uncategorisedCount).toBe(2);
    expect(s.uncategorisedTotal).toBe(15);
  });

  it("treats a refund as reducing that category rather than as income", () => {
    const s = summariseMonth([txn(-100, 1), txn(20, 1)], cats, [], "2026-09");
    const groceries = s.categories.find((c) => c.category.id === 1);
    expect(groceries?.spent).toBe(80);
    expect(s.income).toBe(0);
  });

  it("carries the budget, what is left, and how far through it you are", () => {
    const budgets: Budget[] = [
      { id: 1, category_id: 1, month: null, limit_amount: 400 },
      { id: 2, category_id: 2, month: "2026-09", limit_amount: 100 },
    ];
    const s = summariseMonth([txn(-300, 1), txn(-120, 2)], cats, budgets, "2026-09");
    const groceries = s.categories.find((c) => c.category.id === 1)!;
    expect(groceries.limit).toBe(400);
    expect(groceries.remaining).toBe(100);
    expect(groceries.progress).toBeCloseTo(0.75);
    expect(groceries.over).toBe(false);

    const dining = s.categories.find((c) => c.category.id === 2)!;
    expect(dining.limit).toBe(100);
    expect(dining.remaining).toBe(-20);
    expect(dining.over).toBe(true);
    // the bar never runs past full
    expect(dining.progress).toBe(1);

    expect(s.budgeted).toBe(500);
  });

  it("ignores transactions outside the month", () => {
    const s = summariseMonth([txn(-10, 1, "2026-08-31"), txn(-5, 1, "2026-09-01"), txn(-1, 1, "2026-10-01")], cats, [], "2026-09");
    expect(s.spent).toBe(5);
  });

  it("copes with no transactions at all", () => {
    const s = summariseMonth([], cats, [], "2026-09");
    expect(s.spent).toBe(0);
    expect(s.income).toBe(0);
    expect(s.categories.every((c) => c.spent === 0)).toBe(true);
  });
});

describe("limitFor", () => {
  const budgets: Budget[] = [
    { id: 1, category_id: 1, month: null, limit_amount: 400 },
    { id: 2, category_id: 1, month: "2026-09", limit_amount: 550 },
  ];
  it("prefers a limit set for that month over the every-month default", () => {
    expect(limitFor(budgets, 1, "2026-09")).toBe(550);
    expect(limitFor(budgets, 1, "2026-10")).toBe(400);
    expect(limitFor(budgets, 2, "2026-09")).toBe(null);
  });
});

describe("fromVisibleAccounts", () => {
  const accounts: Account[] = [
    { id: 1, name: "Everyday", type: "cash", institution: null, currency: "USD", created_at: "",
      source: "simplefin", external_id: "a", synced_balance: 100, last_synced_at: null, hidden: false },
    { id: 2, name: "Old Card", type: "credit", institution: null, currency: "USD", created_at: "",
      source: "simplefin", external_id: "b", synced_balance: -50, last_synced_at: null, hidden: true },
  ];
  const rows = [
    { id: 1, account_id: 1, external_id: "x", posted: "2026-09-01", amount: -20, description: "Shop",
      payee: null, memo: null, mcc: null, pending: false, category_id: null, category_source: "auto" },
    { id: 2, account_id: 2, external_id: "y", posted: "2026-09-02", amount: -999, description: "Hidden spend",
      payee: null, memo: null, mcc: null, pending: false, category_id: null, category_source: "auto" },
  ] as BankTransaction[];

  it("drops transactions belonging to a hidden account", () => {
    // Hidden means out of every total, so hidden spending must not inflate the month.
    expect(fromVisibleAccounts(rows, accounts).map((t) => t.id)).toEqual([1]);
  });

  it("keeps everything when no account is hidden", () => {
    const visible = accounts.map((a) => ({ ...a, hidden: false }));
    expect(fromVisibleAccounts(rows, visible)).toHaveLength(2);
  });

  it("keeps a transaction whose account is not in the list rather than losing it silently", () => {
    expect(fromVisibleAccounts(rows, [accounts[0]]).map((t) => t.id)).toEqual([1, 2]);
  });
});
