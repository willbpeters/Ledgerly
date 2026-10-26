import { describe, it, expect } from "vitest";
import { piecesOf, splitRemainder, validateSplits, inCategory } from "./splits";
import type { BankTransaction, TxnSplit } from "./types";

const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 1, account_id: 1, external_id: "e1", posted: "2026-10-03", amount: -85.5,
  description: "COSTCO", payee: "Costco", memo: null, mcc: null, pending: false,
  category_id: 1, category_source: "auto", reviewed: true, note: null, removed: false, splits: [],
  ...over,
});
const piece = (id: number, category_id: number | null, amount: number): TxnSplit =>
  ({ id, category_id, amount, note: null });
const costco = txn({ category_id: null, category_source: "manual", splits: [piece(1, 1, -60), piece(2, 2, -25.5)] });

describe("piecesOf", () => {
  it("is the whole transaction when it is not split", () => {
    expect(piecesOf(txn())).toEqual([{ category_id: 1, amount: -85.5 }]);
  });

  it("is the pieces of a split transaction", () => {
    expect(piecesOf(costco)).toEqual([{ category_id: 1, amount: -60 }, { category_id: 2, amount: -25.5 }]);
  });

  it("adds what the pieces no longer cover, uncategorised, after the bank changed the amount", () => {
    expect(piecesOf({ ...costco, amount: -90 })).toEqual([
      { category_id: 1, amount: -60 }, { category_id: 2, amount: -25.5 },
      { category_id: null, amount: -4.5, remainder: true },
    ]);
  });

  it("ignores a difference smaller than half a cent", () => {
    expect(piecesOf({ ...costco, amount: -85.501 })).toHaveLength(2);
  });
});

describe("splitRemainder", () => {
  it("is nothing for a row that is not split, or whose pieces add up", () => {
    expect(splitRemainder(txn())).toBe(0);
    expect(splitRemainder(costco)).toBe(0);
  });

  it("is what the pieces no longer cover", () => {
    expect(splitRemainder({ ...costco, amount: -90 })).toBe(-4.5);
  });
});

describe("validateSplits", () => {
  const p = (category_id: number | null, amount: number) => ({ category_id, amount });

  it("accepts pieces that add up", () => {
    expect(validateSplits(-85.5, [p(1, -60), p(2, -25.5)])).toEqual({ left: 0, problem: null });
  });

  it("says how much is left to assign", () => {
    expect(validateSplits(-85.5, [p(1, -60), p(2, -20)])).toEqual({ left: -5.5, problem: "short" });
  });

  it("says when the pieces come to more than the transaction", () => {
    expect(validateSplits(-85.5, [p(1, -60), p(2, -30)])).toEqual({ left: 4.5, problem: "over" });
  });

  it("works the same way for money in", () => {
    expect(validateSplits(100, [p(1, 70), p(2, 20)])).toEqual({ left: 10, problem: "short" });
  });

  it("needs an amount in every piece", () => {
    expect(validateSplits(-85.5, [p(1, -85.5), p(2, 0)]).problem).toBe("no-amount");
  });

  it("needs at least two pieces", () => {
    expect(validateSplits(-85.5, [p(1, -85.5)]).problem).toBe("too-few");
    expect(validateSplits(-85.5, []).problem).toBe("too-few");
  });

  it("says when a refund is split into more than it was", () => {
    expect(validateSplits(100, [p(1, 70), p(2, 40)])).toEqual({ left: -10, problem: "over" });
  });

  it("rounds half a cent away from zero, as Rust does", () => {
    // Rust: -13 + 13 = 0, not the 1 cent the transaction is. Math.round would say -12 + 13 = 1.
    expect(validateSplits(0.01, [p(1, -0.125), p(2, 0.125)]).problem).toBe("short");
    // -0.005 is one cent, not nothing.
    expect(validateSplits(-0.01, [p(1, -0.005), p(2, -0.005)]).problem).toBe("over");
  });

  it("treats an amount that is not a number as missing", () => {
    expect(validateSplits(-85.5, [p(1, -85.5), p(2, NaN)]).problem).toBe("no-amount");
    expect(validateSplits(-85.5, [p(1, -85.5), p(2, Infinity)]).problem).toBe("no-amount");
  });
});

describe("inCategory", () => {
  it("reads the row's own category when it is not split", () => {
    expect(inCategory(txn(), 1)).toBe(true);
    expect(inCategory(txn(), 2)).toBe(false);
    expect(inCategory(txn({ category_id: null }), "uncategorised")).toBe(true);
  });

  it("finds a split transaction under any of its pieces", () => {
    expect(inCategory(costco, 2)).toBe(true);
    expect(inCategory(costco, 3)).toBe(false);
    expect(inCategory(costco, "uncategorised")).toBe(false);
  });

  it("finds a split transaction with an uncategorised piece under uncategorised", () => {
    const t = txn({ category_id: null, splits: [piece(1, 1, -60), piece(2, null, -25.5)] });
    expect(inCategory(t, "uncategorised")).toBe(true);
    expect(inCategory(t, 1)).toBe(true);
  });

  it("counts an uncovered remainder as uncategorised", () => {
    expect(inCategory({ ...costco, amount: -90 }, "uncategorised")).toBe(true);
  });
});
