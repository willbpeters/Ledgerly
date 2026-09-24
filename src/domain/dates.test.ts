import { describe, it, expect } from "vitest";
import { localIsoDate } from "./dates";

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
