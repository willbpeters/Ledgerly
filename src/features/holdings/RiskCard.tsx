import { concentration } from "../../domain/risk";
import { money, share } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import type { Holding } from "../../domain/types";

/**
 * Concentration: how much of the portfolio rides on how few things.
 *
 * This card describes the portfolio. It does not judge it and does not suggest
 * changes — a number like "1.5 effective holdings" is neither good nor bad
 * without knowing what the owner is trying to do.
 */
export function RiskCard({ holdings, cash }: { holdings: Holding[]; cash: number }) {
  const c = concentration(holdings, cash);

  if (c.effectivePositions == null || c.topWeight == null || c.top5Weight == null) {
    return (
      <Card title="Concentration">
        <EmptyState
          title="Nothing invested to measure yet"
          body="Once you hold something, this shows how much of your money rides on how few positions."
        />
      </Card>
    );
  }

  const effective = c.effectivePositions.toFixed(1);

  return (
    <Card
      title="Concentration"
      subtitle={`Across ${money(c.investedValue)} invested in ${c.weights.length} ${c.weights.length === 1 ? "holding" : "holdings"}`}
    >
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Largest holding</div>
          <div className="stat-value">{share(c.topWeight)}</div>
          <div className="cell-secondary">{c.topTicker}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Top 5 combined</div>
          <div className="stat-value">{share(c.top5Weight)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Effective positions</div>
          <div className="stat-value">{effective}</div>
          <div className="cell-secondary">of {c.weights.length}</div>
        </div>
        <div className="stat">
          <div className="stat-label">In cash</div>
          <div className="stat-value">{share(c.cashShare)}</div>
        </div>
      </div>

      <p className="muted" style={{ marginBottom: 0 }}>
        Your invested value behaves like about {effective} equally-sized holdings.
        A portfolio spread evenly across {c.weights.length} would score {c.weights.length}.
      </p>
    </Card>
  );
}
