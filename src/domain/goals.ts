import type { Goal } from "./types";

export type SavedSource = "account" | "manual" | "missing-account";

/**
 * How much a goal has saved.
 *
 * A goal following an account reads that account's value — cash plus
 * holdings, from `derivePortfolio` — so it moves with every sync without the
 * owner touching it. An overdrawn account counts as nothing saved rather than
 * as negative progress. A hidden account has no value in the map (hidden
 * accounts are left out of every figure); the goal then falls back to the
 * amount last kept by hand and says so, because a bar dropping to zero reads
 * as lost money.
 */
export function savedFor(goal: Goal, accountValues: Map<number, number>): { saved: number; source: SavedSource } {
  if (goal.account_id == null) return { saved: goal.saved_amount, source: "manual" };
  const value = accountValues.get(goal.account_id);
  if (value == null) return { saved: goal.saved_amount, source: "missing-account" };
  return { saved: Math.max(0, value), source: "account" };
}

export interface GoalProgress {
  saved: number;
  target: number;
  /** Still to save; never below zero. */
  remaining: number;
  /** 0..1, for the bar. */
  fraction: number;
  done: boolean;
  /** Months until the date, rounded up; null for a goal with no date. */
  monthsLeft: number | null;
  /** What to set aside each month to make the date; null with no date, or once done. */
  perMonth: number | null;
  /** The date has passed and the target has not been reached. */
  overdue: boolean;
}

/** The average month across the Gregorian calendar's 400-year cycle. */
const DAYS_PER_MONTH = 30.4375;

/** Whole days from one `YYYY-MM-DD` to another. UTC, so a clock change never moves it. */
function daysBetween(from: string, to: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

const cents = (x: number) => Math.round(x * 100);

/** Where a goal stands on `today` (the local date, `YYYY-MM-DD`) with `saved` put by. */
export function goalProgress(goal: Goal, saved: number, today: string): GoalProgress {
  const target = goal.target_amount;
  // Compared in cents: 1999.999 saved towards 2000 is reached, not $0.00 short.
  const done = cents(saved) >= cents(target);
  const remaining = done ? 0 : target - saved;
  const fraction = done ? 1 : target > 0 ? Math.min(1, Math.max(0, saved / target)) : 0;
  if (goal.target_date == null) {
    return { saved, target, remaining, fraction, done, monthsLeft: null, perMonth: null, overdue: false };
  }
  const days = daysBetween(today, goal.target_date);
  const monthsLeft = Math.max(0, Math.ceil(days / DAYS_PER_MONTH));
  return {
    saved, target, remaining, fraction, done, monthsLeft,
    // At least one month: on the day itself, what is left is due now.
    perMonth: done ? null : remaining / Math.max(1, monthsLeft),
    overdue: days < 0 && !done,
  };
}
