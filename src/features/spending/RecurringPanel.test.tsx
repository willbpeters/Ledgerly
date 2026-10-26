import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RecurringPanel } from "./RecurringPanel";
import { ToastProvider } from "../../ui/toast";
import type { Account, BankTransaction, Category } from "../../domain/types";

const category: Category = { id: 1, name: "Subscriptions", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true };
const account = { id: 1, name: "Card", hidden: false, type: "credit" } as Account;
let n = 0;
const charge = (payee: string, posted: string, amount: number): BankTransaction => ({
  id: ++n, account_id: 1, external_id: `t${n}`, posted, amount, description: payee.toUpperCase(),
  payee, memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: true, note: null, removed: false, splits: [],
});
const monthly = (payee: string, day: string, months: string[], amount: number) =>
  months.map((m) => charge(payee, `${m}-${day}`, amount));

const TODAY = "2026-10-20";
const netflix = monthly("Netflix", "05", ["2026-07", "2026-08", "2026-09", "2026-10"], -15.49);
const spotify = monthly("Spotify", "25", ["2026-07", "2026-08", "2026-09"], -11.99);

function renderPanel(
  transactions: BankTransaction[],
  { dismissed = [] as string[], onSetDismissed = vi.fn().mockResolvedValue(undefined), loading = false } = {},
) {
  render(
    <ToastProvider>
      <RecurringPanel transactions={transactions} loading={loading} categories={[category]} accounts={[account]}
        dismissed={dismissed} onSetDismissed={onSetDismissed} today={TODAY} />
    </ToastProvider>,
  );
  return { onSetDismissed };
}

describe("RecurringPanel", () => {
  it("lists a bill with how often, how much, and where it stands", () => {
    renderPanel(netflix);
    const row = screen.getByRole("row", { name: /Netflix/ });
    expect(within(row).getByText("Monthly")).toBeInTheDocument();
    expect(within(row).getByText("$15.49")).toBeInTheDocument();
    expect(within(row).getByText("Nov 5")).toBeInTheDocument();
    expect(within(row).getByText("Paid this month")).toBeInTheDocument();
    expect(within(row).getByText("Card")).toBeInTheDocument();
  });

  it("says what is still due this month", () => {
    renderPanel([...netflix, ...spotify]);
    expect(within(screen.getByRole("row", { name: /Spotify/ })).getByText("Due Oct 25")).toBeInTheDocument();
    expect(screen.getByText("Still due this month").parentElement).toHaveTextContent("$11.99");
    expect(screen.getByText("Paid this month", { selector: ".stat-label" }).parentElement).toHaveTextContent("$15.49");
  });

  it("counts distinct bills still due, not charges", () => {
    // One weekly bill, last charged Oct 12: Oct 19 (missed) and Oct 26 are both owed.
    const weekly = ["2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"].map((d) => charge("Meal Kit", d, -30));
    renderPanel(weekly);
    expect(screen.getByText("Still due this month").parentElement).toHaveTextContent("1 bill still due");
    expect(screen.getByText("Still due this month").parentElement).toHaveTextContent("$60.00");
  });

  it("does not claim a weekly bill is paid while its row says Due", () => {
    const weekly = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"].map((d) => charge("Meal Kit", d, -30));
    renderPanel(weekly);
    const row = screen.getByRole("row", { name: /Meal Kit/ });
    expect(within(row).getByText("Due Oct 26")).toBeInTheDocument();
    const paid = screen.getByText("Paid this month", { selector: ".stat-label" }).parentElement!;
    expect(paid).toHaveTextContent("$90.00");
    expect(paid).toHaveTextContent("charged");
    expect(paid).not.toHaveTextContent(/paid so far/i);
  });

  it("explains itself when nothing repeats yet", () => {
    renderPanel([charge("Corner Shop", "2026-10-01", -4)]);
    expect(screen.getByText("No bills spotted yet")).toBeInTheDocument();
  });

  it("dismisses a bill, with Undo", async () => {
    const { onSetDismissed } = renderPanel(netflix);
    fireEvent.click(screen.getByRole("button", { name: "Not recurring: Netflix" }));
    expect(onSetDismissed).toHaveBeenCalledWith("netflix", true);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(onSetDismissed).toHaveBeenLastCalledWith("netflix", false);
  });

  it("offers Undo only once the dismiss has gone through", async () => {
    let finish!: () => void;
    const onSetDismissed = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    renderPanel(netflix, { onSetDismissed });
    fireEvent.click(screen.getByRole("button", { name: "Not recurring: Netflix" }));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    finish();
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("says so, with no Undo, when the dismiss fails", async () => {
    const onSetDismissed = vi.fn().mockRejectedValue(new Error("disk full"));
    renderPanel(netflix, { onSetDismissed });
    fireEvent.click(screen.getByRole("button", { name: "Not recurring: Netflix" }));
    expect(await screen.findByText("Couldn't change that")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("keeps dismissed bills off the list and offers to restore them", () => {
    const { onSetDismissed } = renderPanel(netflix, { dismissed: ["netflix"] });
    expect(screen.queryByRole("row", { name: /Netflix/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Netflix" }));
    expect(onSetDismissed).toHaveBeenCalledWith("netflix", false);
  });

  it("tucks away bills not seen lately, without a status badge", () => {
    renderPanel(monthly("Old Gym", "05", ["2026-03", "2026-04", "2026-05"], -40));
    expect(screen.queryByRole("row", { name: /Old Gym/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not seen lately (1)" }));
    const row = screen.getByRole("row", { name: /Old Gym/ });
    expect(within(row).getByText("May 5")).toBeInTheDocument();
    expect(within(row).getByText("Probably cancelled")).toBeInTheDocument();
    expect(within(row).queryByText(/^Late/)).toBeNull();
    expect(within(row).queryByText(/Last seen/)).toBeNull();
  });

  it("names the year of a date outside this year", () => {
    renderPanel(monthly("Old Gym", "05", ["2025-03", "2025-04", "2025-05"], -40));
    fireEvent.click(screen.getByRole("button", { name: "Not seen lately (1)" }));
    expect(within(screen.getByRole("row", { name: /Old Gym/ })).getByText("May 5, 2025")).toBeInTheDocument();
  });

  it("marks the two collapsed lists as expanded or not", () => {
    renderPanel([...netflix, ...monthly("Old Gym", "05", ["2026-03", "2026-04", "2026-05"], -40), ...spotify],
      { dismissed: ["spotify"] });
    for (const [closed, open] of [["Not seen lately (1)", "Hide not seen lately"], ["Dismissed (1)", "Hide dismissed"]]) {
      const toggle = screen.getByRole("button", { name: closed });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: open })).toHaveAttribute("aria-expanded", "true");
    }
  });

  it("shows dashes, not figures, while loading", () => {
    const { container } = render(
      <ToastProvider>
        <RecurringPanel transactions={[]} loading categories={[category]} accounts={[account]}
          dismissed={[]} onSetDismissed={vi.fn()} today={TODAY} />
      </ToastProvider>,
    );
    expect(screen.getByText("Still due this month").parentElement).toHaveTextContent("—");
    expect(screen.getByText("Paid this month", { selector: ".stat-label" }).parentElement).toHaveTextContent("—");
    expect(container.querySelectorAll(".stat-hint")).toHaveLength(0);
    expect(container).not.toHaveTextContent("$0.00");
  });

  it("disables a row's button while its dismiss is in flight", () => {
    const onSetDismissed = vi.fn().mockReturnValue(new Promise(() => {}));
    renderPanel(netflix, { onSetDismissed });
    const button = screen.getByRole("button", { name: "Not recurring: Netflix" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSetDismissed).toHaveBeenCalledTimes(1);
  });

  it("disables a restore button while it is in flight", () => {
    const onSetDismissed = vi.fn().mockReturnValue(new Promise(() => {}));
    renderPanel(netflix, { dismissed: ["netflix"], onSetDismissed });
    fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));
    const button = screen.getByRole("button", { name: "Restore Netflix" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onSetDismissed).toHaveBeenCalledTimes(1);
  });

  it("says so when Undo fails", async () => {
    const undoFails = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));
    renderPanel(netflix, { onSetDismissed: undoFails });
    fireEvent.click(screen.getByRole("button", { name: "Not recurring: Netflix" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Couldn't undo")).toBeInTheDocument();
  });

  it("says so when a restore fails", async () => {
    renderPanel(netflix, { dismissed: ["netflix"], onSetDismissed: vi.fn().mockRejectedValue(new Error("disk full")) });
    fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Netflix" }));
    expect(await screen.findByText("Couldn't restore")).toBeInTheDocument();
  });

  it("counts several bills still due in the plural", () => {
    const gym = monthly("Gym", "28", ["2026-07", "2026-08", "2026-09"], -40);
    renderPanel([...spotify, ...gym]);
    expect(screen.getByText("Still due this month").parentElement).toHaveTextContent("2 bills still due");
  });

  it("says the list is empty, not that nothing was spotted, when every bill is dismissed", () => {
    renderPanel(netflix, { dismissed: ["netflix"] });
    expect(screen.getByText("No bills on the list")).toBeInTheDocument();
    expect(screen.getByText("You dismissed the ones Tally spotted.")).toBeInTheDocument();
    expect(screen.queryByText("No bills spotted yet")).toBeNull();
  });

  it("still explains the rules when a dismissed key matches nothing", () => {
    renderPanel([charge("Corner Shop", "2026-10-01", -4)], { dismissed: ["ghost"] });
    expect(screen.getByText("No bills spotted yet")).toBeInTheDocument();
  });

  it("says plainly when every spotted bill has stopped", () => {
    renderPanel(monthly("Old Gym", "05", ["2026-03", "2026-04", "2026-05"], -40));
    expect(screen.getByText("None of the bills Tally spotted are still being charged.")).toBeInTheDocument();
  });

  it("lists bills not seen lately with the most recently seen first", () => {
    renderPanel([
      ...monthly("Old Gym", "05", ["2026-02", "2026-03", "2026-04"], -40),
      ...monthly("Old Paper", "07", ["2026-03", "2026-04", "2026-05"], -12),
      ...monthly("Old Club", "09", ["2026-01", "2026-02", "2026-03"], -20),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Not seen lately (3)" }));
    const names = screen.getAllByRole("row").slice(1).map((r) => within(r).getByText(/^Old /).textContent);
    expect(names).toEqual(["Old Paper", "Old Gym", "Old Club"]);
  });

  it("counts a pending latest charge as paid, not late", () => {
    renderPanel([
      ...monthly("Netflix", "15", ["2026-07", "2026-08", "2026-09"], -15.49),
      { ...charge("Netflix", "2026-10-15", -15.49), pending: true },
    ]);
    const row = screen.getByRole("row", { name: /Netflix/ });
    expect(within(row).getByText("Paid this month")).toBeInTheDocument();
    expect(screen.queryByText(/^Late/)).toBeNull();
  });

  it("labels the amount and the actions column", () => {
    renderPanel(netflix);
    expect(screen.getByRole("columnheader", { name: "Usual amount" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });
});
