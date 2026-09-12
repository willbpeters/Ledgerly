import { useMemo } from "react";
import { usePriceHistoryRows, useIndexHistory } from "./queries";
import { alignedReturns, type PriceRow, type Aligned } from "../domain/returns";
import type { Holding } from "../domain/types";

/**
 * How far back the risk figures reach. Two years, matching the `HISTORY_RANGE`
 * the Rust side backfills — long enough for beta to settle down, short enough
 * that it still describes roughly the portfolio you have.
 */
export const RISK_YEARS = 2;

function isoYearsAgo(years: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * The aligned daily return series the risk maths runs on: every holding's
 * history and the benchmark's, on one shared calendar.
 *
 * A thin wrapper on purpose. The alignment rules — which dates survive, which
 * holdings are excluded and why — live in `domain/returns.ts` where they can
 * be unit-tested, exactly as `useValueSeries` wraps `reconstructSeries`.
 */
export function useRiskSeries(holdings: Holding[]): { aligned: Aligned; isLoading: boolean } {
  const from = isoYearsAgo(RISK_YEARS);

  const { data: rows = [], isLoading: l1 } = usePriceHistoryRows(from);
  const { data: index = [], isLoading: l2 } = useIndexHistory();

  const aligned = useMemo(() => {
    const prices: PriceRow[] = rows.map(([security_id, date, close]) => ({ security_id, date, close }));
    const benchmark = index
      .map(([date, close]) => ({ date, close }))
      .filter((b) => b.date >= from);
    return alignedReturns({ holdings, prices, benchmark });
  }, [holdings, rows, index, from]);

  return { aligned, isLoading: l1 || l2 };
}
