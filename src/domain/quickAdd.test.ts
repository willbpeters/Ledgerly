import { describe, it, expect } from "vitest";
import { quickAddTransactions } from "./quickAdd";
import { totalCash } from "./cash";
import type { Transaction } from "./types";

const input = { accountId: 7, securityId: 3, date: "2026-09-08", shares: 10, pricePerShare: 25 };

/** The rows as they would look once stored, so the real cash maths can read them. */
function asStored(): Transaction[] {
  return quickAddTransactions(input).map((t, i) => ({ ...t, id: i + 1 }) as Transaction);
}

describe("quickAddTransactions", () => {
  it("records the buy that was asked for", () => {
    const buy = quickAddTransactions(input).find((t) => t.type === "buy");
    expect(buy).toMatchObject({
      account_id: 7, security_id: 3, date: "2026-09-08",
      quantity: 10, price: 25, amount: 250, fees: 0,
    });
  });

  it("leaves the account's cash unchanged", () => {
    // A quick add says "I already own this", not "I spent cash today". Without a
    // matching deposit the buy alone drives cash — and so net worth — negative.
    expect(totalCash(asStored())).toBe(0);
  });

  it("funds the buy with a deposit on the same date", () => {
    const deposit = quickAddTransactions(input).find((t) => t.type === "deposit");
    expect(deposit).toMatchObject({ account_id: 7, security_id: null, date: "2026-09-08", amount: 250 });
  });

  it("labels the deposit so it is obvious where it came from", () => {
    const deposit = quickAddTransactions(input).find((t) => t.type === "deposit");
    expect(deposit?.note).toMatch(/quick add/i);
  });

  it("puts the deposit before the buy so the account is never overdrawn", () => {
    expect(quickAddTransactions(input).map((t) => t.type)).toEqual(["deposit", "buy"]);
  });
});
