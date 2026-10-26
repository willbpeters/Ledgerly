import { describe, it, expect } from "vitest";
import { parseSearch, searchTransactions } from "./search";
import type { Account, BankTransaction, Category } from "./types";

const cats: Category[] = [
  { id: 1, name: "Groceries", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true },
  { id: 2, name: "Dining", kind: "spending", colour: "chart-2", sort: 20, is_builtin: true },
];
const accts = [
  { id: 1, name: "Chase Checking" },
  { id: 2, name: "Amex Gold" },
] as Account[];

let n = 0;
const txn = (over: Partial<BankTransaction>): BankTransaction => ({
  id: ++n, account_id: 1, external_id: `e${n}`, posted: "2026-09-10", amount: -10,
  description: "x", payee: null, memo: null, mcc: null, pending: false,
  category_id: null, category_source: "auto", reviewed: true, note: null, removed: false,
  ...over,
});

const ctx = { categories: cats, accounts: accts };
const all = { text: "", categoryId: null, accountId: null };

describe("parseSearch", () => {
  it("splits words and lowercases them", () => {
    expect(parseSearch("  Whole   FOODS ")).toEqual({ words: ["whole", "foods"], amounts: [] });
  });

  it("reads an amount with an operator, a dollar sign and commas", () => {
    expect(parseSearch(">1,200.50").amounts).toEqual([{ op: ">", value: 1200.5 }]);
    expect(parseSearch("<=$20").amounts).toEqual([{ op: "<=", value: 20 }]);
    expect(parseSearch("$42.10").amounts).toEqual([{ op: "~", value: 42.1 }]);
  });

  it("keeps a bare number as a word too, since it may be in a name", () => {
    const q = parseSearch("7");
    expect(q.words).toEqual(["7"]);
    expect(q.amounts).toEqual([{ op: "~", value: 7 }]);
  });
});

describe("searchTransactions", () => {
  it("matches every word, in any field, ignoring case", () => {
    const a = txn({ payee: "Whole Foods", description: "WHOLEFDS MKT #123" });
    const b = txn({ payee: "Whole Earth Bakery" });
    expect(searchTransactions([a, b], { ...all, text: "whole foods" }, ctx)).toEqual([a]);
  });

  it("finds words in the memo, the note, the category and the account", () => {
    const memo = txn({ memo: "birthday gift" });
    const note = txn({ note: "split with Sam" });
    const cat = txn({ category_id: 2 });
    const acct = txn({ account_id: 2 });
    expect(searchTransactions([memo, note, cat, acct], { ...all, text: "gift" }, ctx)).toEqual([memo]);
    expect(searchTransactions([memo, note, cat, acct], { ...all, text: "sam" }, ctx)).toEqual([note]);
    expect(searchTransactions([memo, note, cat, acct], { ...all, text: "dining" }, ctx)).toEqual([cat]);
    expect(searchTransactions([memo, note, cat, acct], { ...all, text: "amex" }, ctx)).toEqual([acct]);
  });

  it("matches a bare amount to the cent, whichever way the money moved", () => {
    const out = txn({ amount: -42.1 });
    const back = txn({ amount: 42.1 });
    const other = txn({ amount: -42.11 });
    expect(searchTransactions([out, back, other], { ...all, text: "42.10" }, ctx)).toEqual([out, back]);
  });

  it("lets a bare number match a name instead of an amount", () => {
    const store = txn({ payee: "7-Eleven", amount: -3.5 });
    const seven = txn({ amount: -7 });
    expect(searchTransactions([store, seven], { ...all, text: "7" }, ctx)).toEqual([store, seven]);
  });

  it("compares sizes with > and <, ignoring the sign", () => {
    const small = txn({ amount: -20 });
    const big = txn({ amount: -250 });
    const pay = txn({ amount: 3000 });
    expect(searchTransactions([small, big, pay], { ...all, text: ">100" }, ctx)).toEqual([big, pay]);
    expect(searchTransactions([small, big, pay], { ...all, text: "<=20" }, ctx)).toEqual([small]);
    expect(searchTransactions([small, big, pay], { ...all, text: ">100 <1000" }, ctx)).toEqual([big]);
  });

  it("filters by category, including uncategorised, and by account", () => {
    const groceries = txn({ category_id: 1 });
    const none = txn({ category_id: null, account_id: 2 });
    expect(searchTransactions([groceries, none], { ...all, categoryId: 1 }, ctx)).toEqual([groceries]);
    expect(searchTransactions([groceries, none], { ...all, categoryId: "uncategorised" }, ctx)).toEqual([none]);
    expect(searchTransactions([groceries, none], { ...all, accountId: 2 }, ctx)).toEqual([none]);
  });

  it("puts the newest first", () => {
    const old = txn({ posted: "2025-01-02" });
    const recent = txn({ posted: "2026-10-01" });
    const mid = txn({ posted: "2026-03-15" });
    expect(searchTransactions([old, recent, mid], all, ctx)).toEqual([recent, mid, old]);
  });
});
