import type { Goal } from "./types";
import { daysBetween, monthsUntil } from "./dates";

export type SavedSource = "account" | "manual" | "missing-account" | "not-followable";

/**
 * How much a goal has saved.
 *
 * A goal following an account reads that account's value — cash plus
 * holdings, from `derivePortfolio` — so it moves with every sync without the
 * owner touching it. An overdrawn account counts as nothing saved rather than
 * as negative progress. A followable account (visible, and not a credit card)
 * with no value yet (a new, empty one has no entry in the map) is nothing
 * saved, from the account. A followed account that cannot be read falls back
 * to the amount last kept by hand and says why, because a bar dropping to zero
 * reads as lost money: "missing-account" when it is hidden, since hidden
 * accounts are left out of every figure, and "not-followable" when it is still
 * visible but has since become a credit card, whose balance is a debt.
 */
export function savedFor(
  goal: Goal,
  accountValues: Map<number, number>,
  followableAccountIds: ReadonlySet<number>,
  visibleAccountIds: ReadonlySet<number>,
): { saved: number; source: SavedSource } {
  if (goal.account_id == null) return { saved: goal.saved_amount, source: "manual" };
  if (!followableAccountIds.has(goal.account_id)) {
    const source = visibleAccountIds.has(goal.account_id) ? "not-followable" : "missing-account";
    return { saved: goal.saved_amount, source };
  }
  const value = accountValues.get(goal.account_id) ?? 0;
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
  /** What to set aside each month to make the date; null with no date, once done, or once overdue. */
  perMonth: number | null;
  /** The date has passed and the target has not been reached. */
  overdue: boolean;
}

const cents = (x: number) => Math.round(x * 100);

/** Where a goal stands on `today` (the local date, `YYYY-MM-DD`) with `saved` put by. */
export function goalProgress(goal: Goal, saved: number, today: string): GoalProgress {
  const target = goal.target_amount;
  // Compared in cents: 1999.999 saved towards 2000 is reached, not $0.00 short.
  const left = cents(target) - cents(saved);
  const done = left <= 0;
  const remaining = done ? 0 : left / 100;
  // A target of nothing has no bar to fill, whatever has been saved.
  const fraction = target > 0 ? (done ? 1 : Math.min(1, Math.max(0, saved / target))) : 0;
  if (goal.target_date == null) {
    return { saved, target, remaining, fraction, done, monthsLeft: null, perMonth: null, overdue: false };
  }
  const overdue = daysBetween(today, goal.target_date) < 0 && !done;
  const monthsLeft = Math.max(0, monthsUntil(today, goal.target_date));
  return {
    saved, target, remaining, fraction, done, monthsLeft,
    // At least one month: on the day itself, what is left is due now. Once
    // the date has passed there is no month left to spread it over.
    perMonth: done || overdue ? null : remaining / Math.max(1, monthsLeft),
    overdue,
  };
}
