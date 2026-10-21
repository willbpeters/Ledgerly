import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ValueCard as RawValueCard, CHART_MODES, MODE_ORDER, yAxisMin } from "./ValueCard";
import { ThemeProvider } from "../../ui/theme";
import type { PortfolioSummary } from "../../domain/types";

// The chart colours read the theme, so every render needs its provider.
function ValueCard(props: Parameters<typeof RawValueCard>[0]) {
  return <ThemeProvider><RawValueCard {...props} /></ThemeProvider>;
}

function summary(p: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    totalValue: 142318.44, investedValue: 98204, cash: 46114.44, liabilities: -2000,
    totalCostBasis: 79757, unrealized: 18447, unrealizedPct: 23.1,
    realized: 0, dayChange: 1204, dayChangePct: 1.24, ...p,
  };
}

describe("ValueCard", () => {
  it("shows the four measures as tabs, net worth as the hero", () => {
    render(<ValueCard summary={summary()} series={[]} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label")))
      .toEqual(["Net worth", "Investments", "Cash", "Liabilities"]);
    expect(screen.getByText("$142,318")).toBeInTheDocument();
    expect(screen.getByText(".44")).toBeInTheDocument();
    expect(screen.getByText("$98,204.00")).toBeInTheDocument();
    expect(screen.getByText("$46,114.44")).toBeInTheDocument();
  });

  // Today and All time measure the investments only. Sitting under that tab is
  // what says so, now that the old "(investments)" captions are gone.
  it("puts today and all time under Investments", () => {
    render(<ValueCard summary={summary()} series={[]} />);
    const tab = screen.getByRole("tab", { name: "Investments" });
    expect(tab).toHaveTextContent("+$1,204.00 today");
    expect(tab).toHaveTextContent("+23.1% all time");
  });

  it("marks a falling day and a loss as negative", () => {
    render(<ValueCard summary={summary({ dayChange: -50, unrealized: -10, unrealizedPct: -2 })} series={[]} />);
    expect(screen.getByText("-$50.00 today")).toHaveClass("neg");
    expect(screen.getByText("-2.0% all time")).toHaveClass("neg");
  });

  it("shows liabilities negative and red, and keeps the tab when nothing is owed", () => {
    const { rerender } = render(<ValueCard summary={summary()} series={[]} />);
    expect(screen.getByText("-$2,000.00")).toHaveClass("neg");
    rerender(<ValueCard summary={summary({ liabilities: 0 })} series={[]} />);
    expect(screen.getByRole("tab", { name: "Liabilities" })).toHaveTextContent("$0.00");
  });

  it("opens on net worth, and a tab swaps the caveat", () => {
    render(<ValueCard summary={summary()} series={[]} />);
    expect(screen.getByRole("tab", { name: "Net worth" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Cash" }));
    expect(screen.getByRole("tab", { name: "Cash" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Net worth" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText(CHART_MODES.cash.subtitle)).toBeInTheDocument();
  });
});

// The chart's dataKey and its caveat are two encodings of the same choice, kept
// in one table so a line can never be plotted under another line's caveat.
describe("CHART_MODES", () => {
  it("plots a different field, and states a different caveat, per mode", () => {
    expect(MODE_ORDER.map((m) => CHART_MODES[m].dataKey)).toEqual(["value", "invested", "cash", "liabilities"]);
    expect(new Set(MODE_ORDER.map((m) => CHART_MODES[m].subtitle)).size).toBe(4);
    // Only the net-worth line is rebuilt from all cash movements; saying so of
    // the investments line would be a false caveat — worse than none.
    expect(CHART_MODES.networth.subtitle).toMatch(/cash movements/);
    expect(CHART_MODES.invested.subtitle).not.toMatch(/cash movements/);
  });
});

describe("yAxisMin", () => {
  it("zooms to the data, and goes below zero when the data does", () => {
    expect(yAxisMin(1000)).toBeCloseTo(970);
    expect(yAxisMin(-100)).toBeCloseTo(-103);
  });
});
