import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Headline } from "./Headline";
import type { PortfolioSummary } from "../../domain/types";

function summary(p: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    totalValue: 142318.44, investedValue: 98204, cash: 46114.44, liabilities: -2000,
    totalCostBasis: 79757, unrealized: 18447, unrealizedPct: 23.1,
    realized: 0, dayChange: 1204, dayChangePct: 1.24, ...p,
  };
}

describe("Headline", () => {
  it("shows net worth as the hero figure", () => {
    render(<Headline summary={summary()} />);
    expect(screen.getByText("Net worth")).toBeInTheDocument();
    expect(screen.getByText("$142,318")).toBeInTheDocument();
    expect(screen.getByText(".44")).toBeInTheDocument();
  });

  it("shows invested value beside cash and owed", () => {
    render(<Headline summary={summary()} />);
    expect(screen.getByText("Invested")).toBeInTheDocument();
    expect(screen.getByText("$98,204.00")).toBeInTheDocument();
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("Owed")).toBeInTheDocument();
  });

  it("says that Today and All time describe the investments", () => {
    render(<Headline summary={summary()} />);
    // Without the label a reader cannot tell whether 1.24% is the investments
    // or net worth, and the two figures genuinely differ.
    expect(screen.getByText(/Today.*investments/)).toBeInTheDocument();
    expect(screen.getByText(/All time.*investments/)).toBeInTheDocument();
  });

  it("hides Owed when nothing is owed", () => {
    render(<Headline summary={summary({ liabilities: 0 })} />);
    expect(screen.queryByText("Owed")).not.toBeInTheDocument();
  });
});
