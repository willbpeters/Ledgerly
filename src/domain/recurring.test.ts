import { describe, it, expect } from "vitest";
import { recurringKey, displayName, stepDate, cadenceLabel, detectRecurring, statusOf, monthOutlook, namesForKeys, LATE_AFTER_DAYS, stepSeries, type RecurringSeries } from "./recurring";
import type { BankTransaction, Category } from "./types";

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

  it("falls back to the description when the payee is only digits", () => {
    expect(recurringKey({ payee: "12345", description: "Netflix" })).toBe("netflix");
  });

  it("is empty when neither the payee nor the description has a name left", () => {
    expect(recurringKey({ payee: "12345", description: "67890" })).toBe("");
  });
});

describe("displayName", () => {
  it("prefers the trimmed payee, then the trimmed description", () => {
    expect(displayName({ payee: "  Netflix ", description: "NETFLIX.COM" })).toBe("Netflix");
    expect(displayName({ payee: null, description: "  Spotify USA  " })).toBe("Spotify USA");
  });

  it("uses the description when the payee has no name left, as recurringKey does", () => {
    expect(displayName({ payee: "12345", description: "NETFLIX" })).toBe("NETFLIX");
    expect(displayName({ payee: "7-Eleven", description: "x" })).toBe("7-Eleven");
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

describe("stepSeries", () => {
  const at = (lastDate: string, dates: string[]) =>
    stepSeries({ lastDate, cadence: "monthly", charges: dates.map((date) => ({ date, amount: 10 })) });

  it("keeps a month-end bill on its largest recent day after a clamped month", () => {
    expect(at("2026-04-30", ["2026-02-28", "2026-03-31", "2026-04-30"])).toBe("2026-05-31");
    expect(at("2026-02-28", ["2025-12-31", "2026-01-31", "2026-02-28"])).toBe("2026-03-31");
  });

  it("follows a billing day that moved from the 28th to the 5th", () => {
    expect(at("2026-11-05", ["2026-09-28", "2026-10-28", "2026-11-05"])).toBe("2026-12-05");
  });

  it("steps from the 1st when a month-end charge posted on the 1st", () => {
    expect(at("2026-12-01", ["2026-09-30", "2026-10-31", "2026-12-01"])).toBe("2027-01-01");
  });

  it("steps from the 1st when the charges were on the 1st, 3rd and 1st", () => {
    expect(at("2026-10-01", ["2026-08-01", "2026-09-03", "2026-10-01"])).toBe("2026-11-01");
  });
});

describe("cadenceLabel", () => {
  it("names each cadence for a person", () => {
    expect(cadenceLabel("monthly")).toBe("Monthly");
    expect(cadenceLabel("biweekly")).toBe("Every two weeks");
  });
});

const cats: Category[] = [
  { id: 1, name: "Subscriptions", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true },
  { id: 2, name: "Income", kind: "income", colour: "chart-2", sort: 20, is_builtin: true },
  { id: 3, name: "Transfer", kind: "transfer", colour: "chart-6", sort: 30, is_builtin: true },
  { id: 4, name: "Groceries", kind: "spending", colour: "chart-3", sort: 40, is_builtin: true },
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

  it("looks only at money out that is posted and not a transfer or income", () => {
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
      ...monthly("Netflix", "05", ["2026-07", "2026-08", "2026-09", "2026-10"], -15.49),
      charge("Netflix", "2026-10-05", -15.49),
    ];
    const [s] = detectRecurring(txns, cats, TODAY);
    expect(s.count).toBe(4);
    expect(s.transactionIds).toHaveLength(5);
  });

  it("adds up the lines of one day into one charge", () => {
    const txns = ["2026-07", "2026-08", "2026-09", "2026-10"].flatMap((m, i) => {
      const big = charge("Costco", `${m}-05`, -15.49);
      const small = charge("Costco", `${m}-05`, -7.99);
      return i % 2 === 0 ? [big, small] : [small, big];
    });
    const found = detectRecurring(txns, cats, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].amount).toBe(23.48);
    expect(found[0].charges.map((c) => c.amount)).toEqual([23.48, 23.48, 23.48, 23.48]);
    expect(found[0].count).toBe(4);
    expect(found[0].transactionIds).toHaveLength(8);
  });

  it("judges the amount on recent charges, so an old price does not count against a rise", () => {
    const txns = [
      ...monthly("Streamer", "05", ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"], -7.99),
      ...monthly("Streamer", "05", ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"], -10.99),
    ];
    const found = detectRecurring(txns, cats, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0].amount).toBe(10.99);
  });

  it("forgives one skipped month among five charges", () => {
    // Gaps 31, 61, 31, 30: median 31 is monthly, and three of four gaps fit.
    const txns = monthly("Gym", "05", ["2026-05", "2026-06", "2026-08", "2026-09", "2026-10"], -40);
    expect(detectRecurring(txns, cats, TODAY).map((s) => s.cadence)).toEqual(["monthly"]);
  });

  it("does not forgive a skipped month among only four charges", () => {
    // Gaps 61, 31, 30: the median 31 is monthly, but only two of three gaps fit, under the share.
    const txns = monthly("Gym", "05", ["2026-06", "2026-08", "2026-09", "2026-10"], -40);
    expect(detectRecurring(txns, cats, TODAY)).toEqual([]);
  });

  it("skips a split whose every piece is a transfer or income", () => {
    const txns = ["2026-08", "2026-09", "2026-10"].map((m, i) => charge("Card Payment", `${m}-02`, -500, {
      category_id: null,
      splits: [
        { id: 10 + i * 2, category_id: 3, amount: -300, note: null },
        { id: 11 + i * 2, category_id: 2, amount: -200, note: null },
      ],
    }));
    expect(detectRecurring(txns, cats, TODAY)).toEqual([]);
  });

  it("keeps a split with any spending piece, filed under its largest piece", () => {
    const split = (m: string, a: number, b: number) => charge("Costco", `${m}-05`, -(a + b), {
      category_id: null,
      splits: [
        { id: 0, category_id: 1, amount: -a, note: null },
        { id: 0, category_id: 4, amount: -b, note: null },
      ],
    });
    // Subscriptions was the larger piece until the latest charge, where Groceries is.
    const txns = [split("2026-08", 30, 10), split("2026-09", 30, 10), split("2026-10", 10, 30)];
    const found = detectRecurring(txns, cats, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ amount: 40, categoryId: 4 });
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

  it("treats a pending latest charge as the latest charge", () => {
    const txns = [
      ...monthly("Netflix", "15", ["2026-07", "2026-08", "2026-09"], -15.49),
      charge("Netflix", "2026-10-15", -15.49, { pending: true }),
    ];
    const [s] = detectRecurring(txns, cats, "2026-10-17");
    expect(s).toMatchObject({ lastDate: "2026-10-15", nextDate: "2026-11-15", active: true, count: 4 });
    expect(s.charges.map((c) => c.date)).toEqual(["2026-07-15", "2026-08-15", "2026-09-15", "2026-10-15"]);
    expect(s.transactionIds).toHaveLength(4);
    expect(statusOf(s, "2026-10-17")).toEqual({ kind: "paid" });
    expect(monthOutlook([s], "2026-10-17")).toMatchObject({ paidTotal: 15.49, paidCount: 1, due: [] });
  });

  it("does not let pending charges make a bill, fit a cadence, or move an amount", () => {
    const pendingOnly = monthly("Pending Co", "04", ["2026-08", "2026-09", "2026-10"], -10, { pending: true });
    const two = [...monthly("Netflix", "15", ["2026-08", "2026-09"], -15.49), charge("Netflix", "2026-10-15", -15.49, { pending: true })];
    expect(detectRecurring([...pendingOnly, ...two], cats, TODAY)).toEqual([]);

    const odd = [
      ...monthly("Netflix", "15", ["2026-07", "2026-08", "2026-09"], -15.49),
      charge("Netflix", "2026-10-15", -900, { pending: true }),
    ];
    expect(detectRecurring(odd, cats, TODAY)[0].amount).toBe(15.49);
  });

  it("ignores a pending charge dated before the last settled one", () => {
    const txns = [
      ...monthly("Netflix", "15", ["2026-07", "2026-08", "2026-09"], -15.49),
      charge("Netflix", "2026-08-20", -15.49, { pending: true }),
    ];
    const [s] = detectRecurring(txns, cats, TODAY);
    expect(s.lastDate).toBe("2026-09-15");
    expect(s.count).toBe(3);
  });

  it("keeps a bill on the 31st expected on the 31st after short months", () => {
    const txns = ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"].map((d) => charge("Rent", d, -900));
    expect(detectRecurring(txns, cats, "2026-05-02")[0]).toMatchObject({ lastDate: "2026-04-30", nextDate: "2026-05-31" });
  });

  it("steps from the 31st after a February 28 charge", () => {
    const txns = ["2025-12-31", "2026-01-31", "2026-02-28"].map((d) => charge("Rent", d, -900));
    expect(detectRecurring(txns, cats, "2026-03-05")[0].nextDate).toBe("2026-03-31");
  });

  it("counts a removed charge for timing, but not for money", () => {
    const txns = [
      ...monthly("Phone", "03", ["2026-07", "2026-08", "2026-09"], -50),
      charge("Phone", "2026-10-03", -50, { removed: true }),
    ];
    const [s] = detectRecurring(txns, cats, TODAY);
    expect(s).toMatchObject({ lastDate: "2026-10-03", nextDate: "2026-11-03", active: true, count: 4 });
    expect(statusOf(s, TODAY)).toEqual({ kind: "paidBack" });
    expect(monthOutlook([s], TODAY)).toMatchObject({ paidCount: 0, paidTotal: 0, due: [] });
  });

  it("finds a bill by its rhythm even when a removed row hides a month's money", () => {
    // Without the removed Aug row the gaps would be 61, 30: no steady monthly rhythm.
    const txns = [
      charge("Phone", "2026-07-03", -50), charge("Phone", "2026-08-03", -50, { removed: true }),
      charge("Phone", "2026-09-03", -50), charge("Phone", "2026-10-03", -50),
    ];
    expect(detectRecurring(txns, cats, TODAY)).toHaveLength(1);
  });

  it("judges the amount on kept charges where there are any", () => {
    const txns = [
      ...monthly("Phone", "03", ["2026-07", "2026-08", "2026-09"], -50),
      charge("Phone", "2026-10-03", -4, { removed: true }),
    ];
    expect(detectRecurring(txns, cats, TODAY)[0].amount).toBe(50);
  });

  it("drops a series whose every charge was paid back", () => {
    const txns = monthly("Phone", "03", ["2026-08", "2026-09", "2026-10"], -50, { removed: true });
    expect(detectRecurring(txns, cats, TODAY)).toEqual([]);
  });

  it("sums only the kept lines of a day that was partly removed", () => {
    const txns = ["2026-08", "2026-09", "2026-10"].flatMap((m) => [
      charge("Phone", `${m}-03`, -50), charge("Phone", `${m}-03`, -20, { removed: true }),
    ]);
    const [s] = detectRecurring(txns, cats, TODAY);
    expect(s.amount).toBe(50);
    expect(s.charges.map((c) => c.amount)).toEqual([50, 50, 50]);
  });

  it("lists the soonest next charge first", () => {
    const txns = [
      ...monthly("Later", "25", ["2026-08", "2026-09", "2026-10"], -10),
      ...monthly("Sooner", "02", ["2026-08", "2026-09", "2026-10"], -10),
    ];
    expect(detectRecurring(txns, cats, TODAY).map((s) => s.name)).toEqual(["Sooner", "Later"]);
  });
});

/** `nextDate` follows from `lastDate` and `cadence` unless a test says otherwise. */
const series = (over: Partial<RecurringSeries>): RecurringSeries => {
  const s: RecurringSeries = {
    key: "k", name: "Bill", cadence: "monthly", amount: 10, charges: [],
    lastDate: "2026-09-25", nextDate: "", count: 4, categoryId: null, accountId: 1,
    active: true, transactionIds: [], ...over,
  };
  return { ...s, nextDate: over.nextDate ?? stepDate(s.lastDate, s.cadence) };
};

describe("statusOf", () => {
  it("is due on the next date when that is still ahead", () => {
    expect(statusOf(series({}), "2026-10-20")).toEqual({ kind: "due", date: "2026-10-25" });
  });

  it("is paid when charged this month and next due after it", () => {
    expect(statusOf(series({ lastDate: "2026-10-05" }), "2026-10-20")).toEqual({ kind: "paid" });
  });

  it("is still due when charged this month but due again before it ends", () => {
    const weekly = series({ cadence: "weekly", lastDate: "2026-10-13" });
    expect(statusOf(weekly, "2026-10-20")).toEqual({ kind: "due", date: "2026-10-20" });
  });

  it("is late once the next date is more than the slack past", () => {
    expect(statusOf(series({ lastDate: "2026-09-15" }), "2026-10-20")).toEqual({ kind: "late", since: "2026-10-15" });
  });

  it("is still due, on its date, within the slack for weekends and posting lag", () => {
    expect(LATE_AFTER_DAYS).toBe(2);
    const s = series({ lastDate: "2026-09-15" });
    expect(statusOf(s, "2026-10-15")).toEqual({ kind: "due", date: "2026-10-15" });
    expect(statusOf(s, "2026-10-17")).toEqual({ kind: "due", date: "2026-10-15" });
    expect(statusOf(s, "2026-10-18")).toEqual({ kind: "late", since: "2026-10-15" });
  });

  it("is paid back when every charge this month was removed", () => {
    const s = series({ lastDate: "2026-10-05", charges: [{ date: "2026-10-05", amount: 10, removed: true }] });
    expect(statusOf(s, "2026-10-20")).toEqual({ kind: "paidBack" });
  });

  it("is paid when only some of this month's charges were removed", () => {
    const s = series({ lastDate: "2026-10-05",
      charges: [{ date: "2026-10-03", amount: 10, removed: true }, { date: "2026-10-05", amount: 10 }] });
    expect(statusOf(s, "2026-10-20")).toEqual({ kind: "paid" });
  });

  it("is due next month, not paid, for a quarterly bill charged before this month", () => {
    const quarterly = series({ cadence: "quarterly", lastDate: "2026-08-20" });
    expect(statusOf(quarterly, "2026-10-20")).toEqual({ kind: "due", date: "2026-11-20" });
  });
});

describe("monthOutlook", () => {
  it("adds up what is still due and what was paid this month", () => {
    const o = monthOutlook([
      series({ key: "due", amount: 12, lastDate: "2026-09-25" }),
      series({ key: "paid", amount: 15, charges: [{ date: "2026-09-05", amount: 14.99 }, { date: "2026-10-05", amount: 15.49 }],
        lastDate: "2026-10-05" }),
    ], "2026-10-20");
    expect(o.due.map((d) => [d.key, d.date])).toEqual([["due", "2026-10-25"]]);
    expect(o.dueTotal).toBe(12);
    expect(o.paidCount).toBe(1);
    expect(o.paidTotal).toBe(15.49);
  });

  it("adds every charge a weekly bill already made this month to what was paid", () => {
    const o = monthOutlook([
      series({ cadence: "weekly", amount: 60, lastDate: "2026-10-13",
        charges: [{ date: "2026-09-29", amount: 60 }, { date: "2026-10-06", amount: 60 }, { date: "2026-10-13", amount: 61 }] }),
    ], "2026-10-15");
    expect(o.paidCount).toBe(1);
    expect(o.paidTotal).toBe(121);
  });

  it("counts every charge a weekly bill still has to make this month", () => {
    const o = monthOutlook([
      series({ cadence: "weekly", amount: 60, lastDate: "2026-10-13" }),
    ], "2026-10-20");
    expect(o.due.map((d) => d.date)).toEqual(["2026-10-20", "2026-10-27"]);
    expect(o.dueTotal).toBe(120);
  });

  it("still counts a late bill as due", () => {
    const o = monthOutlook([series({ lastDate: "2026-09-12" })], "2026-10-20");
    expect(o.due.map((d) => d.date)).toEqual(["2026-10-12"]);
  });

  it("keeps a late bill whose first expected date fell last month", () => {
    const quarterly = monthOutlook([series({ cadence: "quarterly", lastDate: "2026-06-25" })], "2026-10-05");
    expect(quarterly.due.map((d) => d.date)).toEqual(["2026-09-25"]);

    const monthly = monthOutlook([series({ lastDate: "2026-08-28" })], "2026-10-03");
    expect(monthly.due.map((d) => d.date)).toEqual(["2026-09-28", "2026-10-28"]);
  });

  it("keeps a bill that was due on the last day of last month when today is the 1st", () => {
    const o = monthOutlook([series({ lastDate: "2026-08-30" })], "2026-10-01");
    expect(o.due.map((d) => d.date)).toContain("2026-09-30");
  });

  it("leaves out bills no longer seen and bills not due until next month", () => {
    const o = monthOutlook([
      series({ key: "gone", active: false }),
      series({ key: "later", lastDate: "2026-10-01" }),
      series({ key: "quarterly", cadence: "quarterly", lastDate: "2026-08-20" }),
    ], "2026-10-20");
    expect(o.due).toEqual([]);
    expect(o.dueTotal).toBe(0);
  });

  it("adds money in whole cents, so the totals carry no float noise", () => {
    const paid = monthOutlook([
      series({ key: "a", lastDate: "2026-10-05", charges: [{ date: "2026-10-05", amount: 15.49 }] }),
      series({ key: "b", lastDate: "2026-10-06", charges: [{ date: "2026-10-06", amount: 9.99 }] }),
      series({ key: "c", lastDate: "2026-10-07", charges: [{ date: "2026-10-07", amount: 12.5 }] }),
    ], "2026-10-20");
    expect(paid.paidTotal).toBe(37.98);

    const due = monthOutlook([
      series({ key: "a", amount: 0.1, lastDate: "2026-09-25" }),
      series({ key: "b", amount: 0.2, lastDate: "2026-09-26" }),
    ], "2026-10-20");
    expect(due.dueTotal).toBe(0.3);
  });

  it("lists charges soonest first, a same-day tie broken by name", () => {
    const o = monthOutlook([
      series({ key: "z", name: "Zed", lastDate: "2026-09-25" }),
      series({ key: "a", name: "Amp", lastDate: "2026-09-25" }),
      series({ key: "m", name: "Mid", lastDate: "2026-09-22" }),
    ], "2026-10-20");
    expect(o.due.map((d) => d.name)).toEqual(["Mid", "Amp", "Zed"]);
  });

  it("steps from the largest recent day of the month, so the 31st is not lost", () => {
    const o = monthOutlook([
      series({ lastDate: "2026-02-28",
        charges: [{ date: "2025-12-31", amount: 10 }, { date: "2026-01-31", amount: 10 }, { date: "2026-02-28", amount: 10 }] }),
    ], "2026-03-05");
    expect(o.due.map((d) => d.date)).toEqual(["2026-03-31"]);
  });

  it("skips removed charges in what was paid, and does not count a bill whose only charge this month was removed", () => {
    const o = monthOutlook([
      series({ lastDate: "2026-10-03",
        charges: [{ date: "2026-09-03", amount: 50 }, { date: "2026-10-03", amount: 50, removed: true }] }),
    ], "2026-10-20");
    expect(o.paidCount).toBe(0);
    expect(o.paidTotal).toBe(0);
  });

  it("agrees with statusOf about every bill", () => {
    const today = "2026-10-10";
    const all = [
      series({ key: "paid", lastDate: "2026-10-05", charges: [{ date: "2026-10-05", amount: 10 }] }),
      series({ key: "ahead", lastDate: "2026-09-25" }),
      series({ key: "late", lastDate: "2026-09-05" }),
      series({ key: "weekly", cadence: "weekly", lastDate: "2026-10-06" }),
      series({ key: "quarterly-late", cadence: "quarterly", lastDate: "2026-06-25" }),
      series({ key: "quarterly-next", cadence: "quarterly", lastDate: "2026-08-20" }),
      series({ key: "yearly-paid", cadence: "yearly", lastDate: "2026-10-02", charges: [{ date: "2026-10-02", amount: 10 }] }),
      series({ key: "slack", lastDate: "2026-09-09" }),
      series({ key: "paid-back", lastDate: "2026-10-05", charges: [{ date: "2026-10-05", amount: 10, removed: true }] }),
    ];
    const o = monthOutlook(all, today);
    const inDue = (key: string) => o.due.some((d) => d.key === key);
    for (const s of all) {
      const status = statusOf(s, today);
      if (status.kind === "paid" || status.kind === "paidBack") expect(inDue(s.key), s.key).toBe(false);
      else if (status.kind === "late") expect(inDue(s.key), s.key).toBe(true);
      else expect(inDue(s.key), s.key).toBe(status.date <= "2026-10-31");
    }
    expect(all.map((s) => statusOf(s, today).kind)).toEqual(["paid", "due", "late", "due", "late", "due", "paid", "due", "paidBack"]);
    // Only a bill with a charge the owner paid for this month is counted as charging.
    expect(o.paidCount).toBe(2);
  });
});

describe("namesForKeys", () => {
  it("gives each key the latest name seen, and the key itself when none is", () => {
    const txns = [
      charge("NETFLIX", "2026-08-05", -15.49),
      charge("Netflix", "2026-09-05", -15.49),
    ];
    expect(namesForKeys(txns, ["zzz gone", "netflix"], cats)).toEqual([
      { key: "netflix", name: "Netflix" },
      { key: "zzz gone", name: "zzz gone" },
    ]);
  });

  it("takes names only from rows that detection would look at", () => {
    const txns = [
      charge("Netflix", "2026-09-05", -15.49),
      charge("NETFLIX", "2026-10-05", -15.49, { pending: true }),
      charge("NetFlix", "2026-10-07", 15.49),
      charge("Refunded", "2026-10-07", 20),
      charge("Card Payment", "2026-10-07", -500, { category_id: 3 }),
      charge("Side Gig", "2026-10-07", -10, { category_id: 2 }),
    ];
    expect(namesForKeys(txns, ["netflix", "refunded", "card payment", "side gig"], cats)).toEqual([
      { key: "card payment", name: "card payment" },
      { key: "netflix", name: "Netflix" },
      { key: "refunded", name: "refunded" },
      { key: "side gig", name: "side gig" },
    ]);
  });

  it("takes a name from a removed row, as detection counts one for timing", () => {
    expect(namesForKeys([charge("Netflix", "2026-10-06", -15.49, { removed: true })], ["netflix"], cats))
      .toEqual([{ key: "netflix", name: "Netflix" }]);
  });

  it("orders names that collate alike by key, in plain code-unit order whatever the locale", () => {
    // "é" as one character and as "e" plus an accent: the same name to a locale
    // comparison, two different keys to the code.
    const precomposed = "caf\u00e9";
    const decomposed = "cafe\u0301";
    const txns = [
      charge(precomposed, "2026-09-05", -5),
      charge(decomposed, "2026-09-06", -5),
    ];
    const want = [
      { key: decomposed, name: decomposed },
      { key: precomposed, name: precomposed },
    ];
    expect(namesForKeys(txns, [precomposed, decomposed], cats)).toEqual(want);
    expect(namesForKeys(txns, [decomposed, precomposed], cats)).toEqual(want);
  });
});
