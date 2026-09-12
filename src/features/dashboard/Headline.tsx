import { money, pct } from "../../ui/format";
import type { PortfolioSummary } from "../../domain/types";

/**
 * The figures at the top of the Dashboard.
 *
 * Two groups with one meaning each. Net worth, Invested, Cash and Owed say what
 * the owner has, and Invested plus Cash minus Owed sums to the hero, so the row
 * is checkable by eye. Today and All time say how the *investments* moved,
 * which is a narrower thing than net worth — hence the labels. A deposit
 * changes the first group and must never change the second.
 *
 * Extracted from `Dashboard` so these figures can be tested by rendering props,
 * rather than mounting a screen that pulls in six data hooks and Recharts.
 */
export function Headline({ summary }: { summary: PortfolioSummary }) {
  const [dollars, cents] = money(summary.totalValue).split(".");

  return (
    <div className="headline">
      <div className="headline-figure">
        <div className="cap">Net worth</div>
        <div className="hero-value">{dollars}<span className="hero-cents">.{cents}</span></div>
      </div>
      <div className="headline-side">
        <div className="cap">Today · investments</div>
        <div className={`n ${summary.dayChange >= 0 ? "pos" : "neg"}`}>
          {summary.dayChange >= 0 ? "+" : ""}{money(summary.dayChange)} · {pct(summary.dayChangePct)}
        </div>
      </div>
      <div className="headline-side">
        <div className="cap">All time · investments</div>
        <div className={`n ${summary.unrealized >= 0 ? "pos" : "neg"}`}>
          {summary.unrealized >= 0 ? "+" : ""}{money(summary.unrealized)} · {pct(summary.unrealizedPct)}
        </div>
      </div>
      <div className="headline-side">
        <div className="cap">Invested</div>
        <div className="n">{money(summary.investedValue)}</div>
      </div>
      <div className="headline-side">
        <div className="cap">Cash</div>
        <div className="n">{money(summary.cash)}</div>
      </div>
      {summary.liabilities !== 0 && (
        <div className="headline-side">
          <div className="cap">Owed</div>
          <div className="n neg">{money(summary.liabilities)}</div>
        </div>
      )}
    </div>
  );
}
