import type { Holding } from "./types";

/**
 * Risk maths. Pure, I/O-free, and deliberately descriptive: these functions
 * measure what a portfolio *is*, never what it should be.
 *
 * Anything that cannot be computed honestly returns `null` rather than 0 or
 * NaN, so the UI can say "not enough data" instead of showing a confident
 * number that means nothing.
 */

export interface Weight {
  securityId: number;
  ticker: string;
  value: number;
  /** Share of invested value, 0..1. */
  weight: number;
}

export interface Concentration {
  /** Holdings with a value, largest first. */
  weights: Weight[];
  /** Total market value of holdings, excluding cash. */
  investedValue: number;
  topTicker: string | null;
  topWeight: number | null;
  /** Combined weight of the five largest holdings. */
  top5Weight: number | null;
  /**
   * Inverse Herfindahl index, `1 / Σ(wᵢ²)`: how many equally-sized holdings
   * this portfolio behaves like. Twenty holdings where one is 80% of the value
   * has an effective count near 1.5, which a plain count of 20 hides.
   */
  effectivePositions: number | null;
  /** Cash as a share of everything held, 0..1. */
  cashShare: number;
}

/**
 * How concentrated the portfolio is. Weights are taken over holdings only —
 * "40% of what I have invested is in one stock" is what people mean — and cash
 * is reported separately, since it is not a market position.
 *
 * Credit-card debt is deliberately not netted off here: owing money does not
 * make a concentrated portfolio less concentrated.
 */
export function concentration(holdings: Holding[], cash: number): Concentration {
  const held = holdings.filter((h) => h.marketValue > 0);
  const investedValue = held.reduce((sum, h) => sum + h.marketValue, 0);
  const totalAssets = investedValue + Math.max(cash, 0);
  const cashShare = totalAssets > 0 ? Math.max(cash, 0) / totalAssets : 0;

  if (investedValue <= 0) {
    return {
      weights: [], investedValue: 0, topTicker: null, topWeight: null,
      top5Weight: null, effectivePositions: null, cashShare,
    };
  }

  const weights: Weight[] = held
    .map((h) => ({
      securityId: h.security_id, ticker: h.ticker,
      value: h.marketValue, weight: h.marketValue / investedValue,
    }))
    .sort((a, b) => b.weight - a.weight);

  const sumOfSquares = weights.reduce((sum, w) => sum + w.weight * w.weight, 0);

  return {
    weights,
    investedValue,
    topTicker: weights[0].ticker,
    topWeight: weights[0].weight,
    top5Weight: weights.slice(0, 5).reduce((sum, w) => sum + w.weight, 0),
    effectivePositions: sumOfSquares > 0 ? 1 / sumOfSquares : null,
    cashShare,
  };
}
