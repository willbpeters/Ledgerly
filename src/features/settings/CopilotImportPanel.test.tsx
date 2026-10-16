import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CopilotImportPanel } from "./CopilotImportPanel";
import type { CopilotPlan } from "../../domain/types";

const plan: CopilotPlan = {
  matches: [{ txn_id: 1, category: "Dining", note: null }],
  additions: [{ external_id: "copilot:a", posted: "2025-01-01", amount: -8, name: "Old Diner", category: "Dining" }],
  skipped: [{ date: "2026-07-10", name: "Mystery", amount: -9.99, account: "Adv SafeBalance Banking" }],
  not_in_copilot: [
    { txn_id: 41, date: "2026-07-04", name: "Transfer from Apple Pay", amount: 40, account: "Card (9849)" },
    { txn_id: 42, date: "2026-07-05", name: "Target", amount: -12, account: "Card (9849)" },
  ],
  pending_or_excluded: 2,
  new_categories: [{ name: "Golf", kind: "spending" }],
  rules: [{ pattern: "haggin oaks", category: "Golf" }],
  accounts: [["Adv SafeBalance Banking", "Card (9849)"], ["(no account)", "Copilot history"]],
};
const base = {
  plan: null, result: null, busy: false, removeIds: new Set<number>(),
  onChoose: vi.fn(), onImport: vi.fn(), onToggleRemove: vi.fn(), onSetAllRemove: vi.fn(),
};

describe("CopilotImportPanel", () => {
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
