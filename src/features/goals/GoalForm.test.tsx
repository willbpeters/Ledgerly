import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account, Goal } from "../../domain/types";

const create = vi.fn();
const update = vi.fn();

// Only the data layer is mocked; the form and the shared UI kit are real.
vi.mock("../../data/queries", () => ({
  useCreateGoal: () => ({ mutate: create, isPending: false }),
  useUpdateGoal: () => ({ mutate: update, isPending: false }),
}));

const { GoalForm, readGoal } = await import("./GoalForm");

const savings = {
  id: 1, name: "Savings", type: "cash", institution: null, currency: "USD", created_at: "",
  source: "manual", external_id: null, synced_balance: null, last_synced_at: null, hidden: false,
} as Account;

const blank = { name: "", target: "", date: "", track: "", saved: "" };

describe("readGoal", () => {
  it("reads amounts the way people type them", () => {
    expect(readGoal({ ...blank, name: " Trip ", target: "$2,000", saved: "250.50" })).toEqual({
      name: "Trip", target_amount: 2000, target_date: null, account_id: null, saved_amount: 250.5,
    });
  });

  it("treats a blank amount saved as nothing yet", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10" })).toMatchObject({ saved_amount: 0 });
  });

  it("refuses a day that does not exist", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", date: "2027-02-30" })).toBe("That date isn't a real day.");
  });

  it("refuses a negative amount saved", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", saved: "-5" })).toBe("The amount saved can't be below $0.");
  });

  it("refuses an amount saved that is not a number", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", saved: "lots" }))
      .toBe("Enter how much is saved so far, or leave it blank.");
  });

  it("keeps the amount kept by hand while an account is followed", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", track: "1", saved: "300" }))
      .toMatchObject({ account_id: 1, saved_amount: 300 });
  });

  it("ignores a stray amount saved while an account is followed", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", track: "1", saved: "lots" }))
      .toMatchObject({ account_id: 1, saved_amount: 0 });
  });
});

describe("GoalForm", () => {
  const onDone = vi.fn();
  beforeEach(() => { create.mockClear(); update.mockClear(); onDone.mockClear(); });

  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("explains a missing name beside the form and sends nothing", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Target", "2000");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the goal a name.");
    expect(create).not.toHaveBeenCalled();
  });

  it("explains a target of zero", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target", "0");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Set a target above $0.");
  });

  it("adds a goal updated by hand", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target", "2000");
    type("By (optional)", "2027-03-01");
    type("Saved so far", "250");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(create.mock.calls[0][0]).toEqual({
      name: "Trip", target_amount: 2000, target_date: "2027-03-01", account_id: null, saved_amount: 250,
    });
  });

  it("follows an account instead, and then asks for no amount", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Emergency fund");
    type("Target", "10000");
    type("Track it with", "1");
    expect(screen.queryByLabelText("Saved so far")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(create.mock.calls[0][0]).toMatchObject({ account_id: 1, saved_amount: 0 });
  });

  it("edits a goal in place, starting from what it holds", () => {
    const goal: Goal = {
      id: 5, name: "Trip", target_amount: 2000, target_date: "2027-03-01",
      account_id: null, saved_amount: 300, created_at: "",
    };
    render(<GoalForm goal={goal} accounts={[savings]} onDone={onDone} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Trip");
    type("Target", "2500");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(update.mock.calls[0][0]).toEqual({
      id: 5,
      goal: { name: "Trip", target_amount: 2500, target_date: "2027-03-01", account_id: null, saved_amount: 300 },
    });
  });

  it("cancels without sending anything", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
