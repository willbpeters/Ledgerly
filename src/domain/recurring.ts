import type { BankTransaction } from "./types";

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
  return t.payee?.trim() || t.description;
}

/**
 * What ties one bill's charges together. Runs of three or more digits are
 * store numbers, dates and references that change from charge to charge; a
 * lone digit is usually part of the name (7-Eleven), so it stays.
 */
export function recurringKey(t: Pick<BankTransaction, "payee" | "description">): string {
  return displayName(t).toLowerCase().replace(/\d{3,}/g, "").replace(/\s+/g, " ").trim();
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
