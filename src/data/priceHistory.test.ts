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

  it("asks for enough history to make the risk maths meaningful", () => {
    // Beta and volatility on a handful of points are noise dressed as numbers.
    expect(MIN_HISTORY_DAYS).toBeGreaterThanOrEqual(60);
  });
});
