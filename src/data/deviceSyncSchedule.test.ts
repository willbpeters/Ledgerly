import { describe, it, expect } from "vitest";
import { planDeviceSync, DEVICE_SYNC_EVERY_MS } from "./deviceSyncSchedule";

describe("planDeviceSync", () => {
  it("does nothing while sync is off, checking again later", () => {
    expect(planDeviceSync({ enabled: false, visible: true, reason: "timer" })).toEqual({ sync: false, delayMs: DEVICE_SYNC_EVERY_MS });
  });

  it("syncs on the timer while the window is visible", () => {
    expect(planDeviceSync({ enabled: true, visible: true, reason: "timer" })).toEqual({ sync: true, delayMs: DEVICE_SYNC_EVERY_MS });
  });

  it("skips timer ticks while hidden", () => {
    expect(planDeviceSync({ enabled: true, visible: false, reason: "timer" }).sync).toBe(false);
  });

  it("syncs as the window hides, so edits leave before the laptop lid closes", () => {
    expect(planDeviceSync({ enabled: true, visible: false, reason: "hidden" }).sync).toBe(true);
  });

  it("syncs straight away on showing the window again", () => {
    expect(planDeviceSync({ enabled: true, visible: true, reason: "shown" }).sync).toBe(true);
  });
});
