import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CopilotImportPanel } from "./CopilotImportPanel";
import type { CopilotPlan } from "../../domain/types";

const plan: CopilotPlan = {
  matches: [{ txn_id: 1, category: "Eating Out", note: null, name: "Joe's Diner" }],
  additions: [
    { external_id: "copilot:a", posted: "2025-01-01", amount: -8, name: "Old Diner", category: "Eating Out" },
    { external_id: "copilot:b", posted: "2026-07-10", amount: -9.99, name: "Mystery", category: "Shops" },
  ],
  not_in_copilot: [
    { txn_id: 41, date: "2026-07-04", name: "Transfer from Apple Pay", amount: 40, account: "Card (9849)", earlier_export: false },
    { txn_id: 42, date: "2026-07-05", name: "Target", amount: -12, account: "Card (9849)", earlier_export: true },
  ],
  pending: 2,
  new_categories: [{ name: "Golf", kind: "spending" }],
  rules: [{ pattern: "haggin oaks", category: "Golf" }],
  accounts: [["Adv SafeBalance Banking", "Card (9849)"], ["(no account)", "Copilot history"]],
  cutoff: "2026-10-24",
  merges: [["Dining", "Eating Out"], ["Shopping", "Shops"]],
  deletions: ["Travel", "Poker"],
  uncategorised: 3,
  recategorised: 12,
  untouched_after_cutoff: 5,
  export_categories: ["Eating Out", "Shops", "Golf", "Car", "Excluded"],
  not_counted: ["Car"],
};
const base = { plan: null, result: null, busy: false, onChoose: vi.fn(), onImport: vi.fn() };

describe("CopilotImportPanel", () => {
  it("only offers to choose a file before a preview", () => {
    render(<CopilotImportPanel {...base} />);
    expect(screen.getByRole("button", { name: /Choose Copilot export/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });

  it("previews the copy: matched, added, removed and pending", () => {
    render(<CopilotImportPanel {...base} plan={plan} />);
    expect(screen.getByText("Up to Oct 24, 2026, the export's last day:")).toBeInTheDocument();
    expect(screen.getByText("1 matched")).toBeInTheDocument();
    expect(screen.getByText("2 added")).toBeInTheDocument();
    expect(screen.getByText("2 removed")).toBeInTheDocument();
    expect(screen.getByText("2 transactions pending in Copilot, left for your bank sync")).toBeInTheDocument();
    expect(screen.getByText("Adv SafeBalance Banking → Card (9849)")).toBeInTheDocument();
  });

  it("lists what it removes, without asking, and labels a row from an earlier export", () => {
    render(<CopilotImportPanel {...base} plan={plan} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/Target.*From an earlier Copilot export; Copilot no longer has it/)).toBeInTheDocument();
    expect(screen.getByText(/Transfer from Apple Pay/)).not.toHaveTextContent(/earlier Copilot export/);
  });

  it("says the categories become exactly Copilot's, and what changes", () => {
    render(<CopilotImportPanel {...base} plan={plan} />);
    expect(screen.getByText("Eating Out, Shops, Golf, Car, Excluded")).toBeInTheDocument();
    expect(screen.getByText(/excluded one by one in Copilot go in Excluded, which shows but never counts as spending/)).toBeInTheDocument();
    expect(screen.getByText(/Not counted as spending, as in Copilot: Car./)).toBeInTheDocument();
    expect(screen.getByText("New: Golf")).toBeInTheDocument();
    expect(screen.getByText("Renamed or merged: Dining → Eating Out, Shopping → Shops")).toBeInTheDocument();
    expect(screen.getByText("Removed: Travel, Poker")).toBeInTheDocument();
    expect(screen.getByText("12 transactions get Copilot's category")).toBeInTheDocument();
    expect(screen.getByText("3 transactions Copilot doesn't cover lose their category and go back to To review")).toBeInTheDocument();
    expect(screen.getByText("5 transactions after Oct 24, 2026 stay as they are, apart from their category")).toBeInTheDocument();
    expect(screen.getByText("Rules learned from Copilot will also sort new transactions from your bank from now on.")).toBeInTheDocument();
  });

  it("leaves out changes there aren't any of", () => {
    render(<CopilotImportPanel {...base} plan={{
      ...plan, not_in_copilot: [], pending: 0, merges: [], deletions: [], new_categories: [], rules: [],
      uncategorised: 0, recategorised: 1, untouched_after_cutoff: 0, export_categories: ["Eating Out"], not_counted: [],
    }} />);
    for (const text of [/removed/, /pending/, /Renamed/, /^Removed:/, /^New:/, /Excluded/, /Not counted/, /To review/, /stay as they are/, /Rules learned from Copilot/]) {
      expect(screen.queryByText(text)).toBeNull();
    }
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
});
