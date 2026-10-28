import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CopilotImportPanel } from "./CopilotImportPanel";
import type { CopilotPlan } from "../../domain/types";

const plan: CopilotPlan = {
  matches: [{ txn_id: 1, category: "Dining", note: null }],
  additions: [{ external_id: "copilot:a", posted: "2025-01-01", amount: -8, name: "Old Diner", category: "Dining" }],
  skipped: [{ date: "2026-07-10", name: "Mystery", amount: -9.99, account: "Adv SafeBalance Banking" }],
  not_in_copilot: [
    { txn_id: 41, date: "2026-07-04", name: "Transfer from Apple Pay", amount: 40, account: "Card (9849)", earlier_export: false },
    { txn_id: 42, date: "2026-07-05", name: "Target", amount: -12, account: "Card (9849)", earlier_export: true },
  ],
  pending_or_excluded: 2,
  new_categories: [{ name: "Golf", kind: "spending" }],
  rules: [{ pattern: "haggin oaks", category: "Golf" }],
  accounts: [["Adv SafeBalance Banking", "Card (9849)"], ["(no account)", "Copilot history"]],
  cutoff: "2026-10-24",
  merges: [["Dining", "Eating Out"], ["Shopping", "Shops"]],
  deletions: ["Travel"],
  // Travel holds nothing; Poker only a row offered for removal; Subscriptions
  // one row Copilot doesn't cover, and one offered.
  category_holds: [
    { name: "Travel", kept_rows: 0, removable: [], pinned: 0 },
    { name: "Poker", kept_rows: 0, removable: [41], pinned: 0 },
    { name: "Subscriptions", kept_rows: 1, removable: [42], pinned: 0 },
  ],
  recategorised: 12,
  untouched_after_cutoff: 5,
  export_categories: ["Eating Out", "Shops", "Golf"],
};
const base = {
  plan: null, result: null, busy: false, removeIds: new Set<number>(), mode: "remove" as const, onModeChange: vi.fn(),
  categoryMode: "keep" as const, onCategoryModeChange: vi.fn(), keepNames: new Set<string>(), onToggleKeep: vi.fn(),
  onChoose: vi.fn(), onImport: vi.fn(), onToggleRemove: vi.fn(), onSetAllRemove: vi.fn(),
};

describe("CopilotImportPanel", () => {
  it("replacing all offers each category it removes to keep, and says what loses one", () => {
    render(<CopilotImportPanel {...base} plan={plan} removeIds={new Set([41])} categoryMode="replace" />);
    expect(screen.getByText(/Removes every category Copilot doesn't use\. Tick any to keep/)).toBeInTheDocument();
    for (const name of ["Travel", "Poker", "Subscriptions"]) {
      expect(screen.getByRole("checkbox", { name: `Keep ${name}` })).not.toBeChecked();
    }
    expect(screen.getByText("2 transactions in the removed ones become uncategorised and go back to To review")).toBeInTheDocument();
    expect(screen.queryByText(/^Kept:/)).toBeNull();
  });

  it("a category ticked to keep loses none of its transactions", () => {
    const onToggleKeep = vi.fn();
    const { rerender } = render(
      <CopilotImportPanel {...base} plan={plan} categoryMode="replace" onToggleKeep={onToggleKeep} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep Subscriptions" }));
    expect(onToggleKeep).toHaveBeenCalledWith("Subscriptions");
    rerender(<CopilotImportPanel {...base} plan={plan} categoryMode="replace" keepNames={new Set(["Subscriptions"])} />);
    expect(screen.getByRole("checkbox", { name: "Keep Subscriptions" })).toBeChecked();
    // Poker's one row is the only one left to lose a category.
    expect(screen.getByText("1 transaction in the removed ones becomes uncategorised and goes back to To review")).toBeInTheDocument();
  });

  it("keeps a category that only splits or budgets hold, unless replacing all", () => {
    const pinned: CopilotPlan = { ...plan, category_holds: [{ name: "Travel", kept_rows: 0, removable: [], pinned: 2 }] };
    const { rerender } = render(<CopilotImportPanel {...base} plan={pinned} />);
    expect(screen.getByText("Kept: Travel — used by splits or budgets")).toBeInTheDocument();
    rerender(<CopilotImportPanel {...base} plan={pinned} categoryMode="replace" />);
    expect(screen.getByRole("checkbox", { name: "Keep Travel" })).not.toBeChecked();
  });

  it("switches between only Copilot's categories and keeping ones in use", () => {
    const onCategoryModeChange = vi.fn();
    render(<CopilotImportPanel {...base} plan={plan} onCategoryModeChange={onCategoryModeChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Only Copilot's" }));
    expect(onCategoryModeChange).toHaveBeenCalledWith("replace");
  });

  it("only offers to choose a file before a preview", () => {
    render(<CopilotImportPanel {...base} />);
    expect(screen.getByRole("button", { name: /Choose Copilot export/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });

  it("previews what will happen", () => {
    render(<CopilotImportPanel {...base} plan={plan} />);
    expect(screen.getByText(/1 matched/)).toBeInTheDocument();
    expect(screen.getByText(/1 added as history/)).toBeInTheDocument();
    expect(screen.getByText(/Golf/)).toBeInTheDocument();
    expect(screen.getByText(/Mystery/)).toBeInTheDocument();
    expect(screen.getByText("Adv SafeBalance Banking → Card (9849)")).toBeInTheDocument();
  });

  it("says how the categories will change to match Copilot, in plain English", () => {
    render(<CopilotImportPanel {...base} plan={plan} removeIds={new Set([41])} />);
    expect(screen.getByText("Renames and merges: Dining → Eating Out, Shopping → Shops")).toBeInTheDocument();
    expect(screen.getByText("Removes categories no longer used: Travel, Poker")).toBeInTheDocument();
    expect(screen.getByText("Kept: Subscriptions — 2 transactions Copilot doesn't cover")).toBeInTheDocument();
    expect(screen.getByText("12 transactions get Copilot's category")).toBeInTheDocument();
    expect(screen.getByText("5 transactions after Oct 24, 2026 keep their categories (renames aside)")).toBeInTheDocument();
    expect(screen.getByText("Rules learned from Copilot will also sort new transactions from your bank from now on.")).toBeInTheDocument();
  });

  it("follows the ticks: a category goes once every row holding it is removed", () => {
    const { rerender } = render(<CopilotImportPanel {...base} plan={plan} removeIds={new Set()} />);
    expect(screen.getByText("Removes categories no longer used: Travel")).toBeInTheDocument();
    expect(screen.getByText("Kept: Poker — 1 transaction Copilot doesn't cover")).toBeInTheDocument();

    rerender(<CopilotImportPanel {...base} plan={plan} removeIds={new Set([41, 42])} />);
    expect(screen.getByText("Kept: Subscriptions — 1 transaction Copilot doesn't cover")).toBeInTheDocument();
    expect(screen.queryByText(/Kept: Poker/)).toBeNull();

    // Keeping them all removes nothing, ticked or not.
    rerender(<CopilotImportPanel {...base} plan={plan} removeIds={new Set([41, 42])} mode="keep" />);
    expect(screen.getByText("Kept: Poker — 1 transaction Copilot doesn't cover")).toBeInTheDocument();
  });

  it("labels a row from an earlier Copilot export", () => {
    render(<CopilotImportPanel {...base} plan={plan} />);
    expect(screen.getByRole("checkbox", { name: /Target.*From an earlier Copilot export; Copilot no longer has it/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Transfer from Apple Pay/ }).closest("label")).not.toHaveTextContent(/earlier Copilot export/);
  });

  it("leaves out category changes there aren't any of", () => {
    render(<CopilotImportPanel {...base} plan={{
      ...plan, merges: [], deletions: [], category_holds: [], rules: [], recategorised: 1, untouched_after_cutoff: 0,
    }} />);
    expect(screen.queryByText(/Renames/)).toBeNull();
    expect(screen.queryByText(/Removes categories/)).toBeNull();
    expect(screen.queryByText(/Kept:/)).toBeNull();
    expect(screen.queryByText(/keep their categories/)).toBeNull();
    expect(screen.queryByText(/Rules learned from Copilot/)).toBeNull();
    expect(screen.getByText("1 transaction gets Copilot's category")).toBeInTheDocument();
  });

  it("imports from the preview", () => {
    const onImport = vi.fn();
    render(<CopilotImportPanel {...base} plan={plan} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(onImport).toHaveBeenCalled();
  });

  it("reports the result", () => {
    render(<CopilotImportPanel {...base} result={{ matched: 250, added: 1796, categories: 10, rules: 102, removed: 90 }} />);
    expect(screen.getByText(/250 matched/)).toBeInTheDocument();
    expect(screen.getByText(/90 removed/)).toBeInTheDocument();
  });

  it("lists rows deleted in Copilot, ticked as the owner chose", () => {
    render(<CopilotImportPanel {...base} plan={plan} removeIds={new Set([41])} />);
    expect(screen.getByText(/2 not in Copilot/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Transfer from Apple Pay/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Target/ })).not.toBeChecked();
  });

  it("offers to remove or keep what Copilot doesn't have, and keeping hides the list", () => {
    const onModeChange = vi.fn();
    const { rerender } = render(<CopilotImportPanel {...base} plan={plan} onModeChange={onModeChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep them" }));
    expect(onModeChange).toHaveBeenCalledWith("keep");

    rerender(<CopilotImportPanel {...base} plan={plan} mode="keep" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/stay in your transactions/)).toBeInTheDocument();
  });

  it("ticks and unticks one row, or all of them", () => {
    const onToggleRemove = vi.fn();
    const onSetAllRemove = vi.fn();
    render(<CopilotImportPanel {...base} plan={plan} onToggleRemove={onToggleRemove} onSetAllRemove={onSetAllRemove} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Target/ }));
    expect(onToggleRemove).toHaveBeenCalledWith(42);
    fireEvent.click(screen.getByRole("button", { name: "Tick none" }));
    expect(onSetAllRemove).toHaveBeenCalledWith(false);
  });
});
