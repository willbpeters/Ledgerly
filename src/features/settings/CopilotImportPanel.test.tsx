import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CopilotImportPanel } from "./CopilotImportPanel";
import type { CopilotPlan } from "../../domain/types";

const plan: CopilotPlan = {
  matches: [{ txn_id: 1, category: "Dining", note: null }],
  additions: [{ external_id: "copilot:a", posted: "2025-01-01", amount: -8, name: "Old Diner", category: "Dining" }],
  skipped: [{ date: "2026-07-10", name: "Mystery", amount: -9.99, account: "Adv SafeBalance Banking" }],
  pending_or_excluded: 2,
  new_categories: [{ name: "Golf", kind: "spending" }],
  rules: [{ pattern: "haggin oaks", category: "Golf" }],
  accounts: [["Adv SafeBalance Banking", "Card (9849)"], ["(no account)", "Copilot history"]],
};
const base = { plan: null, result: null, busy: false, onChoose: vi.fn(), onImport: vi.fn() };

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
    expect(screen.getByText(/Card \(9849\)/)).toBeInTheDocument();
  });

  it("imports from the preview", () => {
    const onImport = vi.fn();
    render(<CopilotImportPanel {...base} plan={plan} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(onImport).toHaveBeenCalled();
  });

  it("reports the result", () => {
    render(<CopilotImportPanel {...base} result={{ matched: 250, added: 1796, categories: 10, rules: 102 }} />);
    expect(screen.getByText(/250 matched/)).toBeInTheDocument();
  });
});
