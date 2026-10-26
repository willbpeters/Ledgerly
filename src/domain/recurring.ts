import type { BankTransaction, Category } from "./types";
import { piecesOf } from "./splits";
import { monthWindow } from "./spending";
import { daysBetween } from "./dates";

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

/** `by` calendar months on, landing on `day` (the date's own day unless given), clamped to the month's length. */
function addMonths(date: string, by: number, day = Number(date.slice(8))): string {
  const [y, m] = date.split("-").map(Number);
  // Day 0 of the month after the target is the target's last day.
  const last = new Date(Date.UTC(y, m - 1 + by + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(y, m - 1 + by, Math.min(day, last)));
  return d.toISOString().slice(0, 10);
}

/**
 * `times` steps on from `date`. Always counted from `date` itself, never one
 * step at a time, so several steps do not drift: two months on from Jan 31 is
 * Mar 31, not Mar 28. A single step from a date that was already clamped (Feb 28)
 * cannot know the bill was on the 31st; `stepSeries` knows, from the series' own
 * recent days of the month.
 */
export function stepDate(date: string, cadence: Cadence, times = 1): string {
  const rule = ruleFor(cadence);
  return rule.days != null ? addDays(date, rule.days * times) : addMonths(date, rule.months! * times);
}

/**
 * `times` steps on from a series' last charge. For calendar-month cadences the
 * day of the month is the last charge's own day, clamped to the target month.
 * Only when that charge fell on the last day of its month (so its day may have
 * been clamped) is the largest day among the last three charges used instead: a
 * bill on the 31st that paid on Feb 28 is expected on Mar 31, not Mar 28, while
 * a billing day that moved to the 5th stays on the 5th. Weekly and fortnightly
 * bills just add days.
 */
export function stepSeries(
  s: Pick<RecurringSeries, "lastDate" | "cadence" | "charges">,
  times = 1,
): string {
  const rule = ruleFor(s.cadence);
  if (rule.days != null) return addDays(s.lastDate, rule.days * times);
  const [y, m, lastDay] = s.lastDate.split("-").map(Number);
  const endOfMonth = lastDay === new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = endOfMonth
    ? Math.max(lastDay, ...s.charges.slice(-3).map((c) => Number(c.date.slice(8))))
    : lastDay;
  return addMonths(s.lastDate, rule.months! * times, day);
}

export interface RecurringSeries {
  key: string;
  /** The latest charge's payee, or its description. */
  name: string;
  cadence: Cadence;
  /** A typical charge, as a positive number: the median of the last three. */
  amount: number;
  /**
   * Every charge, oldest first, as positive amounts; the rows of one day are
   * summed into one charge. A removed charge (the owner was paid back) is still
   * here, flagged, because the bill was charged: it counts for timing, not money.
   */
  charges: { date: string; amount: number; removed?: boolean }[];
  lastDate: string;
  nextDate: string;
  /** Charges seen, with the rows of one day counted as one. */
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
 * in within six charges, however long the history: judging every charge would
 * count the old price against a bill for years after the rise.
 */
const RECENT_CHARGES = 6;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function cadenceFor(gap: number): CadenceRule | null {
  return CADENCES.find((r) => gap >= r.min && gap <= r.max) ?? null;
}

/**
 * Whether a row could be part of a bill: money out, and not filed as a transfer
 * (a card payment) or income. A split is a bill unless every piece is one of those.
 * Uncategorised rows are kept, because a new subscription usually arrives
 * without a category. Pending and removed rows are for the caller to judge.
 */
function couldBeBill(t: BankTransaction, kindOf: Map<number, Category["kind"]>): boolean {
  if (t.amount >= 0) return false;
  const notABill = (p: { category_id: number | null }) => {
    const kind = p.category_id == null ? null : kindOf.get(p.category_id);
    return kind === "transfer" || kind === "income";
  };
  return !piecesOf(t).every(notABill);
}

/**
 * Every bill and subscription in `txns`, soonest next charge first.
 *
 * Only money out is looked at: paychecks and refunds are not bills, and a
 * row filed as a transfer or as income is not one either. A split transaction
 * counts as one whole charge. Pending rows never make or shape a bill, but a
 * pending charge newer than the last posted one is the bill's latest charge.
 * Removed rows (the owner was paid back) still count for timing: the bill was
 * charged. They do not count for money, and a series in which every charge was
 * paid back is not a bill.
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
    if (!couldBeBill(t, kindOf)) continue;
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
  return found.sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

interface Charge { date: string; amount: number; removed: boolean; rows: BankTransaction[] }

/**
 * Rows on the same day (a retry, two lines of one order) are one charge made of
 * several lines: their amounts add up, and every row stays in `rows`. Only
 * lines not removed count toward the amount; a charge with none left is removed.
 */
function chargesOf(rows: BankTransaction[]): Charge[] {
  const sorted = [...rows].sort((a, b) => a.posted.localeCompare(b.posted) || a.id - b.id);
  const days: { date: string; kept: number; all: number; keptRows: number; rows: BankTransaction[] }[] = [];
  for (const t of sorted) {
    const cents = Math.round(-t.amount * 100);
    let day = days[days.length - 1];
    if (!day || day.date !== t.posted) {
      day = { date: t.posted, kept: 0, all: 0, keptRows: 0, rows: [] };
      days.push(day);
    }
    day.all += cents;
    if (!t.removed) {
      day.kept += cents;
      day.keptRows += 1;
    }
    day.rows.push(t);
  }
  return days.map((d) => ({
    date: d.date,
    amount: (d.keptRows > 0 ? d.kept : d.all) / 100,
    removed: d.keptRows === 0,
    rows: d.rows,
  }));
}

function seriesFrom(key: string, rows: BankTransaction[], today: string): RecurringSeries | null {
  // Pending rows are not yet settled: they take no part in finding the rhythm or the amount.
  const settled = chargesOf(rows.filter((t) => !t.pending));
  if (settled.length < MIN_CHARGES) return null;

  const gaps = settled.slice(1).map((c, i) => daysBetween(settled[i].date, c.date));
  const rule = cadenceFor(median(gaps));
  if (!rule) return null;
  // The median alone would accept wild gaps either side of one good one.
  const fitting = gaps.filter((g) => g >= rule.min && g <= rule.max).length;
  if (fitting < gaps.length * STEADY_SHARE) return null;

  // A bill every charge of which was paid back is not a bill the owner pays.
  const paid = settled.filter((c) => !c.removed);
  if (paid.length === 0) return null;
  const amounts = paid.map((c) => c.amount);
  const recent = amounts.slice(-RECENT_CHARGES);
  const typical = median(recent);
  const slack = Math.max(typical * AMOUNT_SLACK, AMOUNT_FLOOR);
  const steady = recent.filter((a) => Math.abs(a - typical) <= slack).length;
  if (steady < recent.length * STEADY_SHARE) return null;

  const last = settled[settled.length - 1];
  const first = last.rows[0];
  // A pending charge newer than the last posted one is the latest charge: the bill has been paid.
  const all = [...settled, ...chargesOf(rows.filter((t) => t.pending && t.posted > last.date))];
  const charges = all.map((c) => (c.removed
    ? { date: c.date, amount: c.amount, removed: true }
    : { date: c.date, amount: c.amount }));
  const lastDate = all[all.length - 1].date;
  const nextDate = stepSeries({ lastDate, cadence: rule.cadence, charges });
  // A split charge is filed under its largest piece.
  const largest = last.rows.flatMap(piecesOf).reduce((best, p) => (Math.abs(p.amount) > Math.abs(best.amount) ? p : best));
  return {
    key,
    name: displayName(first),
    cadence: rule.cadence,
    // The last three, so a price rise shows the new price.
    amount: median(amounts.slice(-3)),
    charges,
    lastDate,
    nextDate,
    count: all.length,
    categoryId: largest.category_id,
    accountId: first.account_id,
    active: today <= addDays(nextDate, rule.grace),
    transactionIds: all.flatMap((c) => c.rows.map((t) => t.id)),
  };
}

export type RecurringStatus =
  | { kind: "paid" }
  /** Charged this month, but every charge this month was removed: the owner was paid back. */
  | { kind: "paidBack" }
  | { kind: "due"; date: string }
  | { kind: "late"; since: string };

/**
 * Days past the expected date before a bill shows as Late. Weekends and
 * posting lag mean a charge routinely lands a day or two after its date; within
 * that slack the bill is simply Due on that date.
 */
export const LATE_AFTER_DAYS = 2;

/**
 * Where one bill stands today. Late wins: a weekly bill paid last Monday but
 * missing this Monday (by more than the slack) is late, not paid. Paid only
 * when nothing more is expected this month.
 */
export function statusOf(s: RecurringSeries, today: string): RecurringStatus {
  if (today > addDays(s.nextDate, LATE_AFTER_DAYS)) return { kind: "late", since: s.nextDate };
  const { from, to } = monthWindow(today.slice(0, 7));
  if (s.lastDate >= from && s.lastDate <= to && s.nextDate > to) {
    // The same charges monthOutlook counts: a bill nobody paid for this month is not "paid".
    const thisMonth = s.charges.filter((c) => c.date >= from && c.date <= to);
    return thisMonth.length > 0 && thisMonth.every((c) => c.removed) ? { kind: "paidBack" } : { kind: "paid" };
  }
  return { kind: "due", date: s.nextDate };
}

export interface ExpectedCharge { key: string; name: string; date: string; amount: number }

export interface MonthOutlook {
  /** Charges still to come this month, a late one included, soonest first. */
  due: ExpectedCharge[];
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
  // Summed in whole cents: 0.1 + 0.2 must come to 0.3, not 0.30000000000000004.
  let paidCents = 0;
  for (const s of series) {
    if (!s.active) continue;
    if (s.lastDate >= from && s.lastDate <= to) {
      // Every charge in the month the owner paid for: a weekly bill may already have made three.
      // A bill whose only charges this month were paid back has charged nothing to report.
      const mine = s.charges.filter((c) => !c.removed && c.date >= from && c.date <= to);
      if (mine.length > 0) paidCount += 1;
      for (const c of mine) paidCents += Math.round(c.amount * 100);
    }
    // Every expected date after the last charge that lands in this month.
    for (let k = 1; ; k++) {
      const date = stepSeries(s, k);
      if (date > to) break;
      // The first expected date may fall before this month: a bill that missed it
      // is late (statusOf says so), and a late bill is still owed. `active`
      // already bounds how long ago that can be.
      if (date >= from || k === 1) due.push({ key: s.key, name: s.name, date, amount: s.amount });
    }
  }
  due.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    due,
    dueTotal: due.reduce((sum, d) => sum + Math.round(d.amount * 100), 0) / 100,
    paidCount,
    paidTotal: paidCents / 100,
  };
}

/**
 * A name for each dismissed key, for the Dismissed list. A key is lowercased
 * and stripped of runs of three or more digits, so the latest charge's own name
 * reads better; a key with no charge left (its account was removed) shows as
 * itself. Only rows detectRecurring would look at count: money out that is not
 * a transfer or income, and not pending (a removed row still counts, as it does
 * for detection).
 */
export function namesForKeys(
  txns: BankTransaction[],
  keys: string[],
  categories: Category[],
): { key: string; name: string }[] {
  const kindOf = new Map(categories.map((c) => [c.id, c.kind]));
  const wanted = new Set(keys);
  const latest = new Map<string, BankTransaction>();
  for (const t of txns) {
    if (t.pending || !couldBeBill(t, kindOf)) continue;
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
    .sort((a, b) => a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
