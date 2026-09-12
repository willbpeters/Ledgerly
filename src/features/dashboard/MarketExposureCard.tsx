import { pct, share } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import type { MarketExposure } from "../../domain/risk";

/**
 * Market exposure: how much of the portfolio is just the market, and what is
 * left over once that is paid for.
 *
 * Like the concentration card, this describes and never advises. It also
 * carries a caveat the other cards do not need: the figures apply today's
 * holdings to two years of history, because the app cannot know what was held
 * two years ago. That is stated on the card, not buried — it is the difference
 * between a useful statistic and a misunderstanding.
 */
export function MarketExposureCard(
  { exposure, isLoading }: { exposure: MarketExposure; isLoading: boolean },
) {
  const {
    alpha, beta, r2, volatility, observations, excludedTickers, includedValueShare,
  } = exposure;

  if (isLoading) {
    return <Card title="Versus the S&P 500"><p className="muted">Loading…</p></Card>;
  }

  if (alpha == null || beta == null || r2 == null) {
    return (
      <Card title="Versus the S&P 500">
        <EmptyState
          title="Not enough price history yet"
          body={`These figures need about a year of daily closes shared by every holding and the index. There ${observations === 1 ? "is" : "are"} ${observations} days so far — they fill in as prices are downloaded.`}
        />
      </Card>
    );
  }

  const ahead = alpha >= 0;

  return (
    <Card
      title="Versus the S&P 500"
      subtitle={`${observations} trading days of shared history`}
    >
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Alpha (per year)</div>
          <div className={`stat-value ${ahead ? "pos" : "neg"}`}>{pct(alpha * 100)}</div>
          <div className="cell-secondary">after adjusting for risk</div>
        </div>
        <div className="stat">
          <div className="stat-label">Beta</div>
          <div className="stat-value">{beta.toFixed(2)}</div>
          <div className="cell-secondary">vs the index at 1.00</div>
        </div>
        <div className="stat">
          <div className="stat-label">Explained by the market</div>
          <div className="stat-value">{share(r2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Volatility (per year)</div>
          <div className="stat-value">{volatility == null ? "—" : share(volatility)}</div>
        </div>
      </div>

      <p className="muted">
        Your portfolio returned {share(Math.abs(alpha))} a year{" "}
        {ahead ? "more" : "less"} than its market exposure explains. It has moved{" "}
        {beta.toFixed(2)}× the index.
      </p>

      {excludedTickers.length > 0 && (
        <p className="muted">
          {excludedTickers.length} holding{excludedTickers.length === 1 ? "" : "s"} left out
          for want of price history: {excludedTickers.join(", ")}. The figures above cover{" "}
          {share(includedValueShare)} of your portfolio.
        </p>
      )}

      <p className="muted" style={{ marginBottom: 0 }}>
        Measured by applying the holdings you hold today to the last two years of
        prices — not a record of what the account actually did, and not a forecast.
      </p>
    </Card>
  );
}
