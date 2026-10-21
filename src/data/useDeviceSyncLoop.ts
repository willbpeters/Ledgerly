import { useEffect, useRef } from "react";
import { api } from "./api";
import { useDeviceSyncNow } from "./queries";
import { planDeviceSync, type DeviceSyncMoment } from "./deviceSyncSchedule";

function windowIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Sync with the other computer at launch, every 30 seconds while the window
 * is visible, as it hides and as it shows again. See `deviceSyncSchedule.ts`.
 * The next tick is scheduled only after a round settles, so rounds never overlap.
 */
export function useDeviceSyncLoop() {
  const syncNow = useDeviceSyncNow();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function wake(reason: DeviceSyncMoment["reason"]) {
      if (cancelled) return;
      let enabled = false;
      try {
        enabled = (await api.deviceSync.status()).enabled;
      } catch {
        // Status unreadable: treat as off and look again later.
      }
      const plan = planDeviceSync({ enabled, visible: windowIsVisible(), reason });
      if (plan.sync) {
        try {
          await syncNow.mutateAsync();
        } catch {
          // Offline or the folder is unavailable: the card shows the error; keep going.
        }
      }
      if (cancelled) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => wake("timer"), plan.delayMs);
    }

    function onVisibilityChange() {
      wake(windowIsVisible() ? "shown" : "hidden");
    }

    timer.current = setTimeout(() => wake("timer"), 2_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // syncNow.mutateAsync is stable for the component's lifetime; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
