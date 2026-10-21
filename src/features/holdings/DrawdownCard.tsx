import { money, pct, share, fmtDate } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import type { Drawdown } from "../../domain/drawdown";

/**
 * Drawdown: the worst fall today's holdings have taken over the stored
 * history, and how far below their high they sit now. Like the other risk
 * cards it describes and never advises, and it says plainly that it applies
 * today's holdings to past prices.
 */
export function DrawdownCard({ drawdown, isLoading }: { drawdown: Drawdown; isLoading: boolean }) {
  const { worst, fromHigh, observations, excludedTickers, includedValueShare } = drawdown;

  if (isLoading) {
    return <Card title="Drawdown"><p className="muted">Loading…</p></Card>;
  }

  if (fromHigh == null) {
    return (
      <Card title="Drawdown">
        <EmptyState
          title="Not enough price history yet"
          body={`This needs about a year of daily closes shared by your holdings. There ${observations === 1 ? "is" : "are"} ${observations} days so far — they fill in as prices are downloaded.`}
        />
      </Card>
    );
  }

  const atHigh = fromHigh.fall === 0;

  return (
    <Card title="Drawdown" subtitle={`${observations} trading days of history`}>
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Worst fall</div>
          {worst ? (
            <>
              <div className="stat-value neg">{pct(worst.fall * 100)}</div>
              <div className="cell-secondary">
                {`${fmtDate(worst.peakDate)} → ${fmtDate(worst.troughDate)} · ${worst.recoveredDate ? `recovered ${fmtDate(worst.recoveredDate)}` : "not yet recovered"}`}
              </div>
            </>
          ) : (
            <>
              <div className="stat-value">None</div>
              <div className="cell-secondary">never below an earlier high</div>
            </>
          )}
        </div>
        <div className="stat">
          <div className="stat-label">Below the high</div>
          {atHigh ? (
            <>
              <div className="stat-value pos">At the high</div>
              <div className="cell-secondary">{`set ${fmtDate(fromHigh.highDate)}`}</div>
            </>
          ) : (
            <>
              <div className="stat-value neg">{pct(fromHigh.fall * 100)}</div>
              <div className="cell-secondary">{`${money(fromHigh.below)} below the high on ${fmtDate(fromHigh.highDate)}`}</div>
            </>
          )}
        </div>
      </div>

      {excludedTickers.length > 0 && (
        <p className="muted">
          {`${excludedTickers.length} holding${excludedTickers.length === 1 ? "" : "s"} left out for want of price history: ${excludedTickers.join(", ")}. The figures cover ${share(includedValueShare)} of your holdings.`}
        </p>
      )}

      <p className="muted" style={{ marginBottom: 0 }}>
        Measured by valuing the holdings you hold today at each day's closing prices, cash
        left out — not a record of what the account actually did, and not a forecast.
      </p>
    </Card>
  );
}
