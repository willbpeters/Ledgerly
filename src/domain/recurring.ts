import type { BankTransaction, Category } from "./types";

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
  return t.payee?.trim() || t.description.trim();
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
    const kind = t.category_id == null ? null : kindOf.get(t.category_id);
    if (kind === "transfer" || kind === "income") continue;
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
  return found.sort((a, b) => a.nextDate.localeCompare(b.nextDate) || a.name.localeCompare(b.name));
}

function seriesFrom(key: string, rows: BankTransaction[], today: string): RecurringSeries | null {
  const sorted = [...rows].sort((a, b) => a.posted.localeCompare(b.posted) || a.id - b.id);
  // A second charge on the same day (a retry, two lines of one order) is one bill.
  const charges: BankTransaction[] = [];
  for (const t of sorted) {
    if (charges.length === 0 || charges[charges.length - 1].posted !== t.posted) charges.push(t);
  }
  if (charges.length < MIN_CHARGES) return null;

  const gaps = charges.slice(1).map((t, i) => daysBetween(charges[i].posted, t.posted));
  const rule = cadenceFor(median(gaps));
  if (!rule) return null;
  // The median alone would accept wild gaps either side of one good one.
  const fitting = gaps.filter((g) => g >= rule.min && g <= rule.max).length;
  if (fitting < gaps.length * STEADY_SHARE) return null;

  const amounts = charges.map((t) => -t.amount);
  const typical = median(amounts);
  const slack = Math.max(typical * AMOUNT_SLACK, AMOUNT_FLOOR);
  const steady = amounts.filter((a) => Math.abs(a - typical) <= slack).length;
  if (steady < amounts.length * STEADY_SHARE) return null;

  const last = charges[charges.length - 1];
  const nextDate = stepDate(last.posted, rule.cadence);
  return {
    key,
    name: displayName(last),
    cadence: rule.cadence,
    // The last three, so a price rise shows the new price.
    amount: median(amounts.slice(-3)),
    charges: charges.map((t) => ({ date: t.posted, amount: -t.amount })),
    lastDate: last.posted,
    nextDate,
    count: charges.length,
    categoryId: last.category_id,
    accountId: last.account_id,
    active: today <= addDays(nextDate, rule.grace),
    transactionIds: sorted.map((t) => t.id),
  };
}
