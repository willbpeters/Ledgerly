import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { TransactionList } from "./TransactionList";
import type { Account, BankTransaction, Category } from "../../domain/types";

const category: Category = { id: 1, name: "Shopping", kind: "spending", colour: "chart-2", sort: 70, is_builtin: true };
const account = { id: 1, name: "Card", hidden: false, type: "credit" } as Account;
const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 7, account_id: 1, external_id: "t", posted: "2026-10-01", amount: -9, description: "TARGET",
  payee: "Target", memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: false, note: null, removed: false, ...over,
});

function renderList(props: Partial<Parameters<typeof TransactionList>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TransactionList transactions={[txn()]} categories={[category]} accounts={[account]}
        colourOf={() => "#000"} {...props} />
    </QueryClientProvider>,
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
