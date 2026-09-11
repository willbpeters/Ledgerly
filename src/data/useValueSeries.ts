import { useMemo } from "react";
import {
  useAccounts, useTransactions, useSyncedHoldings, useBankTransactions, usePriceHistoryRows,
} from "./queries";
import { reconstructSeries, type PriceRow } from "../domain/history";
import type { SeriesPoint } from "../domain/types";

/**
 * How far back the value chart is rebuilt.
 *
 * Ninety days is a data limit, not a preference. SimpleFIN reports the holdings
 * you have now and keeps roughly three months of transactions, so beyond this
 * the share counts and cash balances stop being reconstructible and the line
 * would be invention rather than history.
 */
export const HISTORY_DAYS = 90;

function isoDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The portfolio's value day by day, rebuilt from holdings, prices and cash
 * movements rather than read back from the daily snapshots.
 */
export function useValueSeries(days: number = HISTORY_DAYS): { series: SeriesPoint[]; isLoading: boolean } {
  const today = new Date().toISOString().slice(0, 10);
  const from = isoDaysAgo(days);

  const { data: accounts = [], isLoading: l1 } = useAccounts();
  const { data: txns = [], isLoading: l2 } = useTransactions();
  const { data: synced = [], isLoading: l3 } = useSyncedHoldings();
  const { data: bankTxns = [], isLoading: l4 } = useBankTransactions(from, today);
  const { data: rows = [], isLoading: l5 } = usePriceHistoryRows(from);

  const series = useMemo(() => {
    const prices: PriceRow[] = rows.map(([security_id, date, close]) => ({ security_id, date, close }));
    return reconstructSeries({ accounts, txns, synced, bankTxns, prices, today, days });
  }, [accounts, txns, synced, bankTxns, rows, today, days]);

  return { series, isLoading: l1 || l2 || l3 || l4 || l5 };
}
