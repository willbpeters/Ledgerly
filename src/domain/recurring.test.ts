import { describe, it, expect } from "vitest";
import { recurringKey, displayName, stepDate, cadenceLabel, detectRecurring, statusOf, monthOutlook, namesForKeys, type RecurringSeries } from "./recurring";
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

  it("lists the soonest next charge first", () => {
    const txns = [
      ...monthly("Later", "25", ["2026-08", "2026-09", "2026-10"], -10),
      ...monthly("Sooner", "02", ["2026-08", "2026-09", "2026-10"], -10),
    ];
    expect(detectRecurring(txns, cats, TODAY).map((s) => s.name)).toEqual(["Sooner", "Later"]);
  });
});

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
