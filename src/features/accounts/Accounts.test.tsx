import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account, Goal } from "../../domain/types";

const setHidden = vi.fn();
const deleteAccount = vi.fn();
const updateGoal = vi.fn();
const ask = vi.fn();
const push = vi.fn();
let goals: Goal[] = [];
let values = new Map<number, number>();

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
  useDeleteAccount: () => ({ mutate: deleteAccount }),
  useGoals: () => ({ data: goals }),
  useUpdateGoal: () => ({ mutateAsync: updateGoal }),
  useSetAccountType: () => ({ mutate: vi.fn() }),
  useSetAccountHidden: () => ({ mutate: setHidden }),
}));
vi.mock("../../data/usePortfolio", () => ({
  usePortfolio: () => ({ get accountValues() { return values; } }),
}));
vi.mock("../../ui/confirm", () => ({ askToConfirm: (...args: unknown[]) => ask(...args) }));
vi.mock("../../ui/toast", () => ({ useToast: () => ({ push }) }));
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

describe("Accounts screen — deleting an account a goal follows", () => {
  const goal = (over: Partial<Goal> = {}): Goal => ({
    id: 7, name: "Trip", target_amount: 2000, target_date: "2027-03-01",
    account_id: 1, saved_amount: 40, created_at: "", ...over,
  });

  beforeEach(() => {
    deleteAccount.mockClear(); updateGoal.mockReset(); ask.mockReset(); push.mockClear();
    updateGoal.mockResolvedValue(undefined);
    ask.mockResolvedValue(true);
    rows = [account(1, "Everyday", false)];
    values = new Map([[1, 1250.5]]);
    goals = [goal()];
  });

  const clickDelete = () => fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  it("names the goal and the amount it will keep", async () => {
    render(<Accounts />);
    clickDelete();
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(ask.mock.calls[0][0]).toContain(
      "Your goal “Trip” follows this account. Tally will keep its current amount, $1,250.50, as an amount kept by hand.");
  });

  it("keeps the goal's progress as its hand-kept amount, then deletes the account", async () => {
    render(<Accounts />);
    clickDelete();
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(1));
    expect(updateGoal).toHaveBeenCalledWith({
      id: 7,
      goal: { name: "Trip", target_amount: 2000, target_date: "2027-03-01", account_id: 1, saved_amount: 1250.5 },
    });
    expect(updateGoal.mock.invocationCallOrder[0]).toBeLessThan(deleteAccount.mock.invocationCallOrder[0]);
  });

  it("keeps an overdrawn account as nothing, not as a negative amount", async () => {
    values = new Map([[1, -80]]);
    render(<Accounts />);
    clickDelete();
    await waitFor(() => expect(deleteAccount).toHaveBeenCalled());
    expect(updateGoal.mock.calls[0][0].goal.saved_amount).toBe(0);
  });

  it("keeps the hand-kept amount for a hidden account, which the goal was already showing", async () => {
    rows = [account(1, "Everyday", true)];
    values = new Map();
    render(<Accounts />);
    fireEvent.click(screen.getByRole("button", { name: /show hidden/i }));
    clickDelete();
    await waitFor(() => expect(deleteAccount).toHaveBeenCalled());
    expect(updateGoal.mock.calls[0][0].goal.saved_amount).toBe(40);
  });

  it("leaves goals that follow other accounts alone", async () => {
    goals = [goal({ account_id: 2 }), goal({ id: 8, account_id: null })];
    render(<Accounts />);
    clickDelete();
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith(1));
    expect(updateGoal).not.toHaveBeenCalled();
    expect(ask.mock.calls[0][0]).not.toContain("follows this account");
  });

  it("changes nothing when the owner says no", async () => {
    ask.mockResolvedValue(false);
    render(<Accounts />);
    clickDelete();
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(updateGoal).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("does not delete the account, and says why, when the goal could not be updated", async () => {
    updateGoal.mockRejectedValue("disk full");
    render(<Accounts />);
    clickDelete();
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(push.mock.calls[0][0]).toMatchObject({ tone: "neg", body: "disk full" });
    expect(deleteAccount).not.toHaveBeenCalled();
  });
});
