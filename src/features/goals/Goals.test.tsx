import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account, Goal } from "../../domain/types";

const remove = vi.fn();
const ask = vi.fn();
let goals: Goal[] = [];

function account(id: number, name: string, type: Account["type"]): Account {
  return {
    id, name, type, institution: null, currency: "USD", created_at: "",
    source: "manual", external_id: null, synced_balance: null, last_synced_at: null, hidden: false,
  };
}

// Only the data layer, the clock and the confirm box are mocked; the screen,
// the form and the shared UI kit are real.
vi.mock("../../data/queries", () => ({
  useGoals: () => ({ data: goals, isLoading: false }),
  useCreateGoal: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateGoal: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteGoal: () => ({ mutate: remove }),
}));
vi.mock("../../data/usePortfolio", () => ({
  usePortfolio: () => ({
    accountValues: new Map<number, number>([[1, 1250]]),
    accounts: [account(1, "Savings", "cash"), account(2, "Card", "credit"), account(3, "Brokerage", "brokerage")],
    isLoading: false,
  }),
}));
vi.mock("../../ui/confirm", () => ({ askToConfirm: (...args: unknown[]) => ask(...args) }));
// Pin only today's date; the calendar maths in goals.ts stays real.
vi.mock("../../domain/dates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/dates")>()),
  localIsoDate: () => "2026-10-25",
}));

const { Goals, goalLine } = await import("./Goals");

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 5, name: "Trip", target_amount: 2000, target_date: null,
  account_id: null, saved_amount: 0, created_at: "", ...over,
});

describe("Goals screen", () => {
  beforeEach(() => { remove.mockClear(); ask.mockReset(); goals = []; });

  it("invites the first goal when there are none", () => {
    render(<Goals />);
    expect(screen.getByText("No goals yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a goal" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("shows a goal following an account at that account's value", () => {
    goals = [goal({ account_id: 1, target_date: "2027-03-25" })];
    render(<Goals />);
    expect(screen.getByText("$1,250.00")).toBeInTheDocument();
    expect(screen.getByText("of $2,000.00")).toBeInTheDocument();
    // $750 left over the 5 months to 25 March 2027.
    expect(screen.getByText("$150.00 a month to reach it by March 2027")).toBeInTheDocument();
    expect(screen.getByText("Following Savings")).toBeInTheDocument();
  });

  it("shows a goal kept by hand at the amount entered", () => {
    goals = [goal({ saved_amount: 300 })];
    render(<Goals />);
    expect(screen.getByText("$300.00")).toBeInTheDocument();
    expect(screen.getByText("$1,700.00 to go")).toBeInTheDocument();
    expect(screen.getByText("Updated by hand")).toBeInTheDocument();
  });

  it("explains a goal whose account is hidden", () => {
    goals = [goal({ account_id: 9, saved_amount: 300 })];
    render(<Goals />);
    expect(screen.getByText("Its account is hidden, so this shows the amount you last entered")).toBeInTheDocument();
  });

  it("treats a followed account with no value yet as nothing saved, not hidden", () => {
    goals = [goal({ account_id: 3, saved_amount: 300 })];
    render(<Goals />);
    expect(screen.getByText("Following Brokerage")).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.queryByText(/is hidden/)).toBeNull();
  });

  it("offers only cash and investment accounts to follow", () => {
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Add a goal" }));
    expect(screen.getByRole("option", { name: "Savings" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Brokerage" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Card" })).toBeNull();
  });

  it("opens the form with the goal's details to edit it", () => {
    goals = [goal({ saved_amount: 300 })];
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Trip" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Trip");
  });

  it("deletes a goal only once the owner agrees", async () => {
    goals = [goal()];
    ask.mockResolvedValue(true);
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Trip" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(5));
    expect(ask.mock.calls[0][0]).toContain("Trip");
  });

  it("keeps the goal when the owner says no", async () => {
    goals = [goal()];
    ask.mockResolvedValue(false);
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Trip" }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("goalLine", () => {
  const p = { saved: 500, target: 2000, remaining: 1500, fraction: 0.25, done: false, monthsLeft: null, perMonth: null, overdue: false };

  it("says when a goal is reached", () => {
    expect(goalLine({ ...p, done: true, remaining: 0 }, null)).toBe("Reached");
  });

  it("says when the date has passed", () => {
    expect(goalLine({ ...p, overdue: true, monthsLeft: 0, perMonth: null }, "2026-09-01"))
      .toBe("The date has passed — $1,500.00 to go");
  });
});
