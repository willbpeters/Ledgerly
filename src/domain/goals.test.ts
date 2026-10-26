import { describe, it, expect } from "vitest";
import { savedFor, goalProgress } from "./goals";
import type { Goal } from "./types";

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 1, name: "Trip", target_amount: 2000, target_date: null,
  account_id: null, saved_amount: 0, created_at: "2026-10-25T00:00:00Z", ...over,
});
const TODAY = "2026-10-25";

describe("savedFor", () => {
  it("uses the amount kept by hand when the goal follows no account", () => {
    expect(savedFor(goal({ saved_amount: 300 }), new Map())).toEqual({ saved: 300, source: "manual" });
  });

  it("uses the followed account's value", () => {
    expect(savedFor(goal({ account_id: 4, saved_amount: 300 }), new Map([[4, 1250.5]])))
      .toEqual({ saved: 1250.5, source: "account" });
  });

  it("counts an overdrawn account as nothing saved, not as going backwards", () => {
    expect(savedFor(goal({ account_id: 4 }), new Map([[4, -40]]))).toEqual({ saved: 0, source: "account" });
  });

  it("falls back to the amount kept by hand when the account is hidden", () => {
    expect(savedFor(goal({ account_id: 4, saved_amount: 300 }), new Map([[9, 5000]])))
      .toEqual({ saved: 300, source: "missing-account" });
  });
});

describe("goalProgress", () => {
  it("without a date, reports what is left and no monthly figure", () => {
    expect(goalProgress(goal(), 500, TODAY)).toEqual({
      saved: 500, target: 2000, remaining: 1500, fraction: 0.25, done: false,
      monthsLeft: null, perMonth: null, overdue: false,
    });
  });

  it("spreads what is left over the months until the date, rounding the months up", () => {
    // 25 Oct 2026 to 25 Mar 2027 is 151 days: 4.96 average months, so 5.
    const p = goalProgress(goal({ target_date: "2027-03-25" }), 500, TODAY);
    expect(p.monthsLeft).toBe(5);
    expect(p.perMonth).toBe(300);
    expect(p.overdue).toBe(false);
  });

  it("asks for all of it in one month when the date is under a month away", () => {
    const p = goalProgress(goal({ target_date: "2026-10-28" }), 500, TODAY);
    expect(p.monthsLeft).toBe(1);
    expect(p.perMonth).toBe(1500);
  });

  it("is due today, not overdue, on the target date itself", () => {
    const p = goalProgress(goal({ target_date: TODAY }), 500, TODAY);
    expect(p.monthsLeft).toBe(0);
    expect(p.perMonth).toBe(1500);
    expect(p.overdue).toBe(false);
  });

  it("is overdue once the date has passed without reaching the target", () => {
    const p = goalProgress(goal({ target_date: "2026-09-01" }), 500, TODAY);
    expect(p.overdue).toBe(true);
    expect(p.monthsLeft).toBe(0);
    expect(p.remaining).toBe(1500);
  });

  it("is done when the target is reached, to the cent, whatever the date", () => {
    const p = goalProgress(goal({ target_date: "2026-09-01" }), 1999.999, TODAY);
    expect(p).toMatchObject({ done: true, remaining: 0, fraction: 1, perMonth: null, overdue: false });
  });

  it("never shows more than a full bar or a negative amount left", () => {
    expect(goalProgress(goal(), 2600, TODAY)).toMatchObject({ remaining: 0, fraction: 1, done: true });
  });
});
