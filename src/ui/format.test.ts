import { describe, it, expect } from "vitest";
import { money, pct, fmtDate, timeAgo } from "./format";

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

describe("timeAgo", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  it("formats relative times", () => {
    expect(timeAgo("2026-09-07T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-09-07T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-09-07T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-09-05T12:00:00Z", now)).toBe("2 d ago");
    expect(timeAgo(null, now)).toBe("never");
  });
});
