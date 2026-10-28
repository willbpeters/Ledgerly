import { MIN_HISTORY_DAYS, type ExposureAsset } from "./risk";

/** One day of today's holdings, valued at that day's prices. */
export interface PathPoint { date: string; value: number; }

export interface Drawdown {
  /** The worst peak-to-trough fall, or null when the path never fell. */
  worst: {
    /** Negative fraction, -0.25 for a 25% fall. */
    fall: number;
    peakDate: string;
    troughDate: string;
    /** First day the old peak was matched again; null if it has not been. */
    recoveredDate: string | null;
  } | null;
  /** Where today sits against the highest point. Null when it cannot be measured. */
  fromHigh: {
    /** Zero or negative fraction. */
    fall: number;
    highDate: string;
    /** Dollars below the high, in today's holdings. */
    below: number;
  } | null;
  observations: number;
  /** Holdings with value but no usable history, named so the card can say so. */
  excludedTickers: string[];
  /** Share of the holdings' value, 0..1, that the figures cover. */
  includedValueShare: number;
}

/**
 * Today's holdings valued day by day, ending at today's value.
 *
 * Each holding is walked backwards through its own daily returns, so this is
 * buy-and-hold: the shares held today, at each day's price. A fixed-weight
 * blend of returns would quietly rebalance every day, which nobody did. The
 * first return in each series is the move *into* the first date, so it is not
 * needed — the path starts at the first date's close.
 */
export function holdingsPath(dates: string[], assets: ExposureAsset[]): PathPoint[] {
  const n = dates.length;
  const values = new Array<number>(n).fill(0);
  for (const a of assets) {
    if (a.returns == null || a.returns.length !== n || a.value <= 0) continue;
    let v = a.value;
    for (let k = n - 1; k >= 0; k--) {
      values[k] += v;
      if (k > 0) v /= 1 + a.returns[k];
    }
  }
  return dates.map((date, k) => ({ date, value: values[k] }));
}

// Below this a "fall" is floating-point noise on a flat stretch, not a fall.
const EPSILON = 1e-9;

/**
 * How far today's holdings have fallen from a high over the stored history:
 * the worst fall, and where today stands against the highest point.
 *
 * Like the other risk figures this describes what *today's* holdings would
 * have done, because the app cannot know what was held two years ago. Cash is
 * left out on purpose: the question is how far the holdings fell, and cash
 * would dilute the answer into a different question. Holdings with no usable
 * history are left out and named, with the share of value that remains.
 */
export function drawdown(
  aligned: { dates: string[]; assets: ExposureAsset[] },
  minObservations: number = MIN_HISTORY_DAYS,
): Drawdown {
  const n = aligned.dates.length;
  const held = aligned.assets.filter((a) => a.value > 0);
  const usable = held.filter((a) => a.returns != null && a.returns.length === n);
  const excludedTickers = held.filter((a) => !usable.includes(a)).map((a) => a.ticker);
  const total = held.reduce((s, a) => s + a.value, 0);
  const measured = usable.reduce((s, a) => s + a.value, 0);
  const includedValueShare = total > 0 ? measured / total : 0;

  const result: Drawdown = { worst: null, fromHigh: null, observations: n, excludedTickers, includedValueShare };
  if (n < Math.max(minObservations, 2) || measured <= 0) return result;

  const path = holdingsPath(aligned.dates, usable);

  let peak = 0;
  let worstFall = 0;
  let worstPeak = 0;
  let worstTrough = 0;
  for (let k = 0; k < n; k++) {
    if (path[k].value > path[peak].value) peak = k;
    const fall = path[k].value / path[peak].value - 1;
    if (fall < worstFall - EPSILON) {
      worstFall = fall;
      worstPeak = peak;
      worstTrough = k;
    }
  }

  if (worstFall < -EPSILON) {
    const target = path[worstPeak].value;
    const recovered = path.slice(worstTrough + 1).find((p) => p.value >= target - EPSILON * target);
    result.worst = {
      fall: worstFall,
      peakDate: path[worstPeak].date,
      troughDate: path[worstTrough].date,
      recoveredDate: recovered?.date ?? null,
    };
  }

  // `peak` now indexes the highest point of the whole path.
  const today = path[n - 1].value;
  const high = path[peak].value;
  result.fromHigh = {
    fall: peak === n - 1 ? 0 : today / high - 1,
    highDate: path[peak].date,
    below: peak === n - 1 ? 0 : high - today,
  };
  return result;
}
