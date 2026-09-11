import { cashEffect } from "./cash";
import type { Account, BankTransaction, SeriesPoint, SyncedHolding, Transaction } from "./types";

/** One stored daily close. */
export interface PriceRow {
  security_id: number;
  date: string;
  close: number;
}

export interface HistoryInputs {
  accounts: Account[];
  txns: Transaction[];
  synced: SyncedHolding[];
  bankTxns: BankTransaction[];
  prices: PriceRow[];
  /** YYYY-MM-DD. */
  today: string;
  /** How many days back to reconstruct. */
  days: number;
}

/**
 * Rebuild the portfolio's value day by day from the underlying data, rather
 * than reading back the daily snapshots.
 *
 * Snapshots are written once and never revisited, so a position added and later
 * deleted leaves a permanent fossil in the chart. Deriving the series instead
 * means the chart always agrees with the data as it stands now.
 *
 * **What is real and what is assumed.** Manual accounts are exact: share counts
 * and cash both come from the transaction history. Synced cash and card
 * balances are exact too, walked backwards from today's balance through the
 * transactions that have posted since. But SimpleFIN reports only the holdings
 * you have *right now* — it carries no holdings history and no brokerage
 * transactions — so for synced brokerage accounts today's share counts are
 * assumed to have been held throughout. That assumption is why the window is
 * kept short; over 90 days it is usually fair, over two years it would be
 * fiction. The UI must say so.
 */
export function reconstructSeries(i: HistoryInputs): SeriesPoint[] {
  const accounts = i.accounts.filter((a) => !a.hidden);
  const visible = new Set(accounts.map((a) => a.id));
  const isSynced = new Set(accounts.filter((a) => a.source === "simplefin").map((a) => a.id));

  const txns = i.txns.filter((t) => visible.has(t.account_id));
  const synced = i.synced.filter((h) => visible.has(h.account_id));
  const bankTxns = i.bankTxns.filter((t) => visible.has(t.account_id));

  // Closes per security, oldest first, so a date can take the last known price.
  const closes = new Map<number, PriceRow[]>();
  for (const p of i.prices) {
    const list = closes.get(p.security_id);
    if (list) list.push(p);
    else closes.set(p.security_id, [p]);
  }
  for (const list of closes.values()) list.sort((a, b) => (a.date < b.date ? -1 : 1));

  const priceOn = (securityId: number, date: string): number | null => {
    const list = closes.get(securityId);
    if (!list) return null;
    let found: number | null = null;
    for (const row of list) {
      if (row.date > date) break;
      found = row.close;
    }
    return found;
  };

  // Securities that need a price for a date to be valuable at all.
  const heldSecurities = new Set<number>([
    ...synced.map((h) => h.security_id),
    ...txns.filter((t) => t.security_id != null && (t.type === "buy" || t.type === "sell"))
      .map((t) => t.security_id as number),
  ]);

  // Last price paid per security, for manual holdings with no market price.
  const lastPaid = new Map<number, number>();
  for (const t of [...txns].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    if (t.security_id != null && t.type === "buy") lastPaid.set(t.security_id, t.price);
  }

  const from = shiftDays(i.today, -i.days);
  const dates = [...new Set(i.prices.map((p) => p.date))]
    .filter((d) => d >= from && d <= i.today)
    .sort();

  const series: SeriesPoint[] = [];
  for (const date of dates) {
    // A holding whose price history simply starts later makes this date
    // unvaluable: a partial total would read as a dip that never happened. A
    // holding Yahoo has *never* priced is different — waiting for it would
    // blank the chart forever, so it falls back to a flat value below.
    if ([...heldSecurities].some((id) => closes.has(id) && priceOn(id, date) == null)) continue;

    let value = 0;

    // Manual holdings: shares actually held on the day, from the transactions.
    const manualShares = new Map<number, number>();
    for (const t of txns) {
      if (t.date > date || t.security_id == null) continue;
      if (t.type !== "buy" && t.type !== "sell") continue;
      const delta = t.type === "buy" ? t.quantity : -t.quantity;
      manualShares.set(t.security_id, (manualShares.get(t.security_id) ?? 0) + delta);
    }
    for (const [securityId, shares] of manualShares) {
      const close = priceOn(securityId, date);
      // With no price at all, the last price paid is the best estimate there is.
      value += shares * (close ?? lastPaid.get(securityId) ?? 0);
    }

    // Synced holdings: today's shares, valued at that day's close. When the
    // ticker has no price history at all — a money-market fund, some mutual
    // funds — the value SimpleFIN itself reported is used, held flat.
    for (const h of synced) {
      const close = priceOn(h.security_id, date);
      value += close != null ? h.shares * close : h.market_value;
    }

    // Manual cash: every cash effect up to and including the day.
    for (const t of txns) {
      if (t.date <= date && !isSynced.has(t.account_id)) value += cashEffect(t);
    }

    // Synced cash and cards: today's balance, less everything posted since.
    // A credit balance is negative, so this nets debt out of the total.
    // The balance covers the whole account, holdings included, so what the
    // holdings are worth comes off it — the loop above has already counted
    // them, and leaving it in counted every invested dollar twice.
    for (const a of accounts) {
      if (a.source !== "simplefin" || a.synced_balance == null) continue;
      const invested = synced
        .filter((h) => h.account_id === a.id)
        .reduce((sum, h) => sum + h.market_value, 0);
      const posted = bankTxns
        .filter((t) => t.account_id === a.id && t.posted > date)
        .reduce((sum, t) => sum + t.amount, 0);
      value += a.synced_balance - invested - posted;
    }

    series.push({ date, value });
  }
  return series;
}

/** Move an ISO date by whole days, in UTC so it never slips across a timezone. */
function shiftDays(date: string, by: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}
