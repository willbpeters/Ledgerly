/**
 * Ordinary least squares and the summary statistics it needs.
 *
 * The logic here is pure statistics with no finance in it and no imports at
 * all: it knows about `xs` and `ys`, so every answer can be checked against a
 * textbook. The comments do name what each quantity becomes in the caller —
 * slope is beta, intercept is alpha — because that mapping is the whole reason
 * this module exists and hiding it would help nobody. What must not appear
 * here is finance *logic* or a dependency on the finance layer.
 *
 * Everything returns `null` when there is not enough data to answer, never 0
 * and never NaN — see the note at the top of `risk.ts` for why that matters
 * here more than in most codebases. That includes non-finite results: a NaN
 * or Infinity anywhere in the input is caught and turned into `null` rather
 * than being allowed to propagate out as a number-shaped nothing.
 *
 * Variance and standard deviation use the sample convention (divide by n-1).
 * Beta is a ratio of two of these, so the convention cancels; volatility is
 * not, and the sample form is the standard one to report.
 */

/**
 * Whether every value is a real, finite number.
 *
 * A single NaN or Infinity in the input propagates silently through every
 * formula below and comes out the far end as a number-shaped nothing. That
 * matters here because these results are rendered as percentages on a finance
 * dashboard, where "NaN%" is the worst available outcome.
 *
 * The series builder that feeds this module drops unusable closes at the
 * source. This is a second line of defence, not a duplicate of that one:
 * neither should be removed on the grounds that the other exists.
 */
function allFinite(xs: number[]): boolean {
  return xs.every(Number.isFinite);
}

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
  if (!allFinite(xs)) return null;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

export function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  if (!allFinite(xs)) return null;
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
  if (!allFinite(xs) || !allFinite(ys)) return null;
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
  if (!allFinite(xs) || !allFinite(ys)) return null;

  const vx = variance(xs)!;

  // Exact equality is not enough. `xs` arrives as computed values, so a series
  // that is flat in reality can still carry floating-point residue and produce
  // a variance around 1e-34. Dividing by that yields a slope in the hundreds of
  // thousands — finite, so the guard below would pass it, and meaningless. Judge
  // flatness relative to the scale of the data instead.
  const scale = xs.reduce((max, x) => Math.max(max, Math.abs(x)), 0);
  if (!(vx > 0) || Math.sqrt(vx) <= Number.EPSILON * scale) return null;

  const cov = covariance(xs, ys)!;
  const slope = cov / vx;
  const intercept = mean(ys)! - slope * mean(xs)!;

  const vy = variance(ys)!;
  // Cauchy-Schwarz bounds this at 1 in exact arithmetic, but cov, vx and vy are
  // three separate summations, so rounding can nudge it just past. The UI prints
  // this as a percentage and 100.0000001% would be an obvious wrong.
  const r2 = vy === 0 ? 0 : Math.min(1, (cov * cov) / (vx * vy));

  if (!Number.isFinite(slope) || !Number.isFinite(intercept) || !Number.isFinite(r2)) return null;

  return { slope, intercept, r2 };
}
