import { describe, it, expect } from "vitest";
import { planNextMarketTick, NEWS_MARKET_HOURS_MS, NEWS_OFF_HOURS_MS, HIDDEN_RECHECK_MS } from "./marketSchedule";

// 2026-09-10 is a Thursday. 14:00 UTC is 10:00 in New York — market open.
const open = new Date("2026-09-10T14:00:00Z");
const closed = new Date("2026-09-10T23:00:00Z");

describe("planNextMarketTick", () => {
  it("does not fetch while the window is hidden", () => {
    const tick = planNextMarketTick(open, false, null);
    expect(tick.fetch).toBe(false);
    expect(tick.delayMs).toBe(HIDDEN_RECHECK_MS);
  });

  it("polls every 30 minutes while the market is open", () => {
    expect(planNextMarketTick(open, true, null).delayMs).toBe(NEWS_MARKET_HOURS_MS);
  });

  it("backs off to two hours outside market hours", () => {
    expect(planNextMarketTick(closed, true, null).delayMs).toBe(NEWS_OFF_HOURS_MS);
  });

  it("fetches immediately when nothing has ever been fetched", () => {
    expect(planNextMarketTick(open, true, null).fetch).toBe(true);
  });

  it("skips a fetch when the cache is younger than the interval", () => {
    const justNow = new Date(open.getTime() - 60_000).toISOString();
    expect(planNextMarketTick(open, true, justNow).fetch).toBe(false);
  });

  it("fetches once the cache is older than the interval", () => {
    const stale = new Date(open.getTime() - 31 * 60_000).toISOString();
    expect(planNextMarketTick(open, true, stale).fetch).toBe(true);
  });

  it("treats an unparseable timestamp as no cache at all", () => {
    expect(planNextMarketTick(open, true, "not a date").fetch).toBe(true);
  });
});
