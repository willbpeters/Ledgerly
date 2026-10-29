import { describe, it, expect } from "vitest";
import { money, pct, share, shareCount, fmtDate, timeAgo } from "./format";

describe("format helpers", () => {
  it("shareCount hides floating-point noise and keeps up to three decimals", () => {
    expect(shareCount(3877.0960000000005)).toBe("3,877.096");
    expect(shareCount(3131.648)).toBe("3,131.648");
    expect(shareCount(12)).toBe("12");
    expect(shareCount(0.1 + 0.2)).toBe("0.3");
    expect(shareCount(-5.25)).toBe("-5.25");
  });
  it("money formats USD with two decimals", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(-50)).toBe("-$50.00");
  });
  it("pct formats with sign and one decimal", () => {
    expect(pct(12.34)).toBe("+12.3%");
    expect(pct(-3)).toBe("-3.0%");
  });
  it("pct never shows a signed zero", () => {
    expect(pct(-0.004)).toBe("0.0%");
    expect(pct(0.03)).toBe("0.0%");
    expect(pct(0)).toBe("0.0%");
    expect(pct(-0.05)).toBe("-0.1%");
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

describe("share", () => {
  it("renders a proportion as a plain percentage", () => {
    expect(share(0.8)).toBe("80.0%");
    expect(share(0.25)).toBe("25.0%");
  });
  it("never signs the number, unlike pct", () => {
    expect(share(1)).toBe("100.0%");
    expect(share(0)).toBe("0.0%");
  });
});
