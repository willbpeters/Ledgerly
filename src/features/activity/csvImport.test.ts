import { describe, it, expect } from "vitest";
import { rowsToTransactions, type ColumnMap } from "./csvImport";

const map: ColumnMap = { date: "Date", type: "Action", ticker: "Symbol", quantity: "Qty", price: "Price", amount: "Amount", fees: "Fee" };

describe("rowsToTransactions", () => {
  it("maps valid rows and reports errors for bad ones", () => {
    const rows = [
      { Date: "2026-01-02", Action: "buy", Symbol: "VOO", Qty: "10", Price: "100", Amount: "", Fee: "1" },
      { Date: "", Action: "buy", Symbol: "AAPL", Qty: "5", Price: "150", Amount: "", Fee: "0" }, // missing date
      { Date: "2026-01-05", Action: "wat", Symbol: "X", Qty: "1", Price: "1", Amount: "", Fee: "0" }, // bad type
    ];
    const { valid, errors } = rowsToTransactions(rows, map, 7 /* accountId */);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ account_id: 7, type: "buy", quantity: 10, price: 100, fees: 1, amount: 1000 });
    expect(valid[0].tickerRaw).toBe("VOO");
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(2);
    expect(errors[1].reason).toMatch(/type/i);
  });
});
