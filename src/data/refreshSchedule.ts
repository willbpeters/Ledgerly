/**
 * When to refresh prices, as a pure decision so it can be tested without timers.
 *
 * Each refresh fetches every security from Yahoo one at a time, so the interval
 * is also a politeness budget: a 20-holding portfolio at the old 5s interval was
 * making ~240 requests a minute, which invites a rate-limit. Once a minute is
 * plenty for a net-worth figure, and we stop entirely while the window is hidden.
 */

export const MARKET_HOURS_MS = 60_000;        // once a minute while the market is open
export const OFF_HOURS_MS = 15 * 60_000;      // 15 min otherwise — prices aren't moving
export const HIDDEN_RECHECK_MS = 60_000;      // how soon to look again once hidden

/** True during regular US market hours (Mon-Fri, 09:30-16:00 America/New_York). */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  // Convert "now" to Eastern Time wall-clock, regardless of the machine's tz.
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export interface Tick {
  /** Whether to actually fetch prices on this tick. */
  fetch: boolean;
  /** How long to wait before the next tick. */
  delayMs: number;
}

/**
 * Decide what the refresh timer should do right now. A hidden window never
 * fetches — nobody is looking at the number, and the app may sit in the tray
 * for hours.
 */
export function planNextTick(now: Date, visible: boolean): Tick {
  if (!visible) return { fetch: false, delayMs: HIDDEN_RECHECK_MS };
  return { fetch: true, delayMs: isUsMarketOpen(now) ? MARKET_HOURS_MS : OFF_HOURS_MS };
}
