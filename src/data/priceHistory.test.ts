import { describe, it, expect } from "vitest";
import { shouldBackfill, MIN_HISTORY_DAYS } from "./priceHistory";

describe("shouldBackfill", () => {
  it("waits while the depth is still unknown", () => {
    // Backfilling on an undefined answer would re-download on every launch.
    expect(shouldBackfill(undefined)).toBe(false);
  });

  it("backfills a database that has never had history", () => {
    expect(shouldBackfill(0)).toBe(true);
  });

  it("backfills when only the day-change closes are held", () => {
    expect(shouldBackfill(2)).toBe(true);
  });

  it("leaves a database that already has history alone", () => {
    expect(shouldBackfill(MIN_HISTORY_DAYS)).toBe(false);
    expect(shouldBackfill(500)).toBe(false);
  });

  it("backfills again when a newly synced holding has no history", () => {
    // Depth is the least-covered holding, so a new account drops it to 0 even
    // though everything else already has years.
    expect(shouldBackfill(0, null)).toBe(true);
  });

  it("does not retry a depth it has already tried, so a ticker Yahoo cannot price does not loop", () => {
    expect(shouldBackfill(1, 1)).toBe(false);
  });

  it("tries again once the depth has changed since the last try", () => {
    expect(shouldBackfill(0, 507)).toBe(true);
  });

  it("asks for enough history to make the risk maths meaningful", () => {
    // Beta and volatility on a handful of points are noise dressed as numbers.
    expect(MIN_HISTORY_DAYS).toBeGreaterThanOrEqual(60);
  });
});
