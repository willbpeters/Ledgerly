import type { Holding } from "./types";
import { MIN_HISTORY_DAYS, type ExposureAsset } from "./risk";

/**
 * Turning stored closes into the aligned daily return series the risk maths
 * needs. Pure and I/O-free; `data/useRiskSeries.ts` is the thin hook that
 * feeds it rows from SQLite.
 *
 * The awkward part is the calendar. Holdings, funds and the index do not all
 * trade on exactly the same days, and a missing close is never filled in from
 * the day before: a repeated close reads as a 0% day, and enough of those
 * flatten volatility and drag beta toward zero. Dates that are not complete
 * across the benchmark and every measurable holding are dropped instead.
 */

export interface PriceRow { security_id: number; date: string; close: number; }
export interface BenchmarkRow { date: string; close: number; }

export type ExclusionReason = "no history" | "short history";
export interface Exclusion { ticker: string; reason: ExclusionReason; }

export interface AlignInputs {
  holdings: Holding[];
  prices: PriceRow[];
  benchmark: BenchmarkRow[];
  /** Overridable so tests need not build 200 days of fixtures. */
  minObservations?: number;
}

export interface Aligned {
  /** The common trading calendar, oldest first, one entry per return. */
  dates: string[];
  /** The benchmark's daily returns over `dates`. */
  benchmark: number[];
  /**
   * Every holding, ready to hand to `marketExposure` — measurable ones with
   * their aligned returns, the rest with `returns: null`.
   *
   * The unmeasurable ones are deliberately passed through rather than dropped
   * here. `marketExposure` has to make the exclusion decision anyway, and
   * keeping it in one place is what lets it also report how much of the
   * portfolio's value was excluded. Dropping them here would leave that
   * function reporting full coverage of a portfolio it had only seen part of.
   */
  assets: ExposureAsset[];
  /** Why each unmeasurable holding was unmeasurable. */
  excluded: Exclusion[];
}

function toReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

export function alignedReturns(i: AlignInputs): Aligned {
  const min = i.minObservations ?? MIN_HISTORY_DAYS;
  const empty: Aligned = { dates: [], benchmark: [], assets: [], excluded: [] };

  const benchByDate = new Map(i.benchmark.map((b) => [b.date, b.close]));
  const benchDates = [...benchByDate.keys()].sort();
  if (benchDates.length < 2) return empty;

  const bySecurity = new Map<number, Map<string, number>>();
  for (const p of i.prices) {
    let m = bySecurity.get(p.security_id);
    if (!m) { m = new Map(); bySecurity.set(p.security_id, m); }
    m.set(p.date, p.close);
  }

  // A holding is measured only if its own history covers enough of the
  // benchmark's calendar. Including a three-month-old position would collapse
  // the common window to three months for every other holding too.
  const included: { holding: Holding; closes: Map<string, number> }[] = [];
  const excluded: Exclusion[] = [];

  for (const h of i.holdings) {
    const closes = bySecurity.get(h.security_id);
    const covered = closes ? benchDates.filter((d) => closes.has(d)).length : 0;
    if (!closes || covered === 0) {
      excluded.push({ ticker: h.ticker, reason: "no history" });
    } else if (covered < min + 1) {
      excluded.push({ ticker: h.ticker, reason: "short history" });
    } else {
      included.push({ holding: h, closes });
    }
  }

  const dates = benchDates.filter((d) => included.every(({ closes }) => closes.has(d)));
  if (dates.length < 2) return { ...empty, excluded };

  const measured = new Map(
    included.map(({ holding, closes }) => [
      holding.security_id,
      toReturns(dates.map((d) => closes.get(d)!)),
    ]),
  );

  return {
    dates: dates.slice(1),
    benchmark: toReturns(dates.map((d) => benchByDate.get(d)!)),
    // Every holding, measurable or not — see the note on `Aligned.assets`.
    assets: i.holdings.map((h) => ({
      securityId: h.security_id,
      ticker: h.ticker,
      value: h.marketValue,
      returns: measured.get(h.security_id) ?? null,
    })),
    excluded,
  };
}
