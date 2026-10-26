import { describe, it, expect } from "vitest";
import { localIsoDate, daysBetween, monthsUntil } from "./dates";

describe("localIsoDate", () => {
  // `toISOString()` gives the UTC date, which in the US evening is already
  // tomorrow and in Asia's early morning is still yesterday. Checking both
  // ends of one local day catches that in any timezone but UTC itself.
  it("gives the local calendar date just after midnight", () => {
    expect(localIsoDate(new Date(2026, 8, 24, 0, 30))).toBe("2026-09-24");
  });

  it("gives the local calendar date just before midnight", () => {
    expect(localIsoDate(new Date(2026, 8, 24, 23, 30))).toBe("2026-09-24");
  });

  it("pads single-digit months and days", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 12, 0))).toBe("2026-01-05");
  });
});

describe("daysBetween", () => {
  it("counts whole days, forwards and backwards", () => {
    expect(daysBetween("2026-10-25", "2026-10-28")).toBe(3);
    expect(daysBetween("2026-10-28", "2026-10-25")).toBe(-3);
    expect(daysBetween("2026-10-25", "2026-10-25")).toBe(0);
  });

  it("is not moved by a clock change", () => {
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
  });
});

describe("monthsUntil", () => {
  it("is zero on the day itself", () => {
    expect(monthsUntil("2026-10-25", "2026-10-25")).toBe(0);
  });

  it("is one for exactly one month, and for a few days", () => {
    expect(monthsUntil("2026-10-25", "2026-11-25")).toBe(1);
    expect(monthsUntil("2026-10-25", "2026-10-28")).toBe(1);
  });

  it("counts a part month as a whole one", () => {
    expect(monthsUntil("2026-10-25", "2026-11-26")).toBe(2);
  });

  it("crosses a year end", () => {
    expect(monthsUntil("2026-10-25", "2027-01-25")).toBe(3);
  });

  it("is negative once the date has passed", () => {
    expect(monthsUntil("2026-10-25", "2026-09-01")).toBeLessThan(0);
  });
});
