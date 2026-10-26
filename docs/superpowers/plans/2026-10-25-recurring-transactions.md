# Recurring Bills and Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Recurring** view in Spending that spots repeating bills and subscriptions from the owner's history, shows each one's cadence, typical amount and next expected date, and says what is still due this month, with a "Not recurring" button for anything it got wrong.

**Architecture:** Detection is pure TypeScript in `src/domain/recurring.ts`, run in the UI over every visible bank transaction (loaded the way Search loads them, only while the view is open). Rust stores one thing: the keys the owner dismissed, in a new `recurring_dismissed` table (migration v10), behind three small commands in `src-tauri/src/commands/recurring.rs`. A new `RecurringPanel` renders the list; `Spending.tsx` adds the fourth Segmented option and wires the hooks.

**Tech Stack:** React 19 + TypeScript, TanStack Query, Vitest + Testing Library; Rust (Tauri 2, rusqlite) with `cargo test`.

**Order:** This is the second of three plans that land on one branch in this order: split transactions (v9) → **recurring (v10)** → goals (v11). It assumes the splits plan has landed: `TARGET_VERSION` is 9 when you start, `BankTransaction` has a `splits: TxnSplit[]` field, and `Spending.tsx` has the Month / To review / Search views. **Keep every v9 change intact** when you edit the same files.

---

## Decisions made for you

- **Only money out counts.** Paychecks and refunds are not bills. Rows filed under a *transfer* or *income* category are left out (a card payment is a transfer, not a bill). Uncategorised rows are allowed, because a new subscription often has no category yet. Pending and removed rows are left out. A split transaction counts as one whole charge.
- **A payee is a "key".** `recurringKey` lowercases the payee (or the description when there is no payee), removes runs of three or more digits (store numbers, dates, reference numbers: `SQ *BLUE BOTTLE 0423` and `SQ *BLUE BOTTLE 0517` are one key), collapses spaces and trims. A single digit survives, so `7-Eleven` stays `7-eleven`. Two charges on the same day under one key are one bill.
- **What makes a bill.** At least **3** charges; the median gap between them picks a cadence (weekly 6–8 days, every two weeks 13–16, monthly 27–33, every three months 84–98, yearly 350–380); at least **75%** of the gaps must sit in that cadence's window (so one missed month is forgiven); and at least **75%** of the charges must be within **25% or $2, whichever is larger**, of the median charge (so a price rise is forgiven, Amazon is not a bill).
- **Typical amount** is the median of the last three charges, shown as a positive number.
- **Next date** steps from the last charge: by 7 or 14 days, or by 1, 3 or 12 *calendar* months with the day clamped (a bill on Jan 31 is next expected Feb 28). Stepping several times always counts from the last charge, so the day never drifts.
- **Not seen lately.** A bill whose next date has passed by more than its grace (weekly 3 days, every two weeks 5, monthly 10, every three months 20, yearly 30) is probably cancelled. It moves into a collapsed "Not seen lately" group and leaves the month's figures.
- **This month.** "Still due" is every expected charge from active bills that falls between the 1st and the last day of this month, after each bill's last charge — a late bill still counts as due. "Paid this month" adds every charge this month from each active bill charged this month, so a weekly bill charged three times counts all three.
- **Status per bill:** *Late* when its next date is before today; otherwise *Paid this month* when it was charged this month and the next charge is next month or later; otherwise *Due <date>*.
- **Dismissing** stores the key. Detection skips dismissed keys. The Dismissed list shows the latest name seen for each key, with Restore. The key is an opaque string to Rust: only `recurringKey` makes one, so the two can never disagree about normalising.
- **No CSV export** for the dismissed list; the daily backups cover it.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/domain/recurring.ts` | Create | Keys, cadences, date stepping, detection, status, the month's outlook, names for dismissed keys. Pure. |
| `src/domain/recurring.test.ts` | Create | Vitest tests for all of the above. |
| `src-tauri/src/db.rs` | Modify | v10 migration: `recurring_dismissed` table, completeness check, `migration_pending`, test. |
| `src-tauri/src/commands/recurring.rs` | Create | `dismissed` / `dismiss` / `undismiss` on `&Connection`, wrapped by three `#[tauri::command]`s, with tests. |
| `src-tauri/src/commands/mod.rs` | Modify | `pub mod recurring;` |
| `src-tauri/src/lib.rs` | Modify | Register the three commands. |
| `src/data/api.ts` | Modify | `api.recurring.dismissed / dismiss / undismiss`. |
| `src/data/queries.ts` | Modify | `useRecurringDismissed`, `useSetRecurringDismissed`. |
| `src/features/spending/RecurringPanel.tsx` | Create | The Recurring view: stat strip, bills table, Not seen lately, Dismissed. |
| `src/features/spending/RecurringPanel.test.tsx` | Create | Component tests. |
| `src/features/spending/Spending.tsx` | Modify | Fourth view, loads every month while open, wires the hooks. |
| `docs/TODO.md`, `docs/HANDOFF.md`, `README.md` | Modify | Tick item 12; describe the feature and v10. |

No new types go in `src/domain/types.ts`: the commands return `string[]`, and the series/outlook types are domain results that live beside their maths in `recurring.ts`, the way `CategorySpend` lives in `spending.ts`.

**Commands used throughout (Git Bash, from the repo root `C:\Users\willi\Dev\Tally`):**

- One TS test file: `npx vitest run src/domain/recurring.test.ts`
- Type-check: `npx tsc --noEmit`
- All TS tests: `npm test`
- Rust: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib <filter>` (cargo is not on PATH on this machine; the `export` fixes that for the command)

---

### Task 1: Keys, cadences and date stepping

**Files:**
- Create: `src/domain/recurring.ts`
- Test: `src/domain/recurring.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/recurring.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { recurringKey, stepDate, cadenceLabel } from "./recurring";

describe("recurringKey", () => {
  it("ignores case and spacing", () => {
    expect(recurringKey({ payee: "Netflix", description: "NETFLIX.COM" })).toBe("netflix");
    expect(recurringKey({ payee: "  NETFLIX   ", description: "x" })).toBe("netflix");
  });

  it("drops store numbers and dates so one merchant is one key", () => {
    const a = recurringKey({ payee: null, description: "SQ *BLUE BOTTLE 0423" });
    const b = recurringKey({ payee: null, description: "SQ *BLUE BOTTLE 0517" });
    expect(a).toBe("sq *blue bottle");
    expect(b).toBe(a);
  });

  it("keeps a lone digit, which is often part of the name", () => {
    expect(recurringKey({ payee: "7-Eleven", description: "x" })).toBe("7-eleven");
  });

  it("falls back to the description when the payee is blank", () => {
    expect(recurringKey({ payee: "   ", description: "Spotify USA" })).toBe("spotify usa");
  });
});

describe("stepDate", () => {
  it("steps weekly and fortnightly by days, across a month end", () => {
    expect(stepDate("2026-10-28", "weekly")).toBe("2026-11-04");
    expect(stepDate("2026-10-28", "biweekly")).toBe("2026-11-11");
  });

  it("steps monthly by calendar month, clamping the day", () => {
    expect(stepDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(stepDate("2028-01-31", "monthly")).toBe("2028-02-29");
    expect(stepDate("2026-12-15", "monthly")).toBe("2027-01-15");
  });

  it("steps quarterly and yearly by 3 and 12 months", () => {
    expect(stepDate("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(stepDate("2028-02-29", "yearly")).toBe("2029-02-28");
  });

  it("counts several steps from the start, so the day never drifts", () => {
    // One step at a time would go Jan 31 → Feb 28 → Mar 28.
    expect(stepDate("2026-01-31", "monthly", 2)).toBe("2026-03-31");
    expect(stepDate("2026-10-01", "weekly", 3)).toBe("2026-10-22");
  });
});

describe("cadenceLabel", () => {
  it("names each cadence for a person", () => {
    expect(cadenceLabel("monthly")).toBe("Monthly");
    expect(cadenceLabel("biweekly")).toBe("Every two weeks");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/recurring.test.ts`
Expected: FAIL — `Failed to resolve import "./recurring"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/domain/recurring.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/recurring.test.ts`
Expected: PASS (all tests in the three `describe` blocks).

- [ ] **Step 5: Commit**

```bash
git add src/domain/recurring.ts src/domain/recurring.test.ts
git commit -m "feat(spending): keys and cadences for recurring bills

recurringKey ties one bill's charges together across store numbers and
dates, and stepDate finds the next expected charge by days or by
calendar month, never drifting off the 31st.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Detecting recurring bills

**Files:**
- Modify: `src/domain/recurring.ts`
- Test: `src/domain/recurring.test.ts`

- [ ] **Step 1: Write the failing tests**

Change the first import line of `src/domain/recurring.test.ts` to:

```ts
import { recurringKey, stepDate, cadenceLabel, detectRecurring } from "./recurring";
import type { BankTransaction, Category } from "./types";
```

and append to the end of the file:

```ts
const cats: Category[] = [
  { id: 1, name: "Subscriptions", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true },
  { id: 2, name: "Income", kind: "income", colour: "chart-2", sort: 20, is_builtin: true },
  { id: 3, name: "Transfer", kind: "transfer", colour: "chart-6", sort: 30, is_builtin: true },
];

let n = 0;
const charge = (payee: string, posted: string, amount: number, over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: ++n, account_id: 1, external_id: `e${n}`, posted, amount, description: payee.toUpperCase(),
  payee, memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: true, note: null, removed: false, splits: [], ...over,
});
/** One charge on `day` of each month listed. */
const monthly = (payee: string, day: string, months: string[], amount: number, over: Partial<BankTransaction> = {}) =>
  months.map((m) => charge(payee, `${m}-${day}`, amount, over));

const TODAY = "2026-10-20";

describe("detectRecurring", () => {
  it("finds a monthly subscription with its amount, last and next dates", () => {
    const found = detectRecurring(
      monthly("Netflix", "05", ["2026-07", "2026-08", "2026-09", "2026-10"], -15.49), cats, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: "netflix", name: "Netflix", cadence: "monthly", amount: 15.49,
      lastDate: "2026-10-05", nextDate: "2026-11-05", count: 4, categoryId: 1, accountId: 1, active: true,
    });
    expect(found[0].transactionIds).toHaveLength(4);
  });

  it("needs three charges before calling something a bill", () => {
    expect(detectRecurring(monthly("Netflix", "05", ["2026-09", "2026-10"], -15.49), cats, TODAY)).toEqual([]);
  });

  it("ignores a payee charged at irregular times", () => {
    const txns = ["2026-01-01", "2026-01-20", "2026-03-15", "2026-03-18"].map((d) => charge("Hardware Store", d, -20));
    expect(detectRecurring(txns, cats, TODAY)).toEqual([]);
  });

  it("ignores a payee whose amounts jump around", () => {
    const txns = [
      charge("Amazon", "2026-06-02", -12), charge("Amazon", "2026-07-02", -250),
      charge("Amazon", "2026-08-02", -40), charge("Amazon", "2026-09-02", -8),
    ];
    expect(detectRecurring(txns, cats, TODAY)).toEqual([]);
  });

  it("forgives one missed month", () => {
    const found = detectRecurring(
      monthly("Gym", "05", ["2026-03", "2026-04", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"], -40), cats, TODAY);
    expect(found.map((s) => s.cadence)).toEqual(["monthly"]);
  });

  it("forgives a price rise and quotes the recent price", () => {
    const txns = [
      ...monthly("Spotify", "12", ["2026-06", "2026-07"], -11.99),
      ...monthly("Spotify", "12", ["2026-08", "2026-09", "2026-10"], -12.99),
    ];
    expect(detectRecurring(txns, cats, TODAY)[0].amount).toBe(12.99);
  });

  it("allows a couple of dollars either way on a small bill", () => {
    const txns = [charge("Parking", "2026-08-01", -3), charge("Parking", "2026-09-01", -4.5), charge("Parking", "2026-10-01", -3.5)];
    expect(detectRecurring(txns, cats, TODAY)).toHaveLength(1);
  });

  it("tells the cadences apart", () => {
    const weekly = ["2026-09-22", "2026-09-29", "2026-10-06", "2026-10-13"].map((d) => charge("Meal Kit", d, -60));
    const biweekly = ["2026-08-25", "2026-09-08", "2026-09-22", "2026-10-06"].map((d) => charge("Cleaner", d, -90));
    const quarterly = ["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"].map((d) => charge("Water", d, -75));
    const yearly = ["2023-11-01", "2024-11-01", "2025-11-01"].map((d) => charge("Domain", d, -20));
    const byKey = new Map(detectRecurring([...weekly, ...biweekly, ...quarterly, ...yearly], cats, TODAY)
      .map((s) => [s.key, s.cadence]));
    expect(byKey.get("meal kit")).toBe("weekly");
    expect(byKey.get("cleaner")).toBe("biweekly");
    expect(byKey.get("water")).toBe("quarterly");
    expect(byKey.get("domain")).toBe("yearly");
  });

  it("looks only at money out that is posted, kept, and not a transfer or income", () => {
    const months = ["2026-07", "2026-08", "2026-09"];
    const txns = [
      ...monthly("Payroll", "01", months, 2400, { category_id: null }),
      ...monthly("Card Payment", "02", months, -500, { category_id: 3 }),
      ...monthly("Side Gig", "03", months, -10, { category_id: 2 }),
      ...monthly("Pending Co", "04", months, -10, { pending: true }),
      ...monthly("Paid Back", "06", months, -10, { removed: true }),
      ...monthly("New Thing", "07", months, -10, { category_id: null }),
    ];
    expect(detectRecurring(txns, cats, TODAY).map((s) => s.name)).toEqual(["New Thing"]);
  });

  it("counts two charges on the same day as one bill", () => {
    const txns = [
      ...monthly("Netflix", "05", ["2026-08", "2026-09", "2026-10"], -15.49),
      charge("Netflix", "2026-10-05", -15.49),
    ];
    const [s] = detectRecurring(txns, cats, TODAY);
    expect(s.count).toBe(3);
    expect(s.transactionIds).toHaveLength(4);
  });

  it("skips a key the owner dismissed", () => {
    const txns = monthly("Netflix", "05", ["2026-08", "2026-09", "2026-10"], -15.49);
    expect(detectRecurring(txns, cats, TODAY, ["netflix"])).toEqual([]);
  });

  it("stops counting a bill as active once it is well past due", () => {
    const txns = monthly("Old Gym", "05", ["2026-04", "2026-05", "2026-06"], -40);
    // Next expected 2026-07-05, monthly grace is 10 days.
    expect(detectRecurring(txns, cats, "2026-07-15")[0].active).toBe(true);
    expect(detectRecurring(txns, cats, "2026-07-16")[0].active).toBe(false);
  });

  it("takes the name, category and account from the latest charge", () => {
    const txns = [
      ...monthly("NETFLIX", "05", ["2026-07", "2026-08"], -15.49, { category_id: null, account_id: 1 }),
      charge("Netflix", "2026-09-05", -15.49, { category_id: 1, account_id: 2 }),
    ];
    expect(detectRecurring(txns, cats, TODAY)[0]).toMatchObject({ name: "Netflix", categoryId: 1, accountId: 2 });
  });

  it("lists the soonest next charge first", () => {
    const txns = [
      ...monthly("Later", "25", ["2026-08", "2026-09", "2026-10"], -10),
      ...monthly("Sooner", "02", ["2026-08", "2026-09", "2026-10"], -10),
    ];
    expect(detectRecurring(txns, cats, TODAY).map((s) => s.name)).toEqual(["Sooner", "Later"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/recurring.test.ts`
Expected: FAIL — `detectRecurring is not a function` (or "has no exported member"). The Task 1 tests still pass.

- [ ] **Step 3: Write the implementation**

In `src/domain/recurring.ts`, change the import line at the top from

```ts
import type { BankTransaction } from "./types";
```

to

```ts
import type { BankTransaction, Category } from "./types";
```

and append to the end of the file:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/recurring.test.ts`
Expected: PASS — every test in `recurringKey`, `stepDate`, `cadenceLabel` and `detectRecurring`.

If `npx tsc --noEmit` complains that `splits` is not a property of `BankTransaction`, the splits plan has not landed yet: stop and land it first (this plan depends on it).

- [ ] **Step 5: Commit**

```bash
git add src/domain/recurring.ts src/domain/recurring.test.ts
git commit -m "feat(spending): spot recurring bills in the history

Three or more charges from one payee, at a steady weekly, fortnightly,
monthly, quarterly or yearly rhythm and a steady amount, make a bill.
One missed charge and a price rise are forgiven; transfers, income,
pending and removed rows are left out.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Status, the month's outlook, and names for dismissed keys

**Files:**
- Modify: `src/domain/recurring.ts`
- Test: `src/domain/recurring.test.ts`

- [ ] **Step 1: Write the failing tests**

Change the first import line of `src/domain/recurring.test.ts` to:

```ts
import { recurringKey, stepDate, cadenceLabel, detectRecurring, statusOf, monthOutlook, namesForKeys, type RecurringSeries } from "./recurring";
```

and append to the end of the file:

```ts
const series = (over: Partial<RecurringSeries>): RecurringSeries => ({
  key: "k", name: "Bill", cadence: "monthly", amount: 10, charges: [],
  lastDate: "2026-09-25", nextDate: "2026-10-25", count: 4, categoryId: null, accountId: 1,
  active: true, transactionIds: [], ...over,
});

describe("statusOf", () => {
  it("is due on the next date when that is still ahead", () => {
    expect(statusOf(series({}), "2026-10-20")).toEqual({ kind: "due", date: "2026-10-25" });
  });

  it("is paid when charged this month and next due after it", () => {
    expect(statusOf(series({ lastDate: "2026-10-05", nextDate: "2026-11-05" }), "2026-10-20")).toEqual({ kind: "paid" });
  });

  it("is still due when charged this month but due again before it ends", () => {
    const weekly = series({ cadence: "weekly", lastDate: "2026-10-13", nextDate: "2026-10-20" });
    expect(statusOf(weekly, "2026-10-20")).toEqual({ kind: "due", date: "2026-10-20" });
  });

  it("is late once the next date has passed", () => {
    expect(statusOf(series({ nextDate: "2026-10-15" }), "2026-10-20")).toEqual({ kind: "late", since: "2026-10-15" });
  });
});

describe("monthOutlook", () => {
  it("adds up what is still due and what was paid this month", () => {
    const o = monthOutlook([
      series({ key: "due", amount: 12, lastDate: "2026-09-25", nextDate: "2026-10-25" }),
      series({ key: "paid", amount: 15, charges: [{ date: "2026-09-05", amount: 14.99 }, { date: "2026-10-05", amount: 15.49 }],
        lastDate: "2026-10-05", nextDate: "2026-11-05" }),
    ], "2026-10-20");
    expect(o.due.map((d) => [d.key, d.date])).toEqual([["due", "2026-10-25"]]);
    expect(o.dueCount).toBe(1);
    expect(o.dueTotal).toBe(12);
    expect(o.paidCount).toBe(1);
    expect(o.paidTotal).toBe(15.49);
  });

  it("adds every charge a weekly bill already made this month to what was paid", () => {
    const o = monthOutlook([
      series({ cadence: "weekly", amount: 60, lastDate: "2026-10-13", nextDate: "2026-10-20",
        charges: [{ date: "2026-09-29", amount: 60 }, { date: "2026-10-06", amount: 60 }, { date: "2026-10-13", amount: 61 }] }),
    ], "2026-10-15");
    expect(o.paidCount).toBe(1);
    expect(o.paidTotal).toBe(121);
  });

  it("counts every charge a weekly bill still has to make this month", () => {
    const o = monthOutlook([
      series({ cadence: "weekly", amount: 60, lastDate: "2026-10-13", nextDate: "2026-10-20" }),
    ], "2026-10-20");
    expect(o.due.map((d) => d.date)).toEqual(["2026-10-20", "2026-10-27"]);
    expect(o.dueTotal).toBe(120);
  });

  it("still counts a late bill as due", () => {
    const o = monthOutlook([series({ lastDate: "2026-09-12", nextDate: "2026-10-12" })], "2026-10-20");
    expect(o.due.map((d) => d.date)).toEqual(["2026-10-12"]);
  });

  it("leaves out bills no longer seen and bills not due until next month", () => {
    const o = monthOutlook([
      series({ key: "gone", active: false }),
      series({ key: "later", lastDate: "2026-10-01", nextDate: "2026-11-01" }),
    ], "2026-10-20");
    expect(o.due).toEqual([]);
    expect(o.dueTotal).toBe(0);
  });
});

describe("namesForKeys", () => {
  it("gives each key the latest name seen, and the key itself when none is", () => {
    const txns = [
      charge("NETFLIX", "2026-08-05", -15.49),
      charge("Netflix", "2026-09-05", -15.49),
    ];
    expect(namesForKeys(txns, ["zzz gone", "netflix"])).toEqual([
      { key: "netflix", name: "Netflix" },
      { key: "zzz gone", name: "zzz gone" },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/recurring.test.ts`
Expected: FAIL — `statusOf is not a function` (and the same for `monthOutlook`, `namesForKeys`).

- [ ] **Step 3: Write the implementation**

In `src/domain/recurring.ts`, add this import below the existing one:

```ts
import { monthWindow } from "./spending";
```

and append to the end of the file:

```ts
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
```

`monthWindow` already exists in `src/domain/spending.ts` (it returns `{ from: "YYYY-MM-01", to: "YYYY-MM-<last day>" }`); `spending.ts` does not import `recurring.ts`, so there is no import cycle.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/recurring.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/domain/recurring.ts src/domain/recurring.test.ts
git commit -m "feat(spending): what is still due this month

statusOf says whether a bill is paid, due or late; monthOutlook adds up
what is still to come this month and what was already paid, leaving out
bills not seen lately. namesForKeys gives dismissed bills a readable name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: v10 migration and the dismiss commands (Rust)

**Files:**
- Modify: `src-tauri/src/db.rs`
- Create: `src-tauri/src/commands/recurring.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

Read `src-tauri/src/db.rs` first: after the splits plan it has a v9 block (`MIGRATION_9` or similar, `v9_is_complete`, `apply_v9`) and `TARGET_VERSION` is `9`. Keep all of it.

- [ ] **Step 1: Write the failing migration test**

In `src-tauri/src/db.rs`, inside `mod tests`, add this test directly above the existing `fn v8_adds_a_removed_flag_that_starts_off`:

```rust
    #[test]
    fn v10_adds_the_dismissed_bills_table_and_is_idempotent() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        // Stand in for a v9 database.
        conn.execute_batch("DROP TABLE recurring_dismissed;").unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();
        apply_migrations(&conn).unwrap();

        assert!(table_exists(&conn, "recurring_dismissed").unwrap());
        conn.execute("INSERT INTO recurring_dismissed (payee_key, dismissed_at) VALUES ('netflix','2026-10-25')", []).unwrap();
        assert!(
            conn.execute("INSERT INTO recurring_dismissed (payee_key, dismissed_at) VALUES ('netflix','2026-10-26')", []).is_err(),
            "one row per key",
        );
        assert!(!migration_pending(&conn).unwrap());
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 10);
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib v10_adds`
Expected: FAIL — `no such table: recurring_dismissed`.

- [ ] **Step 3: Add the v10 migration**

In `src-tauri/src/db.rs`:

(a) Change `const TARGET_VERSION: i64 = 9;` to:

```rust
const TARGET_VERSION: i64 = 10;
```

(b) In the doc comment above it, insert this sentence immediately before ` To add a change later:` (after whatever the v9 sentence says):

```
 v10 adds the `recurring_dismissed` table.
```

(c) Directly below `fn apply_v8(...) { ... }` and the v9 constants and functions the splits plan added (keep them), add:

```rust
/// v10: bills the owner said are not recurring. Detection is pure TypeScript;
/// this only remembers which keys to skip, as the text `recurringKey` in
/// `src/domain/recurring.ts` makes from a payee. Rust never builds a key.
const MIGRATION_10: &str = "
CREATE TABLE IF NOT EXISTS recurring_dismissed (
  payee_key TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL
);
";

fn v10_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    table_exists(conn, "recurring_dismissed")
}

/// IF NOT EXISTS, so this is safe to re-run.
fn apply_v10(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_10)
}
```

(d) In `apply_migrations`, replace the closing lines

```rust
    set_user_version(conn, TARGET_VERSION)?;
    Ok(())
}
```

with (the `if !v8_is_complete` and v9 blocks stay above, unchanged):

```rust
    if !v10_is_complete(conn)? {
        apply_v10(conn)?;
    }
    set_user_version(conn, TARGET_VERSION)?;
    Ok(())
}
```

(e) In `migration_pending`, the last condition currently ends with `)?)` — after the splits plan that is the v9 line, `|| !v9_is_complete(conn)?)`. Make v10 the last line instead, so the end reads:

```rust
        || !v8_is_complete(conn)?
        || !v9_is_complete(conn)?
        || !v10_is_complete(conn)?)
```

(Use whatever name the splits plan gave its check if it is not `v9_is_complete`.)

- [ ] **Step 4: Run the migration tests**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib db::`
Expected: PASS — the new `v10_adds_the_dismissed_bills_table_and_is_idempotent` and every existing `db::tests` test (they compare against `TARGET_VERSION`, so they follow the bump).

- [ ] **Step 5: Write the failing command tests**

Create `src-tauri/src/commands/recurring.rs`:

```rust
//! Bills the owner has said are not recurring. Spotting bills happens in
//! TypeScript (`src/domain/recurring.ts`); Rust only remembers the keys it
//! should skip, as opaque strings.
use crate::db::Db;
use rusqlite::{params, Connection};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn a_dismissed_key_is_listed_until_it_is_undismissed() {
        let conn = db::open_in_memory().unwrap();
        assert!(dismissed(&conn).unwrap().is_empty());

        dismiss(&conn, "netflix").unwrap();
        dismiss(&conn, "gym").unwrap();
        assert_eq!(dismissed(&conn).unwrap(), vec!["gym".to_string(), "netflix".to_string()]);

        undismiss(&conn, "netflix").unwrap();
        assert_eq!(dismissed(&conn).unwrap(), vec!["gym".to_string()]);
    }

    #[test]
    fn dismissing_twice_keeps_one_row() {
        let conn = db::open_in_memory().unwrap();
        dismiss(&conn, "netflix").unwrap();
        dismiss(&conn, "netflix").unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM recurring_dismissed", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn an_empty_key_is_refused() {
        let conn = db::open_in_memory().unwrap();
        assert!(dismiss(&conn, "  ").is_err());
        assert!(dismissed(&conn).unwrap().is_empty());
    }

    #[test]
    fn undismissing_a_key_that_is_not_there_is_harmless() {
        let conn = db::open_in_memory().unwrap();
        undismiss(&conn, "never-dismissed").unwrap();
    }
}
```

In `src-tauri/src/commands/mod.rs`, change

```rust
pub mod copilot;
```

to

```rust
pub mod copilot;
pub mod recurring;
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib commands::recurring`
Expected: FAIL to compile — `cannot find function 'dismissed'` (and `dismiss`, `undismiss`). There will also be unused-import warnings for `Db` and `params`; they go away in the next step.

- [ ] **Step 7: Write the commands**

In `src-tauri/src/commands/recurring.rs`, insert between the `use` lines and `#[cfg(test)]`:

```rust
/// Every dismissed key, alphabetically.
pub fn dismissed(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT payee_key FROM recurring_dismissed ORDER BY payee_key")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// Remember that `key` is not a bill. Dismissing again keeps the first date.
/// The key is stored exactly as given: it has to match what `recurringKey`
/// makes next time, so it is not trimmed or lowercased here.
pub fn dismiss(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    // An empty key would match every payee whose name is all digits.
    if key.trim().is_empty() {
        return Err(rusqlite::Error::InvalidParameterName("an empty recurring key".into()));
    }
    conn.execute(
        "INSERT INTO recurring_dismissed (payee_key, dismissed_at) VALUES (?1, ?2)
         ON CONFLICT(payee_key) DO NOTHING",
        params![key, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// Put a dismissed bill back on the list.
pub fn undismiss(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM recurring_dismissed WHERE payee_key=?1", [key])?;
    Ok(())
}

#[tauri::command]
pub fn recurring_dismissed_list(db: tauri::State<Db>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    dismissed(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recurring_dismiss(db: tauri::State<Db>, key: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    dismiss(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recurring_undismiss(db: tauri::State<Db>, key: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    undismiss(&conn, &key).map_err(|e| e.to_string())
}
```

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ ... ]`, change

```rust
            commands::budget::accounts_set_type,
```

to

```rust
            commands::budget::accounts_set_type,
            commands::recurring::recurring_dismissed_list,
            commands::recurring::recurring_dismiss,
            commands::recurring::recurring_undismiss,
```

(If the splits plan registered its own commands right after `accounts_set_type`, leave them where they are; the order of the list does not matter.)

- [ ] **Step 8: Run the Rust tests**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: PASS — all tests, including the four in `commands::recurring::tests` and the new `db` test. No new warnings.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/commands/recurring.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(spending): remember bills that are not recurring

Migration v10 adds recurring_dismissed, one row per payee key, and three
commands list, dismiss and restore them. Spotting bills stays in
TypeScript; Rust only stores the keys to skip.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: API calls and query hooks

**Files:**
- Modify: `src/data/api.ts`
- Modify: `src/data/queries.ts`

These are thin wrappers with no logic, checked by the type-checker; the panel tests in Task 6 take the data as props, so they do not need these mocked.

- [ ] **Step 1: Add the API calls**

In `src/data/api.ts`, change

```ts
  budgets: {
    list: () => invoke<Budget[]>("budgets_list"),
    set: (categoryId: number, month: string | null, amount: number) =>
      invoke<void>("budget_set", { categoryId, month, amount }),
  },
```

to

```ts
  budgets: {
    list: () => invoke<Budget[]>("budgets_list"),
    set: (categoryId: number, month: string | null, amount: number) =>
      invoke<void>("budget_set", { categoryId, month, amount }),
  },
  recurring: {
    /** Payee keys the owner said are not bills; see `recurringKey`. */
    dismissed: () => invoke<string[]>("recurring_dismissed_list"),
    dismiss: (key: string) => invoke<void>("recurring_dismiss", { key }),
    undismiss: (key: string) => invoke<void>("recurring_undismiss", { key }),
  },
```

- [ ] **Step 2: Add the hooks**

In `src/data/queries.ts`, change

```ts
export function useSetAccountType() {
```

to

```ts
export const recurringKeys = { dismissed: ["recurring", "dismissed"] as const };

export const useRecurringDismissed = () =>
  useQuery({ queryKey: recurringKeys.dismissed, queryFn: api.recurring.dismissed });

/** Dismiss a bill (not recurring) or put it back. Detection runs in the UI
 *  over transactions already loaded, so only the dismissed list refetches. */
export function useSetRecurringDismissed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string; dismissed: boolean }) =>
      v.dismissed ? api.recurring.dismiss(v.key) : api.recurring.undismiss(v.key),
    onSuccess: () => qc.invalidateQueries({ queryKey: recurringKeys.dismissed }),
  });
}

export function useSetAccountType() {
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 4: Commit**

```bash
git add src/data/api.ts src/data/queries.ts
git commit -m "feat(spending): hooks for dismissing recurring bills

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Recurring panel

**Files:**
- Create: `src/features/spending/RecurringPanel.tsx`
- Test: `src/features/spending/RecurringPanel.test.tsx`

The panel takes the dismissed keys and a function to change them as props, so it can be tested without a backend. It uses `useToast` itself for the Undo toast.

- [ ] **Step 1: Write the failing tests**

Create `src/features/spending/RecurringPanel.test.tsx`:

```tsx
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RecurringPanel } from "./RecurringPanel";
import { ToastProvider } from "../../ui/toast";
import type { Account, BankTransaction, Category } from "../../domain/types";

const category: Category = { id: 1, name: "Subscriptions", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true };
const account = { id: 1, name: "Card", hidden: false, type: "credit" } as Account;
let n = 0;
const charge = (payee: string, posted: string, amount: number): BankTransaction => ({
  id: ++n, account_id: 1, external_id: `t${n}`, posted, amount, description: payee.toUpperCase(),
  payee, memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: true, note: null, removed: false, splits: [],
});
const monthly = (payee: string, day: string, months: string[], amount: number) =>
  months.map((m) => charge(payee, `${m}-${day}`, amount));

const TODAY = "2026-10-20";
const netflix = monthly("Netflix", "05", ["2026-07", "2026-08", "2026-09", "2026-10"], -15.49);
const spotify = monthly("Spotify", "25", ["2026-07", "2026-08", "2026-09"], -11.99);

function renderPanel(
  transactions: BankTransaction[],
  { dismissed = [] as string[], onSetDismissed = vi.fn().mockResolvedValue(undefined) } = {},
) {
  render(
    <ToastProvider>
      <RecurringPanel transactions={transactions} loading={false} categories={[category]} accounts={[account]}
        dismissed={dismissed} onSetDismissed={onSetDismissed} today={TODAY} />
    </ToastProvider>,
  );
  return { onSetDismissed };
}

describe("RecurringPanel", () => {
  it("lists a bill with how often, how much, and where it stands", () => {
    renderPanel(netflix);
    const row = screen.getByRole("row", { name: /Netflix/ });
    expect(within(row).getByText("Monthly")).toBeInTheDocument();
    expect(within(row).getByText("$15.49")).toBeInTheDocument();
    expect(within(row).getByText("Nov 5")).toBeInTheDocument();
    expect(within(row).getByText("Paid this month")).toBeInTheDocument();
    expect(within(row).getByText("Card")).toBeInTheDocument();
  });

  it("says what is still due this month", () => {
    renderPanel([...netflix, ...spotify]);
    expect(within(screen.getByRole("row", { name: /Spotify/ })).getByText("Due Oct 25")).toBeInTheDocument();
    expect(screen.getByText("Still due this month").parentElement).toHaveTextContent("$11.99");
    expect(screen.getByText("Paid this month", { selector: ".stat-label" }).parentElement).toHaveTextContent("$15.49");
  });

  it("explains itself when nothing repeats yet", () => {
    renderPanel([charge("Corner Shop", "2026-10-01", -4)]);
    expect(screen.getByText("No bills spotted yet")).toBeInTheDocument();
  });

  it("dismisses a bill, with Undo", async () => {
    const { onSetDismissed } = renderPanel(netflix);
    fireEvent.click(screen.getByRole("button", { name: "Not recurring: Netflix" }));
    expect(onSetDismissed).toHaveBeenCalledWith("netflix", true);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(onSetDismissed).toHaveBeenLastCalledWith("netflix", false);
  });

  it("keeps dismissed bills off the list and offers to restore them", () => {
    const { onSetDismissed } = renderPanel(netflix, { dismissed: ["netflix"] });
    expect(screen.queryByRole("row", { name: /Netflix/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismissed (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore Netflix" }));
    expect(onSetDismissed).toHaveBeenCalledWith("netflix", false);
  });

  it("tucks away bills not seen lately", () => {
    renderPanel(monthly("Old Gym", "05", ["2026-03", "2026-04", "2026-05"], -40));
    expect(screen.queryByRole("row", { name: /Old Gym/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not seen lately (1)" }));
    expect(within(screen.getByRole("row", { name: /Old Gym/ })).getByText("Last seen May 5")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/features/spending/RecurringPanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./RecurringPanel"`.

- [ ] **Step 3: Write the panel**

Create `src/features/spending/RecurringPanel.tsx`:

```tsx
import { useMemo, useState } from "react";
import {
  cadenceLabel, detectRecurring, monthOutlook, namesForKeys, statusOf, type RecurringSeries,
} from "../../domain/recurring";
import { localIsoDate } from "../../domain/dates";
import { money } from "../../ui/format";
import { Badge, Card, EmptyState } from "../../ui/components";
import { useToast } from "../../ui/toast";
import type { Account, BankTransaction, Category } from "../../domain/types";

/** `Oct 25`: a due date is always close, so the year adds nothing. */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function StatusBadge({ series, today }: { series: RecurringSeries; today: string }) {
  const status = statusOf(series, today);
  if (status.kind === "paid") return <Badge tone="pos">Paid this month</Badge>;
  if (status.kind === "late") return <Badge tone="warn">Late · expected {shortDate(status.since)}</Badge>;
  return <Badge tone="neutral">Due {shortDate(status.date)}</Badge>;
}

/**
 * Bills and subscriptions Tally has spotted in the history, with what is
 * still due this month. `transactions` is everything that counts toward
 * spending, from every month; detection decides which of it repeats.
 */
export function RecurringPanel({ transactions, loading, categories, accounts, dismissed, onSetDismissed, today = localIsoDate() }: {
  transactions: BankTransaction[];
  loading: boolean;
  categories: Category[];
  accounts: Account[];
  /** Keys the owner said are not bills. */
  dismissed: string[];
  onSetDismissed: (key: string, dismissed: boolean) => Promise<unknown>;
  /** For tests; the screen always means the owner's today. */
  today?: string;
}) {
  const toast = useToast();
  const [showStale, setShowStale] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  const series = useMemo(
    () => detectRecurring(transactions, categories, today, dismissed),
    [transactions, categories, today, dismissed],
  );
  const live = series.filter((s) => s.active);
  const stale = series.filter((s) => !s.active);
  const outlook = useMemo(() => monthOutlook(series, today), [series, today]);
  const dismissedRows = useMemo(() => namesForKeys(transactions, dismissed), [transactions, dismissed]);
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "—";

  async function dismiss(s: RecurringSeries) {
    try {
      await onSetDismissed(s.key, true);
    } catch (e) {
      toast.push({ tone: "neg", title: "Couldn't change that", body: String(e) });
      return;
    }
    toast.push({
      tone: "neutral",
      title: `${s.name} is off the list`,
      action: {
        label: "Undo",
        onClick: () => {
          onSetDismissed(s.key, false).catch((e) => toast.push({ tone: "neg", title: "Couldn't undo", body: String(e) }));
        },
      },
    });
  }

  function table(rows: RecurringSeries[], current: boolean) {
    return (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left">Bill</th>
              <th className="left">How often</th>
              <th>Amount</th>
              <th className="left">{current ? "Next" : "Last"}</th>
              <th className="left">Status</th>
              <th className="left">Account</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.key}>
                <td className="left">
                  <div className="cell-primary">{s.name}</div>
                  <div className="cell-secondary">{s.count} charges</div>
                </td>
                <td className="left">{cadenceLabel(s.cadence)}</td>
                <td style={{ fontWeight: 600 }}>{money(s.amount)}</td>
                <td className="left">{shortDate(current ? s.nextDate : s.lastDate)}</td>
                <td className="left">
                  {current ? <StatusBadge series={s} today={today} />
                    : <span className="muted">Last seen {shortDate(s.lastDate)}</span>}
                </td>
                <td className="left cell-secondary">{accountName(s.accountId)}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" aria-label={`Not recurring: ${s.name}`}
                    title="This isn't a bill" onClick={() => dismiss(s)}>Not recurring</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-2">
        <div className="card stat">
          <div className="stat-label">Still due this month</div>
          <div className="stat-value n">{money(outlook.dueTotal)}</div>
          <div className="stat-hint">{outlook.dueCount} bill{outlook.dueCount === 1 ? "" : "s"} to come</div>
        </div>
        <div className="card stat">
          <div className="stat-label">Paid this month</div>
          <div className="stat-value n">{money(outlook.paidTotal)}</div>
          <div className="stat-hint">{outlook.paidCount} bill{outlook.paidCount === 1 ? "" : "s"} so far</div>
        </div>
      </div>

      <Card
        title="Recurring"
        subtitle="Bills and subscriptions Tally spotted: the same payee, at a steady amount, on a regular schedule. Soonest first."
      >
        {loading ? <p className="muted">Loading…</p> : live.length === 0 && stale.length === 0 ? (
          <EmptyState
            title="No bills spotted yet"
            body="Tally lists a bill once it has seen three charges from the same payee, at a steady amount and a regular interval: weekly, monthly, yearly and so on."
          />
        ) : (
          <>
            {live.length > 0 ? table(live, true) : <p className="muted">Nothing is being charged right now.</p>}
            {stale.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowStale(!showStale)}>
                  {showStale ? "Hide not seen lately" : `Not seen lately (${stale.length})`}
                </button>
                {showStale && (
                  <>
                    <div className="muted" style={{ fontSize: 12, margin: "6px 0" }}>
                      Overdue for a while: probably cancelled. Left out of this month's figures.
                    </div>
                    {table(stale, false)}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {dismissedRows.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowDismissed(!showDismissed)}>
              {showDismissed ? "Hide dismissed" : `Dismissed (${dismissedRows.length})`}
            </button>
            {showDismissed && (
              <div style={{ display: "grid", gap: 4, marginTop: 6 }}>
                <div className="muted" style={{ fontSize: 12 }}>You said these aren't bills. Restore puts one back.</div>
                {dismissedRows.map((d) => (
                  <div key={d.key} className="row center between" style={{ gap: 8 }}>
                    <span>{d.name}</span>
                    <button className="btn btn-ghost btn-sm" aria-label={`Restore ${d.name}`}
                      onClick={() => onSetDismissed(d.key, false).catch((e) =>
                        toast.push({ tone: "neg", title: "Couldn't restore", body: String(e) }))}>
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>
    </>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/spending/RecurringPanel.test.tsx`
Expected: PASS — all six tests.

If `getByRole("row", { name: /Netflix/ })` finds nothing, check that the row text contains the name (a `<tr>` takes its accessible name from its cells); do not switch to `getAllByText`, which would also match the toast.

- [ ] **Step 5: Commit**

```bash
git add src/features/spending/RecurringPanel.tsx src/features/spending/RecurringPanel.test.tsx
git commit -m "feat(spending): a Recurring panel for bills and subscriptions

Each bill shows how often it comes, a typical amount, the next date and
whether it is paid, due or late, under a strip with what is still due and
what was paid this month. Not recurring dismisses one, with Undo; bills
not seen lately and dismissed ones sit in their own collapsed lists.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Wire the Recurring view into Spending

**Files:**
- Modify: `src/features/spending/Spending.tsx`

Read the file first: the splits plan changed parts of it. The anchors below are lines it does not touch; if one has moved, apply the same change where it now is.

- [ ] **Step 1: Add the view and its data**

(a) Change the imports. Replace

```ts
  useBankTransactionsToReview, useApproveTransactions, useSetRemoved,
} from "../../data/queries";
```

with

```ts
  useBankTransactionsToReview, useApproveTransactions, useSetRemoved,
  useRecurringDismissed, useSetRecurringDismissed,
} from "../../data/queries";
```

and below `import { SearchPanel } from "./SearchPanel";` add:

```ts
import { RecurringPanel } from "./RecurringPanel";
```

(b) Replace

```ts
type View = "month" | "review" | "search";
```

with

```ts
type View = "month" | "review" | "search" | "recurring";
```

(c) Replace

```ts
  // Search covers every month, so it loads the whole range, but only once
  // the Search view is opened.
  const [first, last] = range ?? [null, null];
  const { data: everyTxn = [], isLoading: loadingEvery } =
    useBankTransactions(first ?? "", last ?? "", view === "search" && first != null && last != null);
  const searchable = fromVisibleAccounts(everyTxn, allAccounts);
```

with

```ts
  // Search and Recurring cover every month, so they load the whole range,
  // but only once one of them is opened. Both read the same cached query.
  const [first, last] = range ?? [null, null];
  const everyMonth = view === "search" || view === "recurring";
  const { data: everyTxn = [], isLoading: loadingEvery } =
    useBankTransactions(first ?? "", last ?? "", everyMonth && first != null && last != null);
  const searchable = fromVisibleAccounts(everyTxn, allAccounts);

  const { data: dismissed = [] } = useRecurringDismissed();
  const setDismissed = useSetRecurringDismissed();
```

(d) In the `Segmented` items, replace

```tsx
            { value: "search", label: "Search" },
          ]} />
```

with

```tsx
            { value: "search", label: "Search" },
            { value: "recurring", label: "Recurring" },
          ]} />
```

(e) Between the Search branch and the To review branch, replace

```tsx
      ) : view === "review" ? (
```

with

```tsx
      ) : view === "recurring" ? (
        <RecurringPanel
          transactions={searchable}
          loading={loadingEvery}
          categories={categories}
          accounts={accounts}
          dismissed={dismissed}
          onSetDismissed={(key, d) => setDismissed.mutateAsync({ key, dismissed: d })}
        />
      ) : view === "review" ? (
```

- [ ] **Step 2: Type-check and run every TS test**

Run: `npx tsc --noEmit`
Expected: no output.

Run: `npm test`
Expected: all test files pass, including `recurring.test.ts` and `RecurringPanel.test.tsx`.

- [ ] **Step 3: Look at it in the running app**

Run (PowerShell or the "Tally (test)" Desktop shortcut; do not run it while the installed Tally is open, they share a database):

```bash
npm run tauri dev
```

Open Spending → **Recurring**. Check: the strip shows two figures; real subscriptions (streaming, phone, gym) appear with sensible cadences and next dates; "Not recurring" removes a row and Undo brings it back; the Dismissed list and Restore work; the Month, To review and Search views still work. Close the app when done.

- [ ] **Step 4: Commit**

```bash
git add src/features/spending/Spending.tsx
git commit -m "feat(spending): a Recurring view beside Month, To review and Search

It reads the same every-month query Search uses, loaded only while one
of them is open.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/TODO.md`
- Modify: `docs/HANDOFF.md`
- Modify: `README.md`

- [ ] **Step 1: Tick the TODO item**

In `docs/TODO.md`, replace

```
- [ ] **12. Recurring bills and subscriptions.** Detect repeating payees with a
      steady amount and cadence, list them with the next expected date, and show
      what is still due this month. The maths is pure and belongs in
      `src/domain/`. **(spec)**
```

with

```
- [x] **12. Recurring bills and subscriptions.** Done 2026-10-25: Spending →
      Recurring lists bills spotted from the history (three or more charges
      from one payee at a steady amount and rhythm) with the next expected
      date, and shows what is still due and what was paid this month. "Not
      recurring" dismisses a wrong guess. Income and paychecks are not listed.
```

- [ ] **Step 2: Describe it in HANDOFF**

In `docs/HANDOFF.md`, directly after the bullet that starts `- **Remove and Undo** (Spending):` and ends `Settings → Spending turns it back on.`, add:

```
- **Recurring** (Spending → Recurring): bills and subscriptions spotted from
  every month's history by `detectRecurring` in `src/domain/recurring.ts`
  (pure, tested). Money out only; pending, removed, transfer and income rows
  are left out, uncategorised ones kept; a split counts whole. Charges are
  grouped by `recurringKey` (payee or description, lowercased, runs of 3+
  digits removed, spaces collapsed) with same-day duplicates counted once. A
  bill needs **3+ charges**; the median gap picks the cadence (weekly 6–8
  days, every two weeks 13–16, monthly 27–33, every three months 84–98,
  yearly 350–380); **75%** of gaps must fit it and **75%** of amounts must be
  within **25% or $2** of the median. Amount is the median of the last three;
  the next date steps by days or calendar months from the last charge (Jan 31
  → Feb 28). Past the next date by more than its grace (3/5/10/20/30 days) a
  bill is "Not seen lately" and drops out of the month's figures.
  `monthOutlook` gives what is still due (late ones included) and what was
  paid this month. "Not recurring" stores the key in `recurring_dismissed`
  (v10); Rust never builds keys, it only stores what `recurringKey` made.
```

- [ ] **Step 3: Add the v10 note to HANDOFF's gotchas**

In `docs/HANDOFF.md`, directly after the bullet that ends

```
  the completeness check is `v5_is_complete`.
```

add:

```
- **v10 adds `recurring_dismissed`** (`payee_key` primary key,
  `dismissed_at`), `IF NOT EXISTS`, checked by `v10_is_complete`. Its keys
  are made only by `recurringKey` in TypeScript: change that normalisation
  and every dismissed bill reappears, so treat it like a stored format.
```

- [ ] **Step 4: Add the README feature**

In `README.md`, under **Spending and budgets**, directly after

```
- A "To review" list for anything new, and rules that learn from your choices
```

add:

```
- Recurring bills and subscriptions spotted automatically, with the next
  expected date and what is still due this month
```

- [ ] **Step 5: Run everything once more**

Run: `npm test`
Expected: all pass.

Run: `npx tsc --noEmit`
Expected: no output.

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib`
Expected: all pass (the `#[ignore]`d live tests stay ignored).

- [ ] **Step 6: Commit**

```bash
git add docs/TODO.md docs/HANDOFF.md README.md
git commit -m "docs: recurring bills and subscriptions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

**Pinned design coverage**

| Requirement | Task |
| --- | --- |
| Detection pure TS, over the full history, loaded like Search, only while open | 2, 7 (`everyMonth` flag on the same query) |
| Money out, not pending/removed, not transfer/income, uncategorised allowed, splits whole | 2 (`detectRecurring` filter + test) |
| `recurringKey` rules; same-day duplicates collapse | 1, 2 |
| Five cadences with the given windows; calendar-month stepping with clamp | 1 (`CADENCES`, `stepDate`) |
| ≥ 3 charges, median gap picks cadence, ≥ 75% gaps fit, ≥ 75% amounts within max(25%, $2), amount = median of last 3 | 2 |
| `RecurringSeries` fields (plus `charges`, needed for "paid") | 2 |
| `nextDate = stepDate(lastDate)`, `active` with per-cadence grace | 2 |
| `monthOutlook` due list/count/total and paid total | 3 |
| Status Paid / Due / Late | 3 (`statusOf`), 6 (`StatusBadge`) |
| `recurring_dismissed` table, v10 migration, `migration_pending`, idempotent test | 4 |
| `commands/recurring.rs` plain fns + thin commands, tested; registered in `lib.rs` | 4 |
| API calls and hooks | 5 |
| Segmented "Recurring"; panel with stat strip, sorted list, Not recurring + Undo toast, Not seen lately, Dismissed + Restore, empty state | 6, 7 |
| TODO item 12, HANDOFF bullet + v10 note, README | 8 |

**Type consistency:** `recurringKey`, `displayName`, `stepDate(date, cadence, times)`, `cadenceLabel`, `detectRecurring(txns, categories, today, dismissed)`, `statusOf(series, today)`, `monthOutlook(series, today)`, `namesForKeys(txns, keys)`, `RecurringSeries`, `RecurringStatus` (`paid` / `due.date` / `late.since`), `MonthOutlook` (`due`, `dueCount`, `dueTotal`, `paidCount`, `paidTotal`) are used with the same names and shapes in Tasks 1–3, 6 and 7. Rust `dismissed` / `dismiss` / `undismiss` and commands `recurring_dismissed_list` / `recurring_dismiss` / `recurring_undismiss` match `api.recurring.*` (`{ key }` argument). Hooks are `useRecurringDismissed` and `useSetRecurringDismissed` in both Task 5 and Task 7.

**Paid this month** sums every charge each bill made this month (from `RecurringSeries.charges`), so a weekly bill charged three times counts all three — pinned by a test in Task 3.

**Dependency on the splits plan:** fixtures carry `splits: []`; the db.rs steps keep v9 and put v10 after it; the Spending anchors avoid lines the splits plan changes. Land splits first.
