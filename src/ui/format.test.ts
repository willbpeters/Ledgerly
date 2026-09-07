import { describe, it, expect } from "vitest";
import { money, pct, fmtDate } from "./format";

describe("format helpers", () => {
  it("money formats USD with two decimals", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(-50)).toBe("-$50.00");
  });
  it("pct formats with sign and one decimal", () => {
    expect(pct(12.34)).toBe("+12.3%");
    expect(pct(-3)).toBe("-3.0%");
  });
  it("fmtDate passes through ISO date", () => {
    expect(fmtDate("2026-01-02")).toBe("2026-01-02");
  });
});
