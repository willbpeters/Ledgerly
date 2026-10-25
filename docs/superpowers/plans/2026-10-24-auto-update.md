# Installed app with auto-updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Release button on GitHub builds a signed Windows installer, and the installed Ledgerly offers to update itself on launch.

**Architecture:** A hand-started GitHub Actions workflow bumps the version (`scripts/set-version.mjs`), builds with `tauri-action` into a draft release, then commits, tags and publishes it. The app uses Tauri's updater plugin against `releases/latest/download/latest.json`; `UpdateBanner` in `AppShell` checks once on launch and installs on request.

**Tech Stack:** Tauri 2 (`tauri-plugin-updater`, `tauri-plugin-process`), React 19, Vitest + Testing Library, GitHub Actions (`tauri-apps/tauri-action@v0`).

Spec: `docs/superpowers/specs/2026-10-24-auto-update-design.md`.

## Files

- Create `scripts/set-version.mjs` — pure version-bump functions + CLI.
- Create `scripts/set-version.test.mjs` — tests for it.
- Create `src-tauri/tauri.release.conf.json` — release-only config (NSIS only, updater artifacts). Kept out of `tauri.conf.json` so a plain local `npm run tauri build` still works without the signing key.
- Create `.github/workflows/release.yml`.
- Create `src/data/updater.ts` — thin wrapper over the plugins (`Updater` interface).
- Create `src/app/UpdateBanner.tsx` + `src/app/UpdateBanner.test.tsx`.
- Modify `src-tauri/Cargo.toml`, `package.json`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json`, `src/app/AppShell.tsx`, `src/styles.css`, `docs/HANDOFF.md`.

### Task 1: Version script

- [ ] **Step 1: Write the failing test** — `scripts/set-version.test.mjs`:

```js
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
    const out = JSON.parse(bumpPackageLock(JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" }, "node_modules/a": { version: "9.9.9" } } }), "0.2.0"));
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
    expect(bumpCargoLock(lock, "0.2.0")).toBe('[[package]]\nname = "itoa"\nversion = "0.1.0"\n\n[[package]]\nname = "ledgerly"\nversion = "0.2.0"\n');
  });
});
```

- [ ] **Step 2:** `npx vitest run scripts/set-version.test.mjs` → FAIL (module not found).
- [ ] **Step 3: Implement** — `scripts/set-version.mjs`:

```js
// Writes one version into every file that carries Ledgerly's version.
// Usage: node scripts/set-version.mjs 0.2.0   (the Release workflow runs this)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(v);

const stringify = (obj) => JSON.stringify(obj, null, 2) + "\n";

export function bumpJson(text, version) {
  return stringify({ ...JSON.parse(text), version });
}

export function bumpPackageLock(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  return stringify(lock);
}

// The first `version = ` line is the [package] one; dependency versions are inline tables.
export function bumpCargoToml(text, version) {
  return text.replace(/^version = ".*"$/m, `version = "${version}"`);
}

export function bumpCargoLock(text, version) {
  return text.replace(/(name = "ledgerly"\r?\nversion = )".*"/, `$1"${version}"`);
}

const FILES = [
  ["package.json", bumpJson],
  ["package-lock.json", bumpPackageLock],
  ["src-tauri/tauri.conf.json", bumpJson],
  ["src-tauri/Cargo.toml", bumpCargoToml],
  ["src-tauri/Cargo.lock", bumpCargoLock],
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = process.argv[2] ?? "";
  if (!isVersion(version)) {
    console.error(`"${version}" isn't a version. Use three numbers, like 0.2.0.`);
    process.exit(1);
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const [file, bump] of FILES) {
    const path = root + file;
    writeFileSync(path, bump(readFileSync(path, "utf8"), version));
  }
  console.log(`Ledgerly is now version ${version}.`);
}
```

- [ ] **Step 4:** re-run the test → PASS. Also `node scripts/set-version.mjs 0.2` → exits 1 with the message.
- [ ] **Step 5:** commit `feat(release): a script that sets the version everywhere`.

### Task 2: Updater plugins and config

- [ ] **Step 1:** `cargo add tauri-plugin-updater tauri-plugin-process` in `src-tauri` (with `%USERPROFILE%\.cargo\bin` on PATH). Check `Cargo.lock`: if the `tauri` crate moved minor, bump `@tauri-apps/api` to match.
- [ ] **Step 2:** `npm install @tauri-apps/plugin-updater@~<crate major.minor> @tauri-apps/plugin-process@~<crate major.minor>` — each pinned to its crate's major.minor (HANDOFF rule).
- [ ] **Step 3:** `lib.rs`, after the dialog plugin:

```rust
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 4:** capabilities: add `"updater:default"`, `"process:allow-restart"`.
- [ ] **Step 5:** `tauri.conf.json`: add

```json
  "plugins": {
    "updater": {
      "pubkey": "<filled in Task 5>",
      "endpoints": ["https://github.com/willbpeters/Ledgerly/releases/latest/download/latest.json"],
      "windows": { "installMode": "passive" }
    }
  }
```

and under `bundle`: `"windows": { "nsis": { "installMode": "currentUser" } }`.

- [ ] **Step 6:** `src-tauri/tauri.release.conf.json`:

```json
{
  "bundle": { "targets": ["nsis"], "createUpdaterArtifacts": true }
}
```

- [ ] **Step 7:** `cargo check` in `src-tauri` passes; commit `feat(updater): updater and process plugins`.

### Task 3: Update banner

- [ ] **Step 1: Write the failing test** — `src/app/UpdateBanner.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UpdateBanner } from "./UpdateBanner";
import type { AvailableUpdate, Updater } from "../data/updater";

function fake(update: Partial<AvailableUpdate> | null, opts: { checkFails?: boolean } = {}) {
  const relaunch = vi.fn(async () => {});
  const install = vi.fn(async (onProgress: (pct: number | null) => void) => { onProgress(40); });
  const updater: Updater = {
    check: vi.fn(async () => {
      if (opts.checkFails) throw new Error("offline");
      return update && { version: "0.2.0", install, ...update };
    }),
    relaunch,
  };
  return { updater, relaunch, install };
}

describe("UpdateBanner", () => {
  it("offers a found update", async () => {
    render(<UpdateBanner updater={fake({}).updater} enabled />);
    expect(await screen.findByText("Version 0.2.0 is ready.")).toBeInTheDocument();
  });

  it("Later hides it", async () => {
    render(<UpdateBanner updater={fake({}).updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText("Version 0.2.0 is ready.")).toBeNull();
  });

  it("installs, then relaunches", async () => {
    const f = fake({});
    render(<UpdateBanner updater={f.updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    await waitFor(() => expect(f.relaunch).toHaveBeenCalledTimes(1));
    expect(f.install).toHaveBeenCalledTimes(1);
  });

  it("shows progress while installing", async () => {
    let finish!: () => void;
    const install = vi.fn((onProgress: (pct: number | null) => void) => {
      onProgress(40);
      return new Promise<void>((r) => { finish = r; });
    });
    render(<UpdateBanner updater={fake({ install }).updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("Downloading… 40%")).toBeInTheDocument();
    finish();
  });

  it("shows a failed install with Try again", async () => {
    const install = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    const f = fake({ install });
    render(<UpdateBanner updater={f.updater} enabled />);
    fireEvent.click(await screen.findByRole("button", { name: "Install and restart" }));
    expect(await screen.findByText("The update didn't install: disk full")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(f.relaunch).toHaveBeenCalledTimes(1));
  });

  it("shows nothing with no update, when offline, or when disabled", async () => {
    const none = fake(null), offline = fake({}, { checkFails: true }), off = fake({});
    const { container: a } = render(<UpdateBanner updater={none.updater} enabled />);
    const { container: b } = render(<UpdateBanner updater={offline.updater} enabled />);
    const { container: c } = render(<UpdateBanner updater={off.updater} enabled={false} />);
    await waitFor(() => expect(none.updater.check).toHaveBeenCalled());
    await waitFor(() => expect(offline.updater.check).toHaveBeenCalled());
    expect(a).toBeEmptyDOMElement();
    expect(b).toBeEmptyDOMElement();
    expect(c).toBeEmptyDOMElement();
    expect(off.updater.check).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2:** `npx vitest run src/app/UpdateBanner.test.tsx` → FAIL (module not found).
- [ ] **Step 3:** `src/data/updater.ts`:

```ts
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type AvailableUpdate = {
  version: string;
  /** Downloads and installs; reports percent done, or null when the size is unknown. */
  install: (onProgress: (pct: number | null) => void) => Promise<void>;
};

export type Updater = {
  check: () => Promise<AvailableUpdate | null>;
  relaunch: () => Promise<void>;
};

export const updater: Updater = {
  async check() {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async (onProgress) => {
        let total = 0;
        let received = 0;
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          if (event.event === "Progress") {
            received += event.data.chunkLength;
            onProgress(total ? Math.min(100, Math.round((received / total) * 100)) : null);
          }
        });
      },
    };
  },
  relaunch,
};
```

- [ ] **Step 4:** `src/app/UpdateBanner.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Button } from "../ui/components";
import { updater as realUpdater, type AvailableUpdate, type Updater } from "../data/updater";

type State =
  | { kind: "none" }
  | { kind: "ready"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate; pct: number | null }
  | { kind: "failed"; update: AvailableUpdate; message: string };

// Checks GitHub once per launch. Test mode (npm run tauri dev) never checks:
// it already runs the newest code.
export function UpdateBanner({ updater = realUpdater, enabled = !import.meta.env.DEV }:
  { updater?: Updater; enabled?: boolean }) {
  const [state, setState] = useState<State>({ kind: "none" });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    updater.check()
      .then((update) => { if (live && update) setState({ kind: "ready", update }); })
      .catch(() => { /* offline or GitHub unreachable: try again next launch */ });
    return () => { live = false; };
  }, [enabled, updater]);

  if (state.kind === "none") return null;
  const { update } = state;

  async function install() {
    setState({ kind: "installing", update, pct: null });
    try {
      await update.install((pct) => setState({ kind: "installing", update, pct }));
      await updater.relaunch();
    } catch (e) {
      setState({ kind: "failed", update, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className={`notice ${state.kind === "failed" ? "neg" : "info"} update-banner`} role="status">
      <span className="update-banner-text">
        {state.kind === "ready" && `Version ${update.version} is ready.`}
        {state.kind === "installing" && (state.pct === null ? "Downloading…" : `Downloading… ${state.pct}%`)}
        {state.kind === "failed" && `The update didn't install: ${state.message}`}
      </span>
      {state.kind === "ready" && <>
        <Button size="sm" onClick={install}>Install and restart</Button>
        <Button size="sm" variant="ghost" onClick={() => setState({ kind: "none" })}>Later</Button>
      </>}
      {state.kind === "installing" && <Button size="sm" disabled loading>Installing</Button>}
      {state.kind === "failed" && <>
        <Button size="sm" onClick={install}>Try again</Button>
        <Button size="sm" variant="ghost" onClick={() => setState({ kind: "none" })}>Later</Button>
      </>}
    </div>
  );
}
```

- [ ] **Step 5:** `styles.css`, after `.notice.info`:

```css
.update-banner { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
.update-banner-text { flex: 1; }
```

- [ ] **Step 6:** `AppShell.tsx`: render `<UpdateBanner />` inside `.page`, before the `ErrorBoundary`.
- [ ] **Step 7:** `npm test` and `npm run build` pass; commit `feat(updater): offer a new version on launch`.

### Task 4: Release workflow

- [ ] **Step 1:** `.github/workflows/release.yml`:

```yaml
# Actions → Release → Run workflow, with a version like 0.2.0.
# Builds the Windows installer, signs the update, and publishes a GitHub Release
# that installed copies of Ledgerly offer on their next launch.
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: "New version, three numbers like 0.2.0"
        required: true

permissions:
  contents: write

concurrency: release

jobs:
  release:
    runs-on: windows-latest
    env:
      VERSION: ${{ inputs.version }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Refuse a version that's already released
        shell: bash
        run: |
          if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
            echo "::error::v$VERSION already exists. Pick a higher version."
            exit 1
          fi

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - uses: dtolnay/rust-toolchain@stable

      - uses: swatinem/rust-cache@v2
        with:
          workspaces: "src-tauri -> target"

      - run: npm ci
      - run: npm test

      - name: Set the version
        run: node scripts/set-version.mjs "$env:VERSION"

      # Builds into a draft, so a failed build never leaves a half-made release
      # that installed copies would try to download.
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: v${{ inputs.version }}
          releaseName: Ledgerly v${{ inputs.version }}
          releaseBody: "Install Ledgerly_${{ inputs.version }}_x64-setup.exe below. Already installed? Ledgerly offers this update when it opens."
          releaseDraft: true
          args: --config src-tauri/tauri.release.conf.json

      - name: Commit, tag and publish
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -am "chore(release): v$VERSION"
          git tag "v$VERSION"
          git push origin "HEAD:${GITHUB_REF_NAME}" "v$VERSION"
          gh release edit "v$VERSION" --draft=false --latest
```

- [ ] **Step 2:** commit `ci: a Release button that builds and publishes an update`.

### Task 5: Signing key (owner pastes the secret)

- [ ] **Step 1:** `npx tauri signer generate --ci -w "$USERPROFILE/.tauri/ledgerly.key"` (no password: one secret to paste; the file stays in the owner's profile).
- [ ] **Step 2:** copy the contents of `ledgerly.key.pub` into `plugins.updater.pubkey`; commit `feat(updater): Ledgerly's update signing key (public half)`.
- [ ] **Step 3:** the owner adds repo secret `TAURI_SIGNING_PRIVATE_KEY` = contents of `%USERPROFILE%\.tauri\ledgerly.key` (Settings → Secrets and variables → Actions → New repository secret), and backs the file up.
- [ ] **Step 4:** local proof: with `TAURI_SIGNING_PRIVATE_KEY` set from the file, `npx tauri build --config src-tauri/tauri.release.conf.json` produces `bundle/nsis/Ledgerly_0.1.0_x64-setup.exe` and `.exe.sig`.

### Task 6: Docs, push, end-to-end

- [ ] **Step 1:** HANDOFF: a "Releasing" section (button, version rules, the key and its backup, SmartScreen on first install, don't run test and installed at once); update the Build line.
- [ ] **Step 2:** commit, push `master`.
- [ ] **Step 3:** owner runs Release `0.1.1`; installs from the Release page.
- [ ] **Step 4:** owner runs Release `0.1.2`; opens Ledgerly → banner → Install and restart → Windows "Installed apps" shows 0.1.2.
