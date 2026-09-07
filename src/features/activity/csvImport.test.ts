import { describe, it, expect } from "vitest";
import { rowsToTransactions, type ColumnMap } from "./csvImport";

const map: ColumnMap = { date: "Date", type: "Action", ticker: "Symbol", quantity: "Qty", price: "Price", amount: "Amount", fees: "Fee" };

describe("rowsToTransactions", () => {
  it("maps valid rows and reports errors for bad ones (line numbers include header)", () => {
    const rows = [
      { Date: "2026-01-02", Action: "buy", Symbol: "VOO", Qty: "10", Price: "100", Amount: "", Fee: "1" },
      { Date: "", Action: "buy", Symbol: "AAPL", Qty: "5", Price: "150", Amount: "", Fee: "0" }, // missing date → file line 3
      { Date: "2026-01-05", Action: "wat", Symbol: "X", Qty: "1", Price: "1", Amount: "", Fee: "0" }, // bad type → file line 4
    ];
    const { valid, errors } = rowsToTransactions(rows, map, 7 /* accountId */);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ account_id: 7, type: "buy", quantity: 10, price: 100, fees: 1, amount: 1000 });
    expect(valid[0].tickerRaw).toBe("VOO");
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(3); // header is line 1, first data row line 2
    expect(errors[1].reason).toMatch(/type/i);
  });

  it("strips $ and commas from numeric cells", () => {
    const rows = [{ Date: "2026-01-02", Action: "buy", Symbol: "VOO", Qty: "10", Price: "$1,234.50", Amount: "", Fee: "$1" }];
    const { valid, errors } = rowsToTransactions(rows, map, 1);
    expect(errors).toHaveLength(0);
    expect(valid[0].price).toBe(1234.5);
    expect(valid[0].amount).toBe(12345);
    expect(valid[0].fees).toBe(1);
  });

  it("rejects non-numeric, zero, or negative quantity/price on buy/sell", () => {
    const rows = [
      { Date: "2026-01-02", Action: "buy", Symbol: "A", Qty: "ten", Price: "100", Amount: "", Fee: "" },
      { Date: "2026-01-02", Action: "buy", Symbol: "A", Qty: "-10", Price: "100", Amount: "", Fee: "" },
      { Date: "2026-01-02", Action: "buy", Symbol: "A", Qty: "10", Price: "", Amount: "", Fee: "" },
      { Date: "2026-01-02", Action: "sell", Symbol: "A", Qty: "0", Price: "100", Amount: "", Fee: "" },
    ];
    const { valid, errors } = rowsToTransactions(rows, map, 1);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(4);
    expect(errors.some((e) => /quantity/i.test(e.reason))).toBe(true);
    expect(errors.some((e) => /price/i.test(e.reason))).toBe(true);
  });

  it("requires a positive amount for cash-type transactions", () => {
    const rows = [
      { Date: "2026-01-02", Action: "deposit", Symbol: "", Qty: "", Price: "", Amount: "500", Fee: "" },
      { Date: "2026-01-02", Action: "withdrawal", Symbol: "", Qty: "", Price: "", Amount: "", Fee: "" }, // no amount
      { Date: "2026-01-02", Action: "fee", Symbol: "", Qty: "", Price: "", Amount: "-3", Fee: "" }, // negative
    ];
    const { valid, errors } = rowsToTransactions(rows, map, 1);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ type: "deposit", amount: 500, quantity: 0, price: 0 });
    expect(errors).toHaveLength(2);
  });

  it("requires a ticker for dividend and treats it as amount-based", () => {
    const rows = [
      { Date: "2026-01-02", Action: "dividend", Symbol: "", Qty: "", Price: "", Amount: "12", Fee: "" }, // no ticker
      { Date: "2026-01-02", Action: "dividend", Symbol: "VOO", Qty: "", Price: "", Amount: "12", Fee: "" },
    ];
    const { valid, errors } = rowsToTransactions(rows, map, 1);
    expect(errors).toHaveLength(1);
    expect(errors[0].reason).toMatch(/ticker/i);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ type: "dividend", tickerRaw: "VOO", amount: 12 });
  });
});
