import { cashEffect } from "./cash";
import type { AccountBreakdown } from "./portfolio";
import type { Account, AccountType, BankTransaction, Security, Transaction } from "./types";

export interface AccountGroup {
  type: AccountType;
  label: string;
  total: number;
  accounts: { account: Account; value: number }[];
}

// Named for the account type, not the chart's measures: a brokerage account's
// cash sits here under Brokerage but counts toward the Cash tab, so a group
// called "Investments" would claim a total it does not have.
const GROUPS: { type: AccountType; label: string }[] = [
  { type: "brokerage", label: "Brokerage" },
  { type: "cash", label: "Cash" },
  { type: "credit", label: "Credit cards" },
];

/** Visible accounts by type, largest first, with a total per type. */
export function accountOverview(byAccount: AccountBreakdown[]): AccountGroup[] {
  return GROUPS.map(({ type, label }) => {
    const accounts = byAccount
      .filter((b) => b.account.type === type && !b.account.hidden)
      .map((b) => ({ account: b.account, value: b.value }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return { type, label, accounts, total: accounts.reduce((s, a) => s + a.value, 0) };
  }).filter((g) => g.accounts.length > 0);
}

export interface ActivityRow {
  key: string;
  date: string;
  description: string;
  account: string;
  /** Money in is positive. */
  amount: number;
  pending: boolean;
}

export interface ActivityInputs {
  bankTxns: BankTransaction[];
  txns: Transaction[];
  accounts: Account[];
  securities: Security[];
  /** YYYY-MM-DD, local. */
  today: string;
  /** Window length, today included. */
  days: number;
}

/** First day of a `days`-long window ending today, inclusive. */
export function activityWindowStart(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

const TYPE_LABEL: Record<Transaction["type"], string> = {
  buy: "Buy", sell: "Sell", dividend: "Dividend", deposit: "Deposit",
  withdrawal: "Withdrawal", fee: "Fee", interest: "Interest",
};

function describeTxn(t: Transaction, tickerOf: Map<number, string>): string {
  const ticker = t.security_id != null ? tickerOf.get(t.security_id) : undefined;
  const label = TYPE_LABEL[t.type] ?? t.type;
  if (t.type === "buy" || t.type === "sell") {
    return [label, String(Number(t.quantity.toFixed(3))), ticker].filter(Boolean).join(" ");
  }
  return ticker && t.type === "dividend" ? `${label} ${ticker}` : label;
}

/**
 * Bank and manual investment transactions in the window, across visible
 * accounts, newest first. Investment rows carry their cash effect, so a buy
 * reads as money out, the way it does in the account.
 */
export function recentActivity(i: ActivityInputs): ActivityRow[] {
  const nameOf = new Map(i.accounts.filter((a) => !a.hidden).map((a) => [a.id, a.name]));
  const tickerOf = new Map(i.securities.map((s) => [s.id, s.ticker]));
  const from = activityWindowStart(i.today, i.days);
  const inWindow = (date: string) => date >= from && date <= i.today;

  const rows: ActivityRow[] = [];
  for (const t of i.bankTxns) {
    const account = nameOf.get(t.account_id);
    const date = t.posted.slice(0, 10);
    if (account == null || !inWindow(date)) continue;
    rows.push({ key: `b${t.id}`, date, account, amount: t.amount, pending: t.pending,
      description: t.payee?.trim() || t.description });
  }
  for (const t of i.txns) {
    const account = nameOf.get(t.account_id);
    const date = t.date.slice(0, 10);
    if (account == null || !inWindow(date)) continue;
    rows.push({ key: `t${t.id}`, date, account, amount: cashEffect(t), pending: false,
      description: describeTxn(t, tickerOf) });
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
