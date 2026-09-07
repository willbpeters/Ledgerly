# Ledgerly

A local-first personal **investment tracker** for Windows, packaged as a small
desktop app. Track brokerage and cash accounts, stock/ETF holdings with
lot-level cost basis, gains, and allocation — with all data stored locally on
your machine.

Built with **Tauri v2 + React + TypeScript + SQLite**. Prices are fetched
keyless from a free public source; you can also enter them by hand. Spending /
budgeting is a planned later module.

## Requirements (one-time)

- [Node.js](https://nodejs.org) (LTS)
- [Rust](https://rustup.rs) + the Microsoft C++ Build Tools ("Desktop
  development with C++")
- Windows 11 (WebView2 is built in)

> Note: building/running a self-compiled desktop app requires Windows **Smart
> App Control** to be off.

## Develop

```bash
npm install
npm run tauri dev     # run the app in development
npm test              # TypeScript domain/UI tests (Vitest)
cd src-tauri && cargo test   # Rust core tests
```

## Build the installer

```bash
npm run tauri build
```

Produces `Ledgerly_<version>_x64-setup.exe` (and an `.msi`) under
`src-tauri/target/release/bundle/`.

## Where your data lives

A local SQLite database at `%APPDATA%\com.ledgerly.app\finance.sqlite`. It is
not encrypted in this version (encryption + app lock are planned).

## Docs

- Design spec: `docs/superpowers/specs/2026-09-04-investments-tracker-design.md`
- Implementation plan: `docs/superpowers/plans/2026-09-04-investments-tracker.md`
