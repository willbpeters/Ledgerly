import { describe, it, expect, beforeEach } from "vitest";
import { loadPref, savePref, resolve, applyTheme } from "./theme";

describe("theme preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to light when nothing is stored or the stored value is junk", () => {
    expect(loadPref()).toBe("light");
    localStorage.setItem("ledgerly.theme", "purple");
    expect(loadPref()).toBe("light");
  });

  it("round-trips a saved preference", () => {
    savePref("dark");
    expect(loadPref()).toBe("dark");
  });

  it("resolves system from the OS preference and explicit values as-is", () => {
    expect(resolve("system", true)).toBe("dark");
    expect(resolve("system", false)).toBe("light");
    expect(resolve("light", true)).toBe("light");
    expect(resolve("dark", false)).toBe("dark");
  });

  it("applies the resolved theme to the html element", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
