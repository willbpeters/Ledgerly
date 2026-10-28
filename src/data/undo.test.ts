import { describe, it, expect, beforeEach } from "vitest";
import { stateOf, askBeforeRemove, setAskBeforeRemove } from "./undo";
import type { BankTransaction } from "../domain/types";

const txn = {
  id: 7, account_id: 1, external_id: "t", posted: "2026-10-01", amount: -9, description: "TARGET",
  payee: "Target", memo: null, mcc: null, pending: false, category_id: 3, category_source: "auto",
  reviewed: false, note: "x", removed: true, splits: [],
} as BankTransaction;

describe("undo", () => {
  it("keeps exactly what an action in Spending can change", () => {
    expect(stateOf(txn)).toEqual({ id: 7, category_id: 3, category_source: "auto", reviewed: false, removed: true });
  });
});

describe("asking before removing", () => {
  beforeEach(() => localStorage.clear());

  it("asks by default", () => {
    expect(askBeforeRemove()).toBe(true);
  });

  it("remembers don't ask again, and can be turned back on", () => {
    setAskBeforeRemove(false);
    expect(askBeforeRemove()).toBe(false);
    setAskBeforeRemove(true);
    expect(askBeforeRemove()).toBe(true);
  });
});
