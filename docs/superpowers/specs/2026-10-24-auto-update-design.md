# Installed app with auto-updates — design

**Date:** 2026-10-24 · **Status:** agreed with the owner (two decisions)

## The ask

> I would like to build an exe that can receive updates so when I make changes
> on GitHub, it will automatically pull new updates and stuff when I decide to
> push a new update. … I'm kind of tired of using the command line launcher.

Today Ledgerly is started by `scripts/start-ledgerly.cmd`, which runs
`npm run tauri dev` in a console window. The goal is a normal installed app
that updates itself from GitHub, only when the owner decides to release.

## Decisions

1. **A release happens when the owner clicks a button**, not on every push.
   Pushing to `master` never changes the installed app.
2. **The app asks before installing.** No silent updates.

## Releasing (GitHub)

- A GitHub Actions workflow, `.github/workflows/release.yml`, started by hand
  (`workflow_dispatch`) with one input: the version, e.g. `0.2.0`.
- It runs on `windows-latest` and:
  1. refuses a version that isn't `X.Y.Z` or that already has a tag;
  2. writes the version into `package.json`, `src-tauri/tauri.conf.json` and
     `src-tauri/Cargo.toml` (`scripts/set-version.mjs`, so it can also be run
     and tested locally), commits `chore(release): vX.Y.Z` to `master` and tags
     `vX.Y.Z`;
  3. builds with `tauri-apps/tauri-action`, which signs the update and publishes
     a GitHub Release holding the NSIS installer, its `.sig`, and `latest.json`.
- Only the NSIS (`-setup.exe`) installer is built for releases; the `.msi`
  adds build time and the updater doesn't need it.
- The repo is public, so the app reads releases without signing in. Nothing
  personal is in a release: the database lives in `%APPDATA%\com.ledgerly.app\`.

## Signing key

- Tauri refuses unsigned updates. A key pair is made once with
  `npx tauri signer generate`, stored at `%USERPROFILE%\.tauri\ledgerly.key`
  (outside the repo, never committed).
- The **public** key goes in `tauri.conf.json` (`plugins.updater.pubkey`).
- The **private** key and its password go in the repo's GitHub secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The
  owner pastes these; Claude never enters secrets into GitHub.
- The owner keeps a backup copy (e.g. a password manager). If it is lost,
  installed copies can't accept updates; a new key means one manual reinstall.

## Updating (the app)

- Rust: `tauri-plugin-updater` and `tauri-plugin-process` (for relaunch),
  registered in `lib.rs`; permissions `updater:default`, `process:allow-restart`.
  Config: endpoint
  `https://github.com/willbpeters/Ledgerly/releases/latest/download/latest.json`,
  `windows.installMode: "passive"` (a progress bar, no wizard).
- npm packages `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process`,
  pinned to their crates' major.minor (see HANDOFF: `tauri build` refuses a mismatch).
- Front end: `src/app/UpdateBanner.tsx`, shown at the top of the workspace in
  `AppShell`. On mount it calls `check()` once.
  - Update found → "Version 0.2.0 is ready." with **Install and restart** and
    **Later**. Later hides it until the next launch.
  - Installing → "Downloading… 40%", buttons disabled; then `relaunch()`.
  - Install fails → "The update didn't install: <message>" with **Try again**.
  - No update, offline, or GitHub unreachable → nothing shown.
  - Skipped entirely in test mode (`import.meta.env.DEV`).
- Updater calls sit behind a small module (`src/data/updater.ts`) so the
  banner can be tested with a fake.
- The daily launch backup and any database migration run as they already do,
  when the new version starts. Data is never touched by the installer.

## Install and shortcuts

- The NSIS installer installs per-user (no admin prompt) and adds a Start Menu
  and Desktop shortcut named **Ledgerly**.
- First install shows SmartScreen's "Windows protected your PC" (no paid code
  signing certificate): *More info → Run anyway*. Smart App Control is already
  off on this machine (HANDOFF).
- `start-ledgerly.cmd` and its "Ledgerly (test)" shortcut stay, for trying
  unreleased work. Both share one database, so they shouldn't run at once.

## Testing

- `UpdateBanner.test.tsx`: update found, Later, install progress then relaunch,
  install error with Try again, no update, check throws (offline) → nothing.
- `scripts/set-version` test: writes all three files, rejects a bad version.
- End to end, once: release `0.1.1`, install it from the Release page; release
  `0.1.2`; reopen Ledgerly, see the banner, install, confirm it says 0.1.2.

## Not doing

- Paid Windows code signing, macOS/Linux builds, release notes beyond the
  commit list, update channels (beta/stable).
