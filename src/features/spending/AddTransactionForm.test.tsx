import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { Account, Category } from "../../domain/types";

const add = vi.hoisted(() => vi.fn());
vi.mock("../../data/queries", () => ({
  useAddTransaction: () => ({ mutate: add, isPending: false }),
}));
const { AddTransactionForm } = await import("./AddTransactionForm");

const acct = (id: number, name: string, type: Account["type"], source: Account["source"] = "simplefin") =>
  ({ id, name, type, source, hidden: false }) as Account;
const accounts = [acct(1, "Card (9849)", "credit"), acct(2, "Brokerage", "brokerage"), acct(3, "Cash", "cash", "manual")];
const categories: Category[] = [{ id: 5, name: "Eating Out", kind: "spending", colour: "cat-1", sort: 10, is_builtin: false }];

function fill(payee: string, amount: string) {
  fireEvent.change(screen.getByLabelText("Paid to or from"), { target: { value: payee } });
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: amount } });
}

describe("AddTransactionForm", () => {
  it("offers every spending account, starting on a cash account you made", () => {
    render(<AddTransactionForm accounts={accounts} categories={categories} today="2026-10-29" onClose={vi.fn()} />);
    const picker = screen.getByLabelText("Account");
    expect(picker).toHaveValue("3");
    expect([...picker.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Card (9849)", "Cash"]);
    expect(screen.getByLabelText("Date")).toHaveValue("2026-10-29");
  });

  it("adds money out as a negative amount, in the account and category chosen", () => {
    add.mockClear();
    render(<AddTransactionForm accounts={accounts} categories={categories} today="2026-10-29" onClose={vi.fn()} />);
    fill("Taco truck", "12.50");
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "lunch" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(add).toHaveBeenCalledWith(
      { account_id: 1, posted: "2026-10-29", amount: -12.5, payee: "Taco truck", category_id: 5, note: "lunch" },
      expect.anything(),
    );
  });

  it("adds money in as a positive amount", () => {
    add.mockClear();
    render(<AddTransactionForm accounts={accounts} categories={categories} today="2026-10-29" onClose={vi.fn()} />);
    fill("Sold old bike", "80");
    fireEvent.click(screen.getByRole("button", { name: "Money in" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(add.mock.calls[0][0]).toMatchObject({ amount: 80, account_id: 3, category_id: null, note: null });
  });

  it("waits for a payee and an amount", () => {
    render(<AddTransactionForm accounts={accounts} categories={categories} today="2026-10-29" onClose={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Add" });
    expect(button).toBeDisabled();
    fill("Taco truck", "0");
    expect(button).toBeDisabled();
    fill("Taco truck", "3");
    expect(button).toBeEnabled();
  });

  it("says where to make a cash account when there is no account to add to", () => {
    render(<AddTransactionForm accounts={[accounts[1]]} categories={categories} today="2026-10-29" onClose={vi.fn()} />);
    expect(screen.getByText(/Add a Cash account in Accounts/)).toBeInTheDocument();
  });
});
