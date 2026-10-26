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
