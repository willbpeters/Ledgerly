import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { RiskCard } from "./RiskCard";
import type { Holding } from "../../domain/types";

function holding(ticker: string, marketValue: number): Holding {
  return {
    security_id: ticker.charCodeAt(0), ticker, type: "etf",
    shares: 1, avgCost: marketValue, costBasis: marketValue,
    lastPrice: marketValue, marketValue,
    unrealized: 0, unrealizedPct: 0, realized: 0,
  };
}

describe("RiskCard", () => {
  const lopsided = [
    holding("NVDA", 800), holding("A", 50), holding("B", 50), holding("C", 50), holding("D", 50),
  ];

  it("names the largest holding and its share", () => {
    render(<RiskCard holdings={lopsided} cash={0} />);
    expect(screen.getByText("NVDA")).toBeInTheDocument();
    expect(screen.getByText("80.0%")).toBeInTheDocument();
  });

  it("shows how many positions the portfolio really behaves like", () => {
    render(<RiskCard holdings={lopsided} cash={0} />);
    // Five holdings, but 80% in one: an effective count near 1.5.
    expect(screen.getByText("1.5")).toBeInTheDocument();
  });

  it("puts the effective count in plain English", () => {
    render(<RiskCard holdings={lopsided} cash={0} />);
    expect(screen.getByText(/behaves like about 1\.5 equally-sized holdings/i)).toBeInTheDocument();
  });

  it("shows the combined weight of the five largest", () => {
    render(<RiskCard holdings={[...lopsided, holding("E", 100)]} cash={0} />);
    expect(screen.getByText(/Top 5/)).toBeInTheDocument();
  });

  it("reports how much is sitting in cash", () => {
    render(<RiskCard holdings={[holding("A", 750)]} cash={250} />);
    expect(screen.getByText("25.0%")).toBeInTheDocument();
  });

  it("says there is nothing to measure rather than showing zeros", () => {
    render(<RiskCard holdings={[]} cash={0} />);
    expect(screen.getByText(/nothing invested to measure yet/i)).toBeInTheDocument();
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("describes the portfolio without telling anyone what to do", () => {
    const { container } = render(<RiskCard holdings={lopsided} cash={0} />);
    const text = container.textContent ?? "";
    for (const word of ["should", "recommend", "buy", "sell", "too risky"]) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });
});
