import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { TransactionList } from "./TransactionList";
import { ToastProvider } from "../../ui/toast";
import type { Account, BankTransaction, Category } from "../../domain/types";

const category: Category = { id: 1, name: "Shopping", kind: "spending", colour: "chart-2", sort: 70, is_builtin: true };
const split = (over: Partial<BankTransaction> = {}): BankTransaction => txn({
  amount: -85.5, category_id: null, category_source: "manual", reviewed: true,
  splits: [{ id: 1, category_id: 1, amount: -60, note: null }, { id: 2, category_id: null, amount: -25.5, note: null }],
  ...over,
});
const account = { id: 1, name: "Card", hidden: false, type: "credit" } as Account;
const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 7, account_id: 1, external_id: "t", posted: "2026-10-01", amount: -9, description: "TARGET",
  payee: "Target", memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: false, note: null, removed: false, splits: [], ...over,
});

function renderList(props: Partial<Parameters<typeof TransactionList>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}><ToastProvider>
      <TransactionList transactions={[txn()]} categories={[category]} accounts={[account]}
        colourOf={() => "#000"} {...props} />
    </ToastProvider></QueryClientProvider>,
  );
}

describe("TransactionList review", () => {
  it("marks a row that has not been reviewed", () => {
    renderList();
    expect(screen.getByTitle("To review")).toBeInTheDocument();
  });

  it("shows no mark once reviewed", () => {
    renderList({ transactions: [txn({ reviewed: true })] });
    expect(screen.queryByTitle("To review")).toBeNull();
  });

  it("approves a row from its tick button", () => {
    const onApprove = vi.fn();
    renderList({ onApprove });
    fireEvent.click(screen.getByRole("button", { name: "Approve Target" }));
    expect(onApprove).toHaveBeenCalledWith(7);
  });

  it("removes a row from its remove button", () => {
    const onRemove = vi.fn();
    renderList({ onRemove });
    fireEvent.click(screen.getByRole("button", { name: "Remove Target" }));
    expect(onRemove).toHaveBeenCalledWith(7);
  });

  it("restores a removed row", () => {
    const onRestore = vi.fn();
    renderList({ transactions: [txn({ removed: true })], onRestore });
    fireEvent.click(screen.getByRole("button", { name: "Restore Target" }));
    expect(onRestore).toHaveBeenCalledWith(7);
  });

  it("has no tick buttons when approving is not offered", () => {
    renderList();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});

describe("TransactionList splits", () => {
  it("opens the split editor from a row's Split button", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Split Target" }));
    expect(screen.getByLabelText("Amount for piece 1")).toHaveValue("9.00");
  });

  it("shows a split row's pieces instead of the category picker", () => {
    renderList({ transactions: [split()] });
    expect(screen.queryByLabelText("Category for Target")).toBeNull();
    expect(screen.queryByRole("button", { name: "Split Target" })).toBeNull();
    expect(screen.getByText("Shopping")).toBeInTheDocument();
    expect(screen.getByText("$60.00")).toBeInTheDocument();
    expect(screen.getByText("Uncategorised")).toBeInTheDocument();
    expect(screen.getByText("$25.50")).toBeInTheDocument();
  });

  it("edits a split from its Edit split button", () => {
    renderList({ transactions: [split()] });
    fireEvent.click(screen.getByRole("button", { name: "Edit split for Target" }));
    expect(screen.getByLabelText("Amount for piece 2")).toHaveValue("25.50");
  });

  it("says when the bank's amount no longer matches the pieces", () => {
    renderList({ transactions: [split({ amount: -90 })] });
    expect(screen.getByText(/\$4\.50 not assigned/)).toBeInTheDocument();
  });

  it("offers no Split on a removed row", () => {
    renderList({ transactions: [txn({ removed: true })], onRestore: vi.fn() });
    expect(screen.queryByRole("button", { name: "Split Target" })).toBeNull();
  });
});
