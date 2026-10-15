import { describe, it, expect } from "vitest";
import { kindLabel, formatBytes, whenLabel } from "./backup";

describe("backup labels", () => {
  it("names each kind in plain English", () => {
    expect(kindLabel("daily")).toBe("Daily");
    expect(kindLabel("pre-migration")).toBe("Before an update");
    expect(kindLabel("pre-restore")).toBe("Before a restore");
    expect(kindLabel("manual")).toBe("Manual");
  });

  it("sizes files in B, KB and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("says today and yesterday, and dates anything older", () => {
    expect(whenLabel("2026-10-14", "09:30:12", "2026-10-14")).toBe("Today, 09:30");
    expect(whenLabel("2026-10-13", "18:04:00", "2026-10-14")).toBe("Yesterday, 18:04");
    expect(whenLabel("2026-10-02", "07:15:00", "2026-10-14")).toBe("2 Oct 2026, 07:15");
  });

  it("knows yesterday across a month boundary", () => {
    expect(whenLabel("2026-10-31", "23:00:00", "2026-11-01")).toBe("Yesterday, 23:00");
  });
});
