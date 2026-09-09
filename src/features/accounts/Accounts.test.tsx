import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account } from "../../domain/types";

const setHidden = vi.fn();

function account(id: number, name: string, hidden: boolean): Account {
  return {
    id, name, type: "cash", institution: null, currency: "USD", created_at: "",
    source: "manual", external_id: null, synced_balance: null, last_synced_at: null, hidden,
  };
}
let rows: Account[] = [];

// Only the data layer is mocked; the screen and the shared UI kit are real.
vi.mock("../../data/queries", () => ({
  useAccounts: () => ({ data: rows, isLoading: false }),
  useDeleteAccount: () => ({ mutate: vi.fn() }),
  useSetAccountType: () => ({ mutate: vi.fn() }),
  useSetAccountHidden: () => ({ mutate: setHidden }),
}));
vi.mock("../../data/usePortfolio", () => ({
  usePortfolio: () => ({ accountValues: new Map<number, number>() }),
}));
vi.mock("./AccountForm", () => ({ AccountForm: () => null }));

const { Accounts } = await import("./Accounts");

describe("Accounts screen — hiding", () => {
  beforeEach(() => {
    setHidden.mockClear();
    rows = [account(1, "Everyday", false), account(2, "Old Savings", true)];
  });

  it("leaves hidden accounts out of the list by default", () => {
    render(<Accounts />);
    expect(screen.getByText("Everyday")).toBeInTheDocument();
    expect(screen.queryByText("Old Savings")).not.toBeInTheDocument();
  });

  it("offers to show them, counting how many there are", () => {
    render(<Accounts />);
    expect(screen.getByRole("button", { name: /show hidden \(1\)/i })).toBeInTheDocument();
  });

  it("reveals hidden accounts when asked", () => {
    render(<Accounts />);
    fireEvent.click(screen.getByRole("button", { name: /show hidden \(1\)/i }));
    expect(screen.getByText("Old Savings")).toBeInTheDocument();
  });

  it("offers no toggle when nothing is hidden", () => {
    rows = [account(1, "Everyday", false)];
    render(<Accounts />);
    expect(screen.queryByRole("button", { name: /show hidden/i })).not.toBeInTheDocument();
  });

  it("hides a visible account when Hide is clicked", () => {
    render(<Accounts />);
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(setHidden).toHaveBeenCalledWith({ id: 1, hidden: true });
  });

  it("shows a hidden account again when Unhide is clicked", () => {
    render(<Accounts />);
    fireEvent.click(screen.getByRole("button", { name: /show hidden \(1\)/i }));
    fireEvent.click(screen.getByRole("button", { name: "Unhide" }));
    expect(setHidden).toHaveBeenCalledWith({ id: 2, hidden: false });
  });
});
