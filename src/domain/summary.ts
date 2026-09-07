import type { Holding, PortfolioSummary } from "./types";

export function buildSummary(
  holdings: Holding[],
  cash: number,
  previousPrices: Map<number, number>,
): PortfolioSummary {
  const investedValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const unrealized = holdings.reduce((s, h) => s + h.unrealized, 0);
  const realized = holdings.reduce((s, h) => s + h.realized, 0);

  let dayChange = 0;
  let priorInvested = 0;
  let hasPrev = false;
  for (const h of holdings) {
    const prev = previousPrices.get(h.security_id);
    if (prev == null) continue;
    hasPrev = true;
    dayChange += h.shares * (h.lastPrice - prev);
    priorInvested += h.shares * prev;
  }
  const priorTotal = priorInvested + cash;
  const totalValue = investedValue + cash;

  return {
    totalValue, investedValue, cash, totalCostBasis, unrealized,
    unrealizedPct: totalCostBasis > 0 ? (unrealized / totalCostBasis) * 100 : 0,
    realized,
    dayChange: hasPrev ? dayChange : 0,
    dayChangePct: hasPrev && priorTotal > 0 ? (dayChange / priorTotal) * 100 : 0,
  };
}
