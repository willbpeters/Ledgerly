/** How often a visible window syncs with the other computer. */
export const DEVICE_SYNC_EVERY_MS = 30_000;

export interface DeviceSyncMoment {
  enabled: boolean;
  visible: boolean;
  /** What woke the loop: its timer, or the window being hidden or shown. */
  reason: "timer" | "hidden" | "shown";
}

/** Whether to sync now, and when to look again. Pure, so it is tested. */
export function planDeviceSync(m: DeviceSyncMoment): { sync: boolean; delayMs: number } {
  if (!m.enabled) return { sync: false, delayMs: DEVICE_SYNC_EVERY_MS };
  const sync = m.reason === "timer" ? m.visible : true;
  return { sync, delayMs: DEVICE_SYNC_EVERY_MS };
}
