import type { BankTransaction, Category } from "./types";
import { piecesOf } from "./splits";
import { monthWindow } from "./spending";

/**
 * Recurring bills and subscriptions, spotted from history. Everything here is
 * pure: the caller decides which transactions are eligible to look at (hidden
 * and investment accounts are already gone), and Rust only remembers which
 * keys the owner dismissed.
 */

export type Cadence = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly";

interface CadenceRule {
  cadence: Cadence;
  label: string;
  /** The gaps, in days, that count as this cadence. */
  min: number;
  max: number;
  /** How a next date is found: a fixed number of days, or calendar months. */
  days?: number;
  months?: number;
  /** Days past the expected date before a bill counts as no longer seen. */
  grace: number;
}

const CADENCES: CadenceRule[] = [
  { cadence: "weekly", label: "Weekly", min: 6, max: 8, days: 7, grace: 3 },
  { cadence: "biweekly", label: "Every two weeks", min: 13, max: 16, days: 14, grace: 5 },
  { cadence: "monthly", label: "Monthly", min: 27, max: 33, months: 1, grace: 10 },
  { cadence: "quarterly", label: "Every three months", min: 84, max: 98, months: 3, grace: 20 },
  { cadence: "yearly", label: "Yearly", min: 350, max: 380, months: 12, grace: 30 },
];

function ruleFor(cadence: Cadence): CadenceRule {
  return CADENCES.find((r) => r.cadence === cadence)!;
}

export function cadenceLabel(cadence: Cadence): string {
  return ruleFor(cadence).label;
}

/** The name a person would recognise: the payee, or the description without one. */
export function displayName(t: Pick<BankTransaction, "payee" | "description">): string {
  // The same test recurringKey applies, so a name and its key never disagree.
  const payee = t.payee?.trim() ?? "";
  return normalise(payee) ? payee : t.description.trim();
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\d{3,}/g, "").replace(/\s+/g, " ").trim();
}

/**
 * What ties one bill's charges together. Runs of three or more digits are
 * store numbers, dates and references that change from charge to charge; a
 * lone digit is usually part of the name (7-Eleven), so it stays. A payee that
 * is nothing but such digits is no name at all, so the description is used.
 * Empty when neither leaves anything: such a row cannot be grouped.
 */
export function recurringKey(t: Pick<BankTransaction, "payee" | "description">): string {
  return normalise(t.payee ?? "") || normalise(t.description);
}

/** UTC throughout: shifting an ISO date by whole days must not cross a time zone. */
function addDays(date: string, by: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

function addMonths(date: string, by: number): string {
  const [y, m, day] = date.split("-").map(Number);
  // Day 0 of the month after the target is the target's last day.
  const last = new Date(Date.UTC(y, m - 1 + by + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(y, m - 1 + by, Math.min(day, last)));
  return d.toISOString().slice(0, 10);
}

/**
 * `times` steps on from `date`. Always counted from `date` itself, so a bill
 * on the 31st is expected on the 31st again after a short month, not the 28th
 * for ever after.
 */
export function stepDate(date: string, cadence: Cadence, times = 1): string {
  const rule = ruleFor(cadence);
  return rule.days != null ? addDays(date, rule.days * times) : addMonths(date, rule.months! * times);
}

export interface RecurringSeries {
  key: string;
  /** The latest charge's payee, or its description. */
  name: string;
  cadence: Cadence;
  /** A typical charge, as a positive number: the median of the last three. */
  amount: number;
  /** Every charge, oldest first, as positive amounts; same-day duplicates once. */
  charges: { date: string; amount: number }[];
  lastDate: string;
  nextDate: string;
  /** Charges seen, with same-day duplicates counted once. */
  count: number;
  categoryId: number | null;
  accountId: number;
  /** False once the next date is past by more than the cadence's grace: probably cancelled. */
  active: boolean;
  /** Every row behind the series, duplicates included. */
  transactionIds: number[];
}

/** Two charges are a coincidence; three at a steady rhythm are a bill. */
const MIN_CHARGES = 3;
/** The share of gaps, and of amounts, that must fit. One stray in four is forgiven. */
const STEADY_SHARE = 0.75;
/** How far an amount may stray from the median: a quarter, or $2 on a small bill. */
const AMOUNT_SLACK = 0.25;
const AMOUNT_FLOOR = 2;
/**
 * How many of the latest charges the amount is judged on. A price rise settles
 * in within half a year, however long the history: judging every charge would
 * count the old price against a bill for years after the rise.
 */
const RECENT_CHARGES = 6;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function cadenceFor(gap: number): CadenceRule | null {
  return CADENCES.find((r) => gap >= r.min && gap <= r.max) ?? null;
}

/**
 * Every bill and subscription in `txns`, soonest next charge first.
 *
 * Only money out is looked at: paychecks and refunds are not bills, and a
 * row filed as a transfer (a card payment) or as income is not one either.
 * Uncategorised rows are kept, because a new subscription usually arrives
 * without a category. A split transaction counts as one whole charge.
 */
export function detectRecurring(
  txns: BankTransaction[],
  categories: Category[],
  today: string,
  dismissed: Iterable<string> = [],
): RecurringSeries[] {
  const kindOf = new Map(categories.map((c) => [c.id, c.kind]));
  const skip = new Set(dismissed);
  const groups = new Map<string, BankTransaction[]>();
  for (const t of txns) {
    if (t.amount >= 0 || t.pending || t.removed) continue;
    // A split is a bill unless every piece is a transfer or income.
    const notABill = (p: { category_id: number | null }) => {
      const kind = p.category_id == null ? null : kindOf.get(p.category_id);
      return kind === "transfer" || kind === "income";
    };
    if (piecesOf(t).every(notABill)) continue;
    const key = recurringKey(t);
    if (key === "" || skip.has(key)) continue;
    const group = groups.get(key);
    if (group) group.push(t);
    else groups.set(key, [t]);
  }

  const found: RecurringSeries[] = [];
  for (const [key, rows] of groups) {
    const series = seriesFrom(key, rows, today);
    if (series) found.push(series);
  }
  return found.sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

function seriesFrom(key: string, rows: BankTransaction[], today: string): RecurringSeries | null {
  const sorted = [...rows].sort((a, b) => a.posted.localeCompare(b.posted) || a.id - b.id);
  // Rows on the same day (a retry, two lines of one order) are one charge made
  // of several lines: their amounts add up, and every row stays in `rows`.
  const charges: { date: string; cents: number; rows: BankTransaction[] }[] = [];
  for (const t of sorted) {
    const cents = Math.round(-t.amount * 100);
    const prev = charges[charges.length - 1];
    if (prev && prev.date === t.posted) {
      prev.cents += cents;
      prev.rows.push(t);
    } else {
      charges.push({ date: t.posted, cents, rows: [t] });
    }
  }
  if (charges.length < MIN_CHARGES) return null;

  const gaps = charges.slice(1).map((c, i) => daysBetween(charges[i].date, c.date));
  const rule = cadenceFor(median(gaps));
  if (!rule) return null;
  // The median alone would accept wild gaps either side of one good one.
  const fitting = gaps.filter((g) => g >= rule.min && g <= rule.max).length;
  if (fitting < gaps.length * STEADY_SHARE) return null;

  const amounts = charges.map((c) => c.cents / 100);
  const recent = amounts.slice(-RECENT_CHARGES);
  const typical = median(recent);
  const slack = Math.max(typical * AMOUNT_SLACK, AMOUNT_FLOOR);
  const steady = recent.filter((a) => Math.abs(a - typical) <= slack).length;
  if (steady < recent.length * STEADY_SHARE) return null;

  const last = charges[charges.length - 1];
  const first = last.rows[0];
  const nextDate = stepDate(last.date, rule.cadence);
  // A split charge is filed under its largest piece.
  const largest = last.rows.flatMap(piecesOf).reduce((best, p) => (Math.abs(p.amount) > Math.abs(best.amount) ? p : best));
  return {
    key,
    name: displayName(first),
    cadence: rule.cadence,
    // The last three, so a price rise shows the new price.
    amount: median(amounts.slice(-3)),
    charges: charges.map((c, i) => ({ date: c.date, amount: amounts[i] })),
    lastDate: last.date,
    nextDate,
    count: charges.length,
    categoryId: largest.category_id,
    accountId: first.account_id,
    active: today <= addDays(nextDate, rule.grace),
    transactionIds: sorted.map((t) => t.id),
  };
}

export type RecurringStatus =
  | { kind: "paid" }
  | { kind: "due"; date: string }
  | { kind: "late"; since: string };

/**
 * Where one bill stands today. Late wins: a weekly bill paid last Monday but
 * missing this Monday is late, not paid. Paid only when nothing more is
 * expected this month.
 */
export function statusOf(s: RecurringSeries, today: string): RecurringStatus {
  if (s.nextDate < today) return { kind: "late", since: s.nextDate };
  const { from, to } = monthWindow(today.slice(0, 7));
  if (s.lastDate >= from && s.nextDate > to) return { kind: "paid" };
  return { kind: "due", date: s.nextDate };
}

export interface ExpectedCharge { key: string; name: string; date: string; amount: number }

export interface MonthOutlook {
  /** Charges still to come this month, a late one included, soonest first. */
  due: ExpectedCharge[];
  dueCount: number;
  dueTotal: number;
  /** Bills charged this month, and the sum of every charge they made in it. */
  paidCount: number;
  paidTotal: number;
}

/**
 * This month at a glance. Only bills still being charged count: one not seen
 * lately is probably cancelled, and counting it as due would cry wolf.
 */
export function monthOutlook(series: RecurringSeries[], today: string): MonthOutlook {
  const { from, to } = monthWindow(today.slice(0, 7));
  const due: ExpectedCharge[] = [];
  let paidCount = 0;
  let paidTotal = 0;
  for (const s of series) {
    if (!s.active) continue;
    if (s.lastDate >= from && s.lastDate <= to) {
      paidCount += 1;
      // Every charge in the month: a weekly bill may already have made three.
      for (const c of s.charges) if (c.date >= from && c.date <= to) paidTotal += c.amount;
    }
    // Every expected date after the last charge that lands in this month.
    for (let k = 1; ; k++) {
      const date = stepDate(s.lastDate, s.cadence, k);
      if (date > to) break;
      if (date >= from) due.push({ key: s.key, name: s.name, date, amount: s.amount });
    }
  }
  due.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    due,
    dueCount: due.length,
    dueTotal: due.reduce((sum, d) => sum + d.amount, 0),
    paidCount,
    paidTotal,
  };
}

/**
 * A name for each dismissed key, for the Dismissed list. A key is lowercased
 * and stripped of numbers, so the latest charge's own name reads better; a key
 * with no charge left (its account was removed) shows as itself.
 */
export function namesForKeys(txns: BankTransaction[], keys: string[]): { key: string; name: string }[] {
  const wanted = new Set(keys);
  const latest = new Map<string, BankTransaction>();
  for (const t of txns) {
    const key = recurringKey(t);
    if (!wanted.has(key)) continue;
    const seen = latest.get(key);
    if (seen == null || t.posted > seen.posted) latest.set(key, t);
  }
  return keys
    .map((key) => {
      const t = latest.get(key);
      return { key, name: t ? displayName(t) : key };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
