import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { DrawdownCard } from "./DrawdownCard";
import type { Drawdown } from "../../domain/drawdown";

function dd(p: Partial<Drawdown> = {}): Drawdown {
  return {
    worst: { fall: -0.234, peakDate: "2025-02-19", troughDate: "2025-04-08", recoveredDate: "2025-06-27" },
    fromHigh: { fall: -0.041, highDate: "2026-09-30", below: 7450 },
    observations: 498, excludedTickers: [], includedValueShare: 1, ...p,
  };
}

describe("DrawdownCard", () => {
  it("shows the worst fall with its dates and recovery", () => {
    render(<DrawdownCard drawdown={dd()} isLoading={false} />);
    expect(screen.getByText("-23.4%")).toHaveClass("neg");
    expect(screen.getByText("2025-02-19 → 2025-04-08 · recovered 2025-06-27")).toBeInTheDocument();
  });

  it("says when the worst fall has not been made back", () => {
    const worst = { fall: -0.3, peakDate: "2026-01-02", troughDate: "2026-03-04", recoveredDate: null };
    render(<DrawdownCard drawdown={dd({ worst })} isLoading={false} />);
    expect(screen.getByText("2026-01-02 → 2026-03-04 · not yet recovered")).toBeInTheDocument();
  });

  it("says how far below the high today is, in percent and dollars", () => {
    render(<DrawdownCard drawdown={dd()} isLoading={false} />);
    expect(screen.getByText("-4.1%")).toHaveClass("neg");
    expect(screen.getByText("$7,450.00 below the high on 2026-09-30")).toBeInTheDocument();
  });

  it("says so when today is the high", () => {
    render(<DrawdownCard drawdown={dd({ fromHigh: { fall: 0, highDate: "2026-10-21", below: 0 } })} isLoading={false} />);
    expect(screen.getByText("At the high")).toBeInTheDocument();
  });

  it("says so when the holdings never fell", () => {
    render(<DrawdownCard drawdown={dd({ worst: null })} isLoading={false} />);
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("names holdings left out, and how much the figures cover", () => {
    render(<DrawdownCard drawdown={dd({ excludedTickers: ["SWLGX"], includedValueShare: 0.612 })} isLoading={false} />);
    expect(screen.getByText(/left out for want of price history: SWLGX/)).toHaveTextContent("cover 61.2% of your holdings");
  });

  it("always carries the today's-holdings caveat", () => {
    render(<DrawdownCard drawdown={dd()} isLoading={false} />);
    expect(screen.getByText(/the holdings you hold today/)).toBeInTheDocument();
  });

  it("waits for history rather than showing a figure it does not have", () => {
    render(<DrawdownCard drawdown={dd({ worst: null, fromHigh: null, observations: 40 })} isLoading={false} />);
    expect(screen.getByText("Not enough price history yet")).toBeInTheDocument();
    expect(screen.queryByText("None")).not.toBeInTheDocument();
  });
});
