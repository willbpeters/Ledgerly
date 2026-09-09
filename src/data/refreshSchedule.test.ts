import { describe, it, expect } from "vitest";
import { isUsMarketOpen, planNextTick, MARKET_HOURS_MS, OFF_HOURS_MS, HIDDEN_RECHECK_MS } from "./refreshSchedule";

// 2026-09-08 is a Tuesday; 2026-09-12 a Saturday. Times are given in UTC and
// converted internally, so these hold regardless of the machine's timezone.
const tueMidMorningEt = new Date("2026-09-08T14:00:00Z"); // 10:00 EDT — open
const tueEveningEt = new Date("2026-09-09T01:00:00Z");    // 21:00 EDT Tue — closed
const satMidMorningEt = new Date("2026-09-12T14:00:00Z"); // 10:00 EDT Sat — closed

describe("isUsMarketOpen", () => {
  it("is open on a weekday mid-morning Eastern", () => {
    expect(isUsMarketOpen(tueMidMorningEt)).toBe(true);
  });

  it("is closed on a weekday evening Eastern", () => {
    expect(isUsMarketOpen(tueEveningEt)).toBe(false);
  });

  it("is closed at the weekend", () => {
    expect(isUsMarketOpen(satMidMorningEt)).toBe(false);
  });
});

describe("planNextTick", () => {
  it("fetches once a minute while the market is open and the window is visible", () => {
    expect(planNextTick(tueMidMorningEt, true)).toEqual({ fetch: true, delayMs: MARKET_HOURS_MS });
    expect(MARKET_HOURS_MS).toBe(60_000);
  });

  it("backs off to the off-hours interval when the market is closed", () => {
    expect(planNextTick(tueEveningEt, true)).toEqual({ fetch: true, delayMs: OFF_HOURS_MS });
  });

  it("does not fetch while the window is hidden, even during market hours", () => {
    expect(planNextTick(tueMidMorningEt, false)).toEqual({ fetch: false, delayMs: HIDDEN_RECHECK_MS });
  });

  it("does not fetch while the window is hidden outside market hours", () => {
    expect(planNextTick(tueEveningEt, false)).toEqual({ fetch: false, delayMs: HIDDEN_RECHECK_MS });
  });
});
