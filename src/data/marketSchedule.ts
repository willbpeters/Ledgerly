/**
 * When to refresh news and earnings, as a pure decision so it can be tested
 * without timers — the same shape as `refreshSchedule.ts`.
 *
 * This is a politeness budget as much as a freshness one. Each refresh makes
 * one RSS request per held company, sequentially. Six companies every 30
 * minutes is 12 requests an hour, against the ~660 an hour the price refresh
 * already makes. Shortening this interval multiplies by the number of
 * holdings, which is exactly how Stooq was lost.
 */
import { isUsMarketOpen } from "./refreshSchedule";

export const NEWS_MARKET_HOURS_MS = 30 * 60_000;
export const NEWS_OFF_HOURS_MS = 2 * 60 * 60_000;
export const HIDDEN_RECHECK_MS = 5 * 60_000;

export interface MarketTick {
  fetch: boolean;
  delayMs: number;
}

/**
 * `lastFetchedAt` is the newest cached fetch time, or null when nothing has
 * been fetched. Checking it means reopening the screen does not trigger a
 * fetch when the cache is still warm.
 */
export function planNextMarketTick(
  now: Date,
  visible: boolean,
  lastFetchedAt: string | null,
): MarketTick {
  if (!visible) return { fetch: false, delayMs: HIDDEN_RECHECK_MS };
  const delayMs = isUsMarketOpen(now) ? NEWS_MARKET_HOURS_MS : NEWS_OFF_HOURS_MS;
  const age = lastFetchedAt ? now.getTime() - Date.parse(lastFetchedAt) : NaN;
  const fetch = Number.isNaN(age) || age >= delayMs;
  return { fetch, delayMs };
}
