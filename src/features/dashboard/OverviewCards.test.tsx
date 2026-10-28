import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { AccountsCard } from "./AccountsCard";
import { RecentActivityCard } from "./RecentActivityCard";
import type { AccountGroup, ActivityRow } from "../../domain/overview";
import type { Account } from "../../domain/types";

const acct = (id: number, name: string, type: Account["type"], institution: string | null): Account =>
  ({ id, name, type, institution, currency: "USD", created_at: "", source: "manual", external_id: null,
     synced_balance: null, last_synced_at: null, hidden: false });

describe("AccountsCard", () => {
  it("lists each group with its total, then its accounts", () => {
    const groups: AccountGroup[] = [
      { type: "cash", label: "Cash", total: 8020, accounts: [{ account: acct(1, "Checking", "cash", "Chase"), value: 8020 }] },
      { type: "credit", label: "Credit cards", total: -2690, accounts: [{ account: acct(2, "Sapphire", "credit", null), value: -2690 }] },
    ];
    render(<MemoryRouter><AccountsCard groups={groups} /></MemoryRouter>);
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("Credit cards")).toBeInTheDocument();
    // Once as the group total, once as the account.
    expect(screen.getAllByText("$8,020.00")).toHaveLength(2);
    expect(screen.getByText("Checking")).toBeInTheDocument();
    expect(screen.getByText("Chase")).toBeInTheDocument();
    for (const el of screen.getAllByText("-$2,690.00")) expect(el).toHaveClass("neg");
  });

  it("points to Accounts when there are none", () => {
    render(<MemoryRouter><AccountsCard groups={[]} /></MemoryRouter>);
    expect(screen.getByText("No accounts yet")).toBeInTheDocument();
  });
});

describe("RecentActivityCard", () => {
  it("shows each row, with money in marked positive and pending flagged", () => {
    const rows: ActivityRow[] = [
      { key: "b1", date: "2026-10-20", description: "Whole Foods", account: "Sapphire", amount: -84.12, pending: true },
      { key: "b2", date: "2026-10-18", description: "Payroll", account: "Checking", amount: 3240, pending: false },
    ];
    render(<MemoryRouter><RecentActivityCard rows={rows} /></MemoryRouter>);
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("-$84.12")).not.toHaveClass("pos");
    expect(screen.getByText("+$3,240.00")).toHaveClass("pos");
  });

  it("says so when the week was quiet", () => {
    render(<MemoryRouter><RecentActivityCard rows={[]} /></MemoryRouter>);
    expect(screen.getByText("No transactions in the last 7 days")).toBeInTheDocument();
  });
});
