import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account, Goal } from "../../domain/types";

const create = vi.fn();
const update = vi.fn();
let pending = false;

// Only the data layer is mocked; the form and the shared UI kit are real.
vi.mock("../../data/queries", () => ({
  useCreateGoal: () => ({ mutate: create, isPending: pending }),
  useUpdateGoal: () => ({ mutate: update, isPending: pending }),
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

  it("refuses a target below one cent", () => {
    for (const target of ["0", "-5", "0.001", "0.004", "lots", ""]) {
      expect(readGoal({ ...blank, name: "Trip", target }), target).toBe("Set a target of at least $0.01.");
    }
    expect(readGoal({ ...blank, name: "Trip", target: "0.01" })).toMatchObject({ target_amount: 0.01 });
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
  beforeEach(() => {
    create.mockReset(); update.mockReset(); onDone.mockClear(); pending = false;
  });

  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("explains a missing name beside the form and sends nothing", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Target amount", "2000");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the goal a name.");
    expect(create).not.toHaveBeenCalled();
  });

  it("explains a target of zero", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target amount", "0");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Set a target of at least $0.01.");
  });

  it("adds a goal updated by hand", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target amount", "2000");
    type("Target date (optional)", "2027-03-01");
    type("Saved so far", "250");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(create.mock.calls[0][0]).toEqual({
      name: "Trip", target_amount: 2000, target_date: "2027-03-01", account_id: null, saved_amount: 250,
    });
  });

  it("follows an account instead, and then asks for no amount", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Emergency fund");
    type("Target amount", "10000");
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
    type("Target amount", "2500");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(update.mock.calls[0][0]).toEqual({
      id: 5,
      goal: { name: "Trip", target_amount: 2500, target_date: "2027-03-01", account_id: null, saved_amount: 300 },
    });
  });

  it("shows an amount kept by hand when switching away from an account", () => {
    const goal: Goal = {
      id: 5, name: "Trip", target_amount: 2000, target_date: null,
      account_id: 1, saved_amount: 300, created_at: "",
    };
    render(<GoalForm goal={goal} accounts={[savings]} onDone={onDone} />);
    expect(screen.queryByLabelText("Saved so far")).toBeNull();
    type("Track it with", "");
    expect(screen.getByLabelText("Saved so far")).toHaveValue("300");
  });

  describe("a goal whose account is hidden or gone", () => {
    const orphaned: Goal = {
      id: 5, name: "Trip", target_amount: 2000, target_date: null,
      account_id: 99, saved_amount: 300, created_at: "",
    };
    // The hint is part of the label, so the field is found by how the label starts.
    const saved = () => screen.getByLabelText(/^Saved so far/);
    const hint = "This goal shows this amount while its account is hidden.";

    it("says so in the account choice, and shows the amount the goal displays", () => {
      render(<GoalForm goal={orphaned} accounts={[savings]} onDone={onDone} />);
      expect(screen.getByLabelText("Track it with")).toHaveDisplayValue("An account you've hidden");
      expect(saved()).toHaveValue("300");
      expect(screen.getByText(hint)).toBeInTheDocument();
    });

    it("keeps the account and lets the amount be changed", () => {
      render(<GoalForm goal={orphaned} accounts={[savings]} onDone={onDone} />);
      fireEvent.change(saved(), { target: { value: "350" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(update.mock.calls[0][0].goal).toMatchObject({ account_id: 99, saved_amount: 350 });
    });

    it("explains an amount that cannot be saved", () => {
      render(<GoalForm goal={orphaned} accounts={[savings]} onDone={onDone} />);
      fireEvent.change(saved(), { target: { value: "-5" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent("The amount saved can't be below $0.");
      expect(update).not.toHaveBeenCalled();
    });

    it("keeps the amount when switched to updating it by hand", () => {
      render(<GoalForm goal={orphaned} accounts={[savings]} onDone={onDone} />);
      type("Track it with", "");
      expect(saved()).toHaveValue("300");
      expect(screen.queryByText(hint)).toBeNull();
    });

    it("names a followed account that has become a credit card, and says what the amount is for", () => {
      const card = { ...savings, id: 99, name: "Card", type: "credit" } as Account;
      render(<GoalForm goal={orphaned} accounts={[savings]} otherAccounts={[card]} onDone={onDone} />);
      expect(screen.getByLabelText("Track it with")).toHaveDisplayValue("Card (now a credit card)");
      expect(screen.getByText("This goal shows this amount while it follows a credit card.")).toBeInTheDocument();
      expect(screen.queryByText("An account you've hidden")).toBeNull();
    });

    it("offers no such choice when nothing is hidden", () => {
      render(<GoalForm accounts={[savings]} onDone={onDone} />);
      expect(screen.queryByText("An account you've hidden")).toBeNull();
    });
  });

  it("clears the date with a No date button, shown only while a date is set", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    expect(screen.queryByRole("button", { name: "No date" })).toBeNull();
    type("Target date (optional)", "2027-03-01");
    fireEvent.click(screen.getByRole("button", { name: "No date" }));
    expect(screen.getByLabelText("Target date (optional)")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "No date" })).toBeNull();
  });

  it("clears an explanation as soon as anything is changed", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    type("Name", "Trip");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("disables Add goal while sending, so a second click sends nothing", () => {
    pending = true;
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target amount", "10");
    const add = screen.getByRole("button", { name: "Add goal" });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(create).not.toHaveBeenCalled();
  });

  it("shows an error from the server and stays open", () => {
    create.mockImplementation((_goal, options) => options.onError("That account no longer exists. Choose another."));
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target amount", "10");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("That account no longer exists. Choose another.");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("closes once the goal is saved", () => {
    create.mockImplementation((_goal, options) => options.onSuccess());
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target amount", "10");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("cancels without sending anything", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
