import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { AccountHoldingsCard, COLLAPSED_KEY } from "./AccountHoldingsCard";

function card(id = 1) {
  return (
    <AccountHoldingsCard accountId={id} title="Roth IRA" subtitle="$44,470.00 in holdings">
      <p>the table</p>
    </AccountHoldingsCard>
  );
}

describe("AccountHoldingsCard", () => {
  beforeEach(() => localStorage.clear());

  it("opens by default, showing its holdings", () => {
    render(card());
    expect(screen.getByRole("button", { name: /Roth IRA/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("the table")).toBeInTheDocument();
  });

  it("closes and reopens from its header, keeping the summary visible", () => {
    render(card());
    const header = screen.getByRole("button", { name: /Roth IRA/ });
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("the table")).not.toBeInTheDocument();
    expect(screen.getByText("$44,470.00 in holdings")).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.getByText("the table")).toBeInTheDocument();
  });

  it("remembers a closed account the next time Holdings opens", () => {
    const { unmount } = render(card(7));
    fireEvent.click(screen.getByRole("button", { name: /Roth IRA/ }));
    unmount();
    render(card(7));
    expect(screen.queryByText("the table")).not.toBeInTheDocument();
  });

  it("closes only the account that was clicked", () => {
    render(<>{card(1)}{card(2)}</>);
    fireEvent.click(screen.getAllByRole("button", { name: /Roth IRA/ })[0]);
    expect(screen.getAllByText("the table")).toHaveLength(1);
  });

  it("shrugs off unreadable stored state", () => {
    localStorage.setItem(COLLAPSED_KEY, "not json");
    render(card());
    expect(screen.getByText("the table")).toBeInTheDocument();
  });
});
