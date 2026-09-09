import { useEffect, useRef } from "react";
import { useRefreshPrices } from "./useRefresh";
import { planNextTick } from "./refreshSchedule";

function windowIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Refresh prices on a self-adjusting timer: see `refreshSchedule.ts` for the
 * cadence. The next tick is scheduled only after the current refresh settles,
 * so slow network responses never cause overlapping calls. Hiding the window
 * pauses fetching, and showing it again refreshes straight away so the figure
 * on screen is never stale when you look at it.
 */
export function usePriceAutoRefresh() {
  const refresh = useRefreshPrices();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    function schedule(delayMs: number) {
      if (cancelled) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(tick, delayMs);
    }

    async function tick() {
      if (cancelled) return;
      const plan = planNextTick(new Date(), windowIsVisible());
      if (plan.fetch) {
        try {
          await refresh.mutateAsync();
        } catch {
          // Ignore transient failures (offline, rate-limit) and keep polling.
        }
      }
      schedule(plan.delayMs);
    }

    function onVisibilityChange() {
      // Coming back to the window: refresh now rather than waiting out the timer.
      if (windowIsVisible()) schedule(0);
    }

    // Kick off shortly after mount so the first paint isn't blocked.
    schedule(1_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // refresh.mutateAsync is stable for the component's lifetime; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
