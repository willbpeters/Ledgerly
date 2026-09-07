import { useEffect, useRef } from "react";
import { useRefreshPrices } from "./useRefresh";

// How often to refresh prices. During US market hours we poll quickly; outside
// them, prices don't move, so we back off. Tune these if Yahoo rate-limits.
const MARKET_HOURS_MS = 5_000;       // ~5s while the market is open
const OFF_HOURS_MS = 15 * 60_000;    // 15 min otherwise

/** True during regular US market hours (Mon-Fri, 09:30-16:00 America/New_York). */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  // Convert "now" to Eastern Time wall-clock, regardless of the machine's tz.
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function nextIntervalMs(): number {
  return isUsMarketOpen() ? MARKET_HOURS_MS : OFF_HOURS_MS;
}

/**
 * Refresh prices on a self-adjusting timer: fast during market hours, slow
 * otherwise. The next tick is scheduled only after the current refresh settles,
 * so slow network responses never cause overlapping calls.
 */
export function usePriceAutoRefresh() {
  const refresh = useRefreshPrices();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        await refresh.mutateAsync();
      } catch {
        // Ignore transient failures (offline, rate-limit) and keep polling.
      }
      if (cancelled) return;
      timer.current = setTimeout(tick, nextIntervalMs());
    }

    // Kick off shortly after mount so the first paint isn't blocked.
    timer.current = setTimeout(tick, 1_000);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // refresh.mutateAsync is stable for the component's lifetime; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
