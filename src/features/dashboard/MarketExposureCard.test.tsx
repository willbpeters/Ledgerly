import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MarketExposureCard } from "./MarketExposureCard";
import type { MarketExposure } from "../../domain/risk";

function exposure(over: Partial<MarketExposure> = {}): MarketExposure {
  return {
    alpha: 0.031, beta: 1.15, r2: 0.88, volatility: 0.19,
    observations: 480, includedCount: 8, excludedTickers: [],
    includedValueShare: 1,
    ...over,
  };
}

describe("MarketExposureCard", () => {
  it("leads with alpha and says what it means in words", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText("+3.1%")).toBeInTheDocument();
    expect(screen.getByText(/market exposure explains/i)).toBeInTheDocument();
  });

  it("shows beta next to alpha, because alpha alone is misleading", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText("1.15")).toBeInTheDocument();
  });

  it("shows R-squared and volatility as supporting figures", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText("88.0%")).toBeInTheDocument();
    expect(screen.getByText("19.0%")).toBeInTheDocument();
  });

  it("says the figures assume today's holdings, every time", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText(/hold today/i)).toBeInTheDocument();
    expect(screen.getByText(/not a forecast/i)).toBeInTheDocument();
  });

  it("names the holdings it could not measure", () => {
    render(
      <MarketExposureCard
        exposure={exposure({ excludedTickers: ["SWVXX", "FDRXX"], includedValueShare: 0.82 })}
        isLoading={false}
      />,
    );
    expect(screen.getByText(/SWVXX, FDRXX/)).toBeInTheDocument();
  });

  it("says how much of the portfolio the figures cover when some was unmeasurable", () => {
    // A confident beta computed over 40% of someone's money reads exactly like
    // one computed over all of it. This line is what tells them apart.
    render(
      <MarketExposureCard
        exposure={exposure({ excludedTickers: ["SWVXX"], includedValueShare: 0.4 })}
        isLoading={false}
      />,
    );
    expect(
      screen.getByText((_, el) => {
        if (!el || el.tagName.toLowerCase() !== "p") return false;
        const hasText = el.textContent?.includes("40.0% of your portfolio") ?? false;
        const childHasText = Array.from(el.children).some((c) => c.textContent?.includes("40.0% of your portfolio"));
        return hasText && !childHasText;
      }),
    ).toBeInTheDocument();
  });

  it("does not clutter the card with a coverage note when it measured everything", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.queryByText(/of your portfolio/i)).not.toBeInTheDocument();
  });

  it("says what is missing instead of showing zeros when there is not enough history", () => {
    render(
      <MarketExposureCard
        exposure={exposure({ alpha: null, beta: null, r2: null, volatility: null, observations: 40 })}
        isLoading={false}
      />,
    );
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
    expect(screen.getByText(/Not enough price history/i)).toBeInTheDocument();
    expect(screen.getByText(/40 days/)).toBeInTheDocument();
  });

  it("shows a negative alpha as a loss against the market, not a gain", () => {
    render(<MarketExposureCard exposure={exposure({ alpha: -0.042 })} isLoading={false} />);
    expect(screen.getByText("-4.2%")).toBeInTheDocument();
    expect(screen.getByText(/less than its market exposure explains/i)).toBeInTheDocument();
  });

  it("still shows volatility when only the benchmark is unusable", () => {
    // The S&P history failed to download; the owner's own holdings have two
    // clean years. Their volatility is fully knowable and must not be thrown
    // away with the figures that genuinely need the benchmark.
    render(
      <MarketExposureCard
        exposure={exposure({ alpha: null, beta: null, r2: null, volatility: 0.22 })}
        isLoading={false}
      />,
    );
    expect(screen.getByText("22.0%")).toBeInTheDocument();
    expect(screen.getByText(/S&P 500's own history/i)).toBeInTheDocument();
    expect(screen.queryByText(/Not enough price history/i)).not.toBeInTheDocument();
    // The caveat applies to this figure too: it is the same weighted series.
    expect(screen.getByText(/hold today/i)).toBeInTheDocument();
    expect(screen.getByText(/not a forecast/i)).toBeInTheDocument();
  });

  it("falls back to the empty state when even volatility is missing", () => {
    render(
      <MarketExposureCard
        exposure={exposure({ alpha: null, beta: null, r2: null, volatility: null, observations: 40 })}
        isLoading={false}
      />,
    );
    expect(screen.getByText(/Not enough price history/i)).toBeInTheDocument();
    expect(screen.getByText(/40 days/)).toBeInTheDocument();
  });
});
