import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { ToastProvider } from "../../ui/toast";
import type { Account, BankTransaction, Category } from "../../domain/types";

// Category changes are saved through Tauri; record them instead.
const setCategory = vi.hoisted(() => vi.fn());
vi.mock("../../data/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../data/queries")>()),
  useSetTransactionCategory: () => ({ mutate: setCategory }),
}));
const { TransactionList } = await import("./TransactionList");

const category: Category = { id: 1, name: "Shopping", kind: "spending", colour: "chart-2", sort: 70, is_builtin: true };
const dining: Category = { id: 2, name: "Dining", kind: "spending", colour: "cat-11", sort: 80, is_builtin: false };
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
      <TransactionList transactions={[txn()]} categories={[category]} accounts={[account]} {...props} />
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

describe("TransactionList categories", () => {
  const pillOf = (el: HTMLElement) => el.closest(".cat-pill") as HTMLElement;

  it("shows the category picker as a pill in the category's colour", () => {
    renderList();
    const select = screen.getByRole("combobox", { name: "Category for Target" });
    expect(select).toHaveValue("1");
    expect(pillOf(select).style.getPropertyValue("--pill")).toBe("var(--cat-2)");
  });

  it("shows an uncategorised row as the muted Uncategorised pill", () => {
    renderList({ transactions: [txn({ category_id: null })] });
    const select = screen.getByRole("combobox", { name: "Category for Target" });
    expect(select).toHaveValue("");
    expect(pillOf(select)).toHaveClass("none");
  });

  it("saves a new category and offers to apply it to the payee", () => {
    setCategory.mockClear();
    renderList({ categories: [category, dining] });
    fireEvent.change(screen.getByLabelText("Category for Target"), { target: { value: "2" } });
    expect(setCategory).toHaveBeenCalledWith(
      { id: 7, categoryId: 2, applyToPayee: false }, expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByRole("button", { name: "Apply to all “Target”" })).toBeInTheDocument();
  });

  it("marks a category chosen by hand", () => {
    renderList({ transactions: [txn({ category_source: "manual" })] });
    expect(screen.getByTitle("You chose this category")).toBeInTheDocument();
  });

  it("shows a split row's pieces as pills", () => {
    renderList({ transactions: [split()] });
    expect(pillOf(screen.getByText("Shopping")).style.getPropertyValue("--pill")).toBe("var(--cat-2)");
    expect(pillOf(screen.getByText("Uncategorised"))).toHaveClass("none");
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

  it("puts a plus before a piece that is money back", () => {
    renderList({ transactions: [split({
      amount: -85.5,
      splits: [{ id: 1, category_id: 1, amount: -100, note: null }, { id: 2, category_id: null, amount: 14.5, note: null }],
    })] });
    expect(screen.getByText("+$14.50")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
  });

  it("marks a split row that has not been reviewed, and not one that has", () => {
    const { unmount } = renderList({ transactions: [split({ reviewed: false })] });
    expect(screen.getByTitle("To review")).toHaveAttribute("aria-label", "To review");
    unmount();
    renderList({ transactions: [split({ reviewed: true })] });
    expect(screen.queryByTitle("To review")).toBeNull();
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

  it("says the pieces are too much when the bank's amount went down", () => {
    renderList({ transactions: [split({ amount: -80 })] });
    expect(screen.queryByText(/not assigned/)).toBeNull();
    expect(screen.getByText(/The pieces are \$5\.50 more than the bank's amount — edit the split/)).toBeInTheDocument();
  });

  it("still offers Approve on a split row", () => {
    const onApprove = vi.fn();
    renderList({ transactions: [split({ reviewed: false })], onApprove });
    fireEvent.click(screen.getByRole("button", { name: "Approve Target" }));
    expect(onApprove).toHaveBeenCalledWith(7);
  });

  it("closes the editor on Cancel", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Split Target" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Amount for piece 1")).toBeNull();
  });

  it("marks the Split button expanded while its editor is open", () => {
    renderList();
    const button = screen.getByRole("button", { name: "Split Target" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("stays closed when its row leaves the list and comes back", () => {
    const ui = (transactions: BankTransaction[]) => (
      <QueryClientProvider client={client}><ToastProvider>
        <TransactionList transactions={transactions} categories={[category]} accounts={[account]} />
      </ToastProvider></QueryClientProvider>
    );
    const client = new QueryClient();
    const { rerender } = render(ui([txn()]));
    fireEvent.click(screen.getByRole("button", { name: "Split Target" }));
    expect(screen.getByLabelText("Amount for piece 1")).toBeInTheDocument();
    rerender(ui([]));
    rerender(ui([txn()]));
    expect(screen.queryByLabelText("Amount for piece 1")).toBeNull();
  });

  it("offers no Split on a removed row", () => {
    renderList({ transactions: [txn({ removed: true })], onRestore: vi.fn() });
    expect(screen.queryByRole("button", { name: "Split Target" })).toBeNull();
  });
});
