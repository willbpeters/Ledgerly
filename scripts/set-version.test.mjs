import { describe, it, expect } from "vitest";
import { isVersion, bumpJson, bumpPackageLock, bumpCargoToml, bumpCargoLock } from "./set-version.mjs";

describe("set-version", () => {
  it("accepts X.Y.Z only", () => {
    expect(isVersion("0.2.0")).toBe(true);
    expect(isVersion("10.0.12")).toBe(true);
    for (const bad of ["0.2", "v0.2.0", "0.2.0-beta", " 0.2.0", ""]) expect(isVersion(bad)).toBe(false);
  });

  it("bumps a JSON file's top-level version, keeping 2-space indent and a final newline", () => {
    expect(bumpJson('{\n  "name": "x",\n  "version": "0.1.0"\n}\n', "0.2.0"))
      .toBe('{\n  "name": "x",\n  "version": "0.2.0"\n}\n');
  });

  it("bumps package-lock's top level and root package", () => {
    const lock = { version: "0.1.0", packages: { "": { version: "0.1.0" }, "node_modules/a": { version: "9.9.9" } } };
    const out = JSON.parse(bumpPackageLock(JSON.stringify(lock), "0.2.0"));
    expect(out.version).toBe("0.2.0");
    expect(out.packages[""].version).toBe("0.2.0");
    expect(out.packages["node_modules/a"].version).toBe("9.9.9");
  });

  it("bumps only the [package] version in Cargo.toml", () => {
    const toml = '[package]\nname = "ledgerly"\nversion = "0.1.0"\n\n[dependencies]\nfoo = { version = "1" }\n';
    expect(bumpCargoToml(toml, "0.2.0")).toBe(toml.replace('version = "0.1.0"', 'version = "0.2.0"'));
  });

  it("bumps only ledgerly's entry in Cargo.lock", () => {
    const lock = '[[package]]\nname = "itoa"\nversion = "0.1.0"\n\n[[package]]\nname = "ledgerly"\nversion = "0.1.0"\n';
    expect(bumpCargoLock(lock, "0.2.0"))
      .toBe('[[package]]\nname = "itoa"\nversion = "0.1.0"\n\n[[package]]\nname = "ledgerly"\nversion = "0.2.0"\n');
  });
});
