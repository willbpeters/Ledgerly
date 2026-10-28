import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect } from "vitest";
import { SearchPanel } from "./SearchPanel";
import { ToastProvider } from "../../ui/toast";
import type { Account, BankTransaction, Category } from "../../domain/types";

const category: Category = { id: 1, name: "Groceries", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true };
const account = { id: 1, name: "Card", hidden: false, type: "credit" } as Account;
const txn = (id: number, payee: string, amount: number, posted: string): BankTransaction => ({
  id, account_id: 1, external_id: `t${id}`, posted, amount, description: payee.toUpperCase(),
  payee, memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: true, note: null, removed: false, splits: [],
});

function renderPanel(transactions: BankTransaction[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}><ToastProvider>
      <SearchPanel transactions={transactions} loading={false} categories={[category]} accounts={[account]}
        colourOf={() => "#000"} onRemove={() => {}} />
    </ToastProvider></QueryClientProvider>,
  );
}

describe("SearchPanel", () => {
  it("shows nothing until there is something to search for", () => {
    renderPanel([txn(1, "Whole Foods", -40, "2026-01-05")]);
    expect(screen.queryByText("Whole Foods")).toBeNull();
  });

  it("finds matches across months and totals them", () => {
    renderPanel([
      txn(1, "Whole Foods", -40, "2026-01-05"),
      txn(2, "Whole Foods", -60, "2026-09-12"),
      txn(3, "Shell", -30, "2026-09-13"),
    ]);
    fireEvent.change(screen.getByLabelText("Search transactions"), { target: { value: "whole" } });
    expect(screen.getAllByText("Whole Foods")).toHaveLength(2);
    expect(screen.queryByText("Shell")).toBeNull();
    expect(screen.getByText(/2 transactions/)).toHaveTextContent("$100.00 out");
  });

  it("totals only the pieces in the filtered category for a split", () => {
    const household: Category = { id: 2, name: "Household", kind: "spending", colour: "chart-2", sort: 20, is_builtin: true };
    const costco: BankTransaction = {
      ...txn(1, "Costco", -85.5, "2026-10-03"), category_id: null, category_source: "manual",
      splits: [
        { id: 1, category_id: 1, amount: -60, note: null },
        { id: 2, category_id: 2, amount: -25.5, note: null },
      ],
    };
    render(
      <QueryClientProvider client={new QueryClient()}><ToastProvider>
        <SearchPanel transactions={[costco]} loading={false} categories={[category, household]} accounts={[account]}
          colourOf={() => "#000"} onRemove={() => {}} />
      </ToastProvider></QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("Filter by category"), { target: { value: "1" } });
    expect(screen.getByText(/1 transaction/)).toHaveTextContent("$60.00 out");
  });

  it("says so when nothing matches", () => {
    renderPanel([txn(1, "Whole Foods", -40, "2026-01-05")]);
    fireEvent.change(screen.getByLabelText("Search transactions"), { target: { value: "costco" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});
