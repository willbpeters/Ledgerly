import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToastProvider } from "../../ui/toast";
import { SplitEditor } from "./SplitEditor";
import type { BankTransaction, Category } from "../../domain/types";

// The editor saves through the Tauri bridge; stand it in with spies.
const { setSplits, restore } = vi.hoisted(() => ({
  setSplits: vi.fn((..._args: unknown[]) => Promise.resolve()),
  restore: vi.fn((..._args: unknown[]) => Promise.resolve(1)),
}));
vi.mock("../../data/api", () => ({ api: { bankTransactions: { setSplits, restore } } }));

const groceries: Category = { id: 1, name: "Groceries", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true };
const household: Category = { id: 2, name: "Household", kind: "spending", colour: "chart-2", sort: 20, is_builtin: false };
const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 7, account_id: 1, external_id: "t", posted: "2026-10-03", amount: -85.5, description: "COSTCO",
  payee: "Costco", memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: false, note: null, removed: false, splits: [], ...over,
});
const alreadySplit = txn({
  category_id: null, category_source: "manual", reviewed: true,
  splits: [{ id: 1, category_id: 1, amount: -60, note: null }, { id: 2, category_id: 2, amount: -25.5, note: null }],
});

function renderEditor(t: BankTransaction = txn()) {
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}><ToastProvider>
      <SplitEditor txn={t} categories={[groceries, household]} onDone={onDone} />
    </ToastProvider></QueryClientProvider>,
  );
  return onDone;
}
const amount = (n: number) => screen.getByLabelText(`Amount for piece ${n}`) as HTMLInputElement;
const category = (n: number) => screen.getByLabelText(`Category for piece ${n}`) as HTMLSelectElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

const lastSetSplitsOrder = () => { const o = setSplits.mock.invocationCallOrder; return o[o.length - 1]; };

beforeEach(() => { setSplits.mockClear(); restore.mockClear(); });

describe("SplitEditor", () => {
  it("starts with the whole amount in the current category and an empty second piece", () => {
    renderEditor();
    expect(category(1).value).toBe("1");
    expect(amount(1).value).toBe("85.50");
    expect(amount(2).value).toBe("");
    expect(screen.getByText("Every piece needs an amount.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save split" })).toBeDisabled();
  });

  it("says what is left to assign, or how much too much", () => {
    renderEditor();
    type(amount(1), "60");
    type(amount(2), "20");
    expect(screen.getByText("$5.50 left to assign.")).toBeInTheDocument();
    type(amount(2), "30");
    expect(screen.getByText("$4.50 more than the transaction.")).toBeInTheDocument();
  });

  it("saves pieces with the transaction's sign, then Undo puts the row back", async () => {
    const onDone = renderEditor();
    type(amount(1), "60");
    type(category(2), "2");
    type(amount(2), "25.50");
    expect(screen.getByText("Adds up to $85.50.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save split" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setSplits).toHaveBeenCalledWith(7, [
      { category_id: 1, amount: -60, note: null },
      { category_id: 2, amount: -25.5, note: null },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith([
      { id: 7, category_id: 1, category_source: "auto", reviewed: false, removed: false },
    ]));
    expect(setSplits).toHaveBeenLastCalledWith(7, []);
    // The pieces are cleared before the row's own state goes back.
    expect(lastSetSplitsOrder()).toBeLessThan(restore.mock.invocationCallOrder[0]);
  });

  it("saves a refund's pieces as positive amounts", async () => {
    const onDone = renderEditor(txn({ amount: 30, category_id: null }));
    type(amount(1), "20");
    type(amount(2), "10");
    fireEvent.click(screen.getByRole("button", { name: "Save split" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setSplits).toHaveBeenCalledWith(7, [
      { category_id: null, amount: 20, note: null },
      { category_id: null, amount: 10, note: null },
    ]);
  });

  it("adds a piece, and removes one once there are more than two", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: "Remove piece 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add piece" }));
    expect(amount(3)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove piece 3" }));
    expect(screen.queryByLabelText("Amount for piece 3")).toBeNull();
  });

  it("offers Unsplit only for a transaction that is already split", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: "Unsplit" })).toBeNull();
  });

  it("opens a split transaction on its pieces, and Unsplit sends none — undoable", async () => {
    const onDone = renderEditor(alreadySplit);
    expect(amount(1).value).toBe("60.00");
    expect(amount(2).value).toBe("25.50");

    fireEvent.click(screen.getByRole("button", { name: "Unsplit" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setSplits).toHaveBeenCalledWith(7, []);
    expect(await screen.findByText("Split removed")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(setSplits).toHaveBeenLastCalledWith(7, [
      { category_id: 1, amount: -60, note: null },
      { category_id: 2, amount: -25.5, note: null },
    ]));
    await waitFor(() => expect(restore).toHaveBeenCalled());
    expect(lastSetSplitsOrder()).toBeLessThan(restore.mock.invocationCallOrder[0]);
  });

  it("undoing an unsplit puts back what the pieces no longer covered", async () => {
    const onDone = renderEditor({ ...alreadySplit, amount: -90 });
    fireEvent.click(screen.getByRole("button", { name: "Unsplit" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(setSplits).toHaveBeenLastCalledWith(7, [
      { category_id: 1, amount: -60, note: null },
      { category_id: 2, amount: -25.5, note: null },
      { category_id: null, amount: -4.5, note: null },
    ]));
  });

  it("shows a failed save as plain text, and clears it once a piece is edited", async () => {
    setSplits.mockImplementationOnce(() => Promise.reject(new Error("That category no longer exists.")));
    renderEditor();
    type(amount(1), "60");
    type(amount(2), "25.50");
    fireEvent.click(screen.getByRole("button", { name: "Save split" }));
    expect(await screen.findByText("That category no longer exists.")).toBeInTheDocument();
    type(amount(2), "25");
    await waitFor(() => expect(screen.queryByText("That category no longer exists.")).toBeNull());
  });

  it("cannot be cancelled while a save is in flight", async () => {
    setSplits.mockImplementationOnce(() => new Promise<void>(() => {}));
    renderEditor();
    type(amount(1), "60");
    type(amount(2), "25.50");
    fireEvent.click(screen.getByRole("button", { name: "Save split" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled());
  });

  it("still finishes a save when a piece is edited while it is in flight", async () => {
    let finish: () => void = () => {};
    setSplits.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onDone = renderEditor();
    type(amount(1), "60");
    type(amount(2), "25.50");
    fireEvent.click(screen.getByRole("button", { name: "Save split" }));
    await waitFor(() => expect(setSplits).toHaveBeenCalled());
    type(amount(2), "25.5");
    finish();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("cancels without saving", () => {
    const onDone = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
    expect(setSplits).not.toHaveBeenCalled();
  });
});
