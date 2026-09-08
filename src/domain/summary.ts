import type { Holding, PortfolioSummary } from "./types";

export function buildSummary(
  holdings: Holding[],
  cash: number,
  previousPrices: Map<number, number>,
  liabilities: number = 0,
): PortfolioSummary {
  const investedValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const unrealized = holdings.reduce((s, h) => s + h.unrealized, 0);
  const realized = holdings.reduce((s, h) => s + h.realized, 0);

  // Day change reflects only holdings with a real previous close. For the
  // baseline (denominator) every holding contributes its prior value, falling
  // back to its current price when no previous close is known — so a holding
  // without prior data counts as "no change" on both sides and never skews the
  // percentage.
  let dayChange = 0;
  let priorInvested = 0;
  let hasPrev = false;
  for (const h of holdings) {
    const prevReal = previousPrices.get(h.security_id);
    const prev = prevReal ?? h.lastPrice;
    if (prevReal != null) {
      hasPrev = true;
      dayChange += h.shares * (h.lastPrice - prevReal);
    }
    priorInvested += h.shares * prev;
  }
  // Debts are negative, so they simply join the sum: net worth is what you own
  // minus what you owe.
  const priorTotal = priorInvested + cash + liabilities;
  const totalValue = investedValue + cash + liabilities;

  return {
    totalValue, investedValue, cash, liabilities, totalCostBasis, unrealized,
    unrealizedPct: totalCostBasis > 0 ? (unrealized / totalCostBasis) * 100 : 0,
    realized,
    dayChange: hasPrev ? dayChange : 0,
    dayChangePct: hasPrev && priorTotal > 0 ? (dayChange / priorTotal) * 100 : 0,
  };
}
