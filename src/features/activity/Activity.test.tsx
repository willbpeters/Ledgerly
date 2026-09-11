import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account, BankTransaction, Category, Security, Transaction } from "../../domain/types";

function account(id: number, name: string, source: Account["source"], hidden = false): Account {
  return {
    id, name, type: source === "simplefin" ? "credit" : "brokerage", institution: null,
    currency: "USD", created_at: "", source, external_id: source === "simplefin" ? "x" : null,
    synced_balance: source === "simplefin" ? -250 : null, last_synced_at: null, hidden,
  };
}
function bankTxn(id: number, accountId: number, description: string, amount: number): BankTransaction {
  return {
    id, account_id: accountId, external_id: `e${id}`, posted: "2026-09-05", amount,
    description, payee: description, memo: null, mcc: null, pending: false,
    category_id: 1, category_source: "auto",
  };
}

let accounts: Account[] = [];
let txns: Transaction[] = [];
let bankTxns: BankTransaction[] = [];
let range: [string | null, string | null] = ["2026-06-01", "2026-09-08"];

const securities: Security[] = [{ id: 10, ticker: "VTI", name: null, type: "etf", currency: "USD" }];
const categories: Category[] = [
  { id: 1, name: "Groceries", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true },
];

vi.mock("../../data/queries", () => ({
  useTransactions: () => ({ data: txns }),
  useSecurities: () => ({ data: securities }),
  useAccounts: () => ({ data: accounts }),
  useDeleteTransaction: () => ({ mutate: vi.fn() }),
  useBankTransactions: () => ({ data: bankTxns, isLoading: false }),
  useBankTransactionRange: () => ({ data: range }),
  useCategories: () => ({ data: categories }),
}));
vi.mock("./AddPositionForm", () => ({ AddPositionForm: () => null }));
vi.mock("./TransactionForm", () => ({ TransactionForm: () => null }));
vi.mock("./CsvImportForm", () => ({ CsvImport: () => null }));

const { Activity } = await import("./Activity");
const show = () => render(<MemoryRouter><Activity /></MemoryRouter>);

describe("Activity — synced accounts show their bank transactions", () => {
  beforeEach(() => {
    txns = [];
    range = ["2026-06-01", "2026-09-08"];
  });

  it("lists the card's transactions instead of claiming there are none", () => {
    accounts = [account(1, "Chase Card", "simplefin")];
    bankTxns = [bankTxn(1, 1, "WHOLE FOODS", -82.14)];
    show();
    expect(screen.getByText("WHOLE FOODS")).toBeInTheDocument();
    expect(screen.queryByText("No transactions in this account yet")).not.toBeInTheDocument();
  });

  it("shows the amount and the category it was sorted into", () => {
    accounts = [account(1, "Chase Card", "simplefin")];
    bankTxns = [bankTxn(1, 1, "WHOLE FOODS", -82.14)];
    show();
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText(/82\.14/)).toBeInTheDocument();
  });

  it("does not leak another account's transactions in", () => {
    accounts = [account(1, "Chase Card", "simplefin")];
    bankTxns = [bankTxn(1, 1, "WHOLE FOODS", -82.14), bankTxn(2, 99, "SOMEONE ELSE", -10)];
    show();
    expect(screen.queryByText("SOMEONE ELSE")).not.toBeInTheDocument();
  });

  it("says so plainly when a synced account really has none", () => {
    accounts = [account(1, "Chase Card", "simplefin")];
    bankTxns = [];
    show();
    expect(screen.getByText(/no transactions have synced/i)).toBeInTheDocument();
  });

  it("still shows investment transactions for a manual account", () => {
    accounts = [account(1, "Brokerage", "manual")];
    bankTxns = [];
    txns = [{ id: 1, account_id: 1, security_id: 10, type: "buy", date: "2026-01-02",
              quantity: 2, price: 200, amount: 400, fees: 0, note: null }];
    show();
    expect(screen.getByText("VTI")).toBeInTheDocument();
    expect(screen.getByText("buy")).toBeInTheDocument();
  });
});

describe("Activity — hidden accounts", () => {
  it("leaves a hidden account out of the account picker", () => {
    accounts = [account(1, "Everyday", "manual"), account(2, "Old Savings", "manual", true)];
    bankTxns = []; txns = [];
    show();
    expect(screen.getByRole("option", { name: /Everyday/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Old Savings/ })).not.toBeInTheDocument();
  });

  it("never selects a hidden account by default, even when it sorts first", () => {
    accounts = [account(1, "AAA Hidden", "manual", true), account(2, "Everyday", "manual")];
    bankTxns = []; txns = [];
    show();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("2");
  });

  it("treats an all-hidden set as having no accounts to work with", () => {
    accounts = [account(1, "Only", "manual", true)];
    bankTxns = []; txns = [];
    show();
    expect(screen.getByText(/You need an account first/i)).toBeInTheDocument();
  });
});
