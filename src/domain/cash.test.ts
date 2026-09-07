import { describe, it, expect } from "vitest";
import { cashEffect, cashByAccount, totalCash } from "./cash";
import type { Transaction } from "./types";

const t = (p: Partial<Transaction>): Transaction => ({
  id: 0, account_id: 1, security_id: null, type: "deposit", date: "2026-01-01",
  quantity: 0, price: 0, amount: 0, fees: 0, note: null, ...p,
});

describe("cashEffect", () => {
  it("buy reduces cash by cost plus fees", () => {
    expect(cashEffect(t({ type: "buy", quantity: 10, price: 50, fees: 1 }))).toBe(-501);
  });
  it("sell increases cash by proceeds minus fees", () => {
    expect(cashEffect(t({ type: "sell", quantity: 10, price: 50, fees: 1 }))).toBe(499);
  });
  it("deposit/dividend/interest add amount; withdrawal/fee subtract", () => {
    expect(cashEffect(t({ type: "deposit", amount: 100 }))).toBe(100);
    expect(cashEffect(t({ type: "dividend", amount: 5 }))).toBe(5);
    expect(cashEffect(t({ type: "interest", amount: 2 }))).toBe(2);
    expect(cashEffect(t({ type: "withdrawal", amount: 40 }))).toBe(-40);
    expect(cashEffect(t({ type: "fee", amount: 3 }))).toBe(-3);
  });
});

describe("cashByAccount / totalCash", () => {
  it("sums per account and overall", () => {
    const txns = [
      t({ account_id: 1, type: "deposit", amount: 1000 }),
      t({ account_id: 1, type: "buy", quantity: 10, price: 50, fees: 0 }),
      t({ account_id: 2, type: "deposit", amount: 300 }),
    ];
    const byAcct = cashByAccount(txns);
    expect(byAcct.get(1)).toBe(500);
    expect(byAcct.get(2)).toBe(300);
    expect(totalCash(txns)).toBe(800);
  });
});
