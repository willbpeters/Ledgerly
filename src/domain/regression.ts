/**
 * Ordinary least squares and the summary statistics it needs. Deliberately
 * free of any finance vocabulary: this file knows about `xs` and `ys`, not
 * about markets, so its answers can be checked against a textbook.
 *
 * Everything returns `null` when there is not enough data to answer, never 0
 * and never NaN — see the note at the top of `risk.ts` for why that matters
 * here more than in most codebases.
 *
 * Variance and standard deviation use the sample convention (divide by n-1).
 * Beta is a ratio of two of these, so the convention cancels; volatility is
 * not, and the sample form is the standard one to report.
 */

export interface Fit {
  /** Beta, when xs is the market and ys the portfolio. */
  slope: number;
  /** Alpha per period, when xs is the market and ys the portfolio. */
  intercept: number;
  /** Share of the variation in ys that xs explains, 0..1. */
  r2: number;
}

function sameLength(xs: number[], ys: number[]): void {
  if (xs.length !== ys.length) {
    throw new Error(`regression: series must be the same length (${xs.length} vs ${ys.length})`);
  }
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

export function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const ss = xs.reduce((sum, x) => sum + (x - m) * (x - m), 0);
  return ss / (xs.length - 1);
}

export function stdev(xs: number[]): number | null {
  const v = variance(xs);
  return v === null ? null : Math.sqrt(v);
}

export function covariance(xs: number[], ys: number[]): number | null {
  sameLength(xs, ys);
  if (xs.length < 2) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += (xs[i] - mx) * (ys[i] - my);
  return sum / (xs.length - 1);
}

/**
 * Regress `ys` on `xs`.
 *
 * `null` when there are fewer than two points, or when `xs` never moves —
 * there is no slope through a vertical line of points, and reporting 0 would
 * claim the two series are unrelated when the truth is that the question was
 * unanswerable.
 *
 * When `ys` never moves the fit is real: slope 0, and an R² of 0 saying that
 * `xs` explains none of a series that did nothing.
 */
export function fit(xs: number[], ys: number[]): Fit | null {
  sameLength(xs, ys);
  if (xs.length < 2) return null;

  const vx = variance(xs)!;
  if (vx === 0) return null;

  const cov = covariance(xs, ys)!;
  const slope = cov / vx;
  const intercept = mean(ys)! - slope * mean(xs)!;

  const vy = variance(ys)!;
  const r2 = vy === 0 ? 0 : (cov * cov) / (vx * vy);

  return { slope, intercept, r2 };
}
