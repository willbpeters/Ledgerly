import type { Holding } from "./types";
import { fit, stdev } from "./regression";

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

/**
 * Trading days in a year. Daily figures are multiplied by this (for a mean,
 * like alpha) or by its square root (for a deviation, like volatility) to get
 * the annual figures people actually quote.
 */
export const TRADING_DAYS = 252;

/**
 * How many daily observations a figure needs before it is worth reporting.
 * Below this, beta and volatility are noise wearing a number's clothes.
 *
 * This lives here rather than in the data layer because it is a statement
 * about the maths, not about downloading. `data/priceHistory.ts` re-exports it
 * so there is one threshold in the codebase and not two.
 */
export const MIN_HISTORY_DAYS = 200;

/** One thing the portfolio holds, with its own daily return series. */
export interface ExposureAsset {
  securityId: number;
  ticker: string;
  /** Market value today, in dollars. */
  value: number;
  /** Daily returns aligned to the benchmark, or null when there are none. */
  returns: number[] | null;
}

export interface ExposureInputs {
  assets: ExposureAsset[];
  /** Cash, which enters the series at a return of 0. */
  cash: number;
  /** The benchmark's daily returns. */
  benchmark: number[];
}

export interface MarketExposure {
  /** Jensen's alpha, annualised. Null when it cannot be computed honestly. */
  alpha: number | null;
  /** Sensitivity to the benchmark. 1.0 is "moves with the market". */
  beta: number | null;
  /** Share of the portfolio's movement the benchmark explains, 0..1. */
  r2: number | null;
  /** Annualised standard deviation of the portfolio's daily returns. */
  volatility: number | null;
  /** Daily observations the figures rest on. */
  observations: number;
  /** Assets that made it into the maths. */
  includedCount: number;
  /**
   * Holdings the owner has whose history was unusable, named so the UI can say
   * so. A holding worth nothing is not listed here — it is not an exposure we
   * failed to measure, it is not an exposure.
   */
  excludedTickers: string[];
}

/**
 * Market exposure: how much of the portfolio's behaviour is the market, and
 * what is left over once that is accounted for.
 *
 * The portfolio's return series is today's weights applied to each asset's
 * historical returns — the app cannot know what was held two years ago, so
 * this answers "how would what I hold now have behaved", and the UI must say
 * so. Weighting and *then* regressing also captures the correlation between
 * holdings for free; averaging each holding's own beta would ignore it and
 * overstate risk.
 *
 * The risk-free rate is treated as zero. Textbook Jensen's alpha subtracts it
 * from both sides; the app has no rate source, and at daily granularity the
 * omission moves annualised alpha by well under a point. Deliberate, not an
 * oversight.
 *
 * Cash enters at a return of 0 and so dilutes exposure, which is correct.
 * Assets the owner holds but with no usable history are dropped and named:
 * the remaining weights are renormalised over what is left, because silently
 * treating an unknown holding as cash-like would understate exposure. Assets
 * worth nothing today are dropped silently instead — a fully-sold position is
 * not an exposure we failed to measure, so naming it here would be wrong.
 */
export function marketExposure(i: ExposureInputs): MarketExposure {
  const usable = i.assets.filter(
    (a) => a.returns !== null && a.returns.length === i.benchmark.length && a.value > 0,
  );
  // Only name what the owner actually holds and we could not measure. A
  // position worth nothing is not an exposure we failed to compute — it is not
  // an exposure at all, and `concentration()` above drops those silently too.
  const excludedTickers = i.assets
    .filter((a) => a.value > 0 && !usable.includes(a))
    .map((a) => a.ticker);

  const cash = Math.max(i.cash, 0);
  const base = usable.reduce((sum, a) => sum + a.value, 0) + cash;

  const observations = i.benchmark.length;
  const nothing: MarketExposure = {
    alpha: null, beta: null, r2: null, volatility: null,
    observations, includedCount: usable.length, excludedTickers,
  };

  if (observations < MIN_HISTORY_DAYS || base <= 0) return nothing;

  // Cash contributes a return of 0 on every day, so it never appears in the
  // sum — it only enlarges `base`, which is exactly how it dilutes.
  const portfolio = Array.from({ length: observations }, (_, t) =>
    usable.reduce((sum, a) => sum + (a.value / base) * a.returns![t], 0),
  );

  const sd = stdev(portfolio);
  const annualVol = sd === null ? null : sd * Math.sqrt(TRADING_DAYS);

  // Volatility does not depend on the benchmark, so a broken benchmark takes
  // alpha, beta and R-squared with it but leaves volatility standing.
  const f = fit(i.benchmark, portfolio);
  if (f === null) return { ...nothing, volatility: annualVol };

  return {
    alpha: f.intercept * TRADING_DAYS,
    beta: f.slope,
    r2: f.r2,
    volatility: annualVol,
    observations,
    includedCount: usable.length,
    excludedTickers,
  };
}
