import { describe, it, expect, beforeEach } from "vitest";
import { loadPref, savePref, resolve, applyTheme } from "./theme";

describe("theme preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to system when nothing is stored or stored value is junk", () => {
    expect(loadPref()).toBe("system");
    localStorage.setItem("ledgerly.theme", "purple");
    expect(loadPref()).toBe("system");
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
