<img src="app-icon.svg" alt="Tally logo" width="96" height="96">

# Tally

**A private, local-first personal finance app for Windows.** Tally brings your
investments and your everyday spending into one desktop app, and keeps all of
it on your own computer. There are no accounts, no cloud and no subscription.

[![Latest release](https://img.shields.io/github/v/release/willbpeters/Tally?label=release)](https://github.com/willbpeters/Tally/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-informational)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB)

> Tally was called **Ledgerly** until version 0.1.3.

---

## Contents

- [Features](#features)
- [Privacy](#privacy)
- [Install](#install)
- [Updates](#updates)
- [Your data and backups](#your-data-and-backups)
- [Development](#development)
- [Releasing a new version](#releasing-a-new-version)
- [Project structure](#project-structure)
- [Documentation](#documentation)

## Features

**Dashboard**
- Net worth over time, with tabs for investments, cash and liabilities
- Every account at a glance, grouped by type
- The last seven days of activity

**Investments**
- Holdings with lot-level cost basis, gains and allocation
- Risk figures measured against the S&P 500: beta, alpha, R², volatility,
  concentration, and drawdown from the high
- Prices refreshed automatically during market hours, or entered by hand

**Markets**
- A "Today" board covering the major indices, the VIX and Treasury yields,
  each with a one-month sparkline
- Heatmaps of the S&P sectors and of your own stocks, coloured by today's move
- Headlines for the companies you hold, and upcoming earnings dates

**Spending and budgets**
- Monthly budgets for each category, with progress and what's left
- Transactions sorted automatically by merchant, with transfers between your
  own accounts matched up
- A "To review" list for anything new, and rules that learn from your choices
- Undo after every change
- A one-time import of your history and categories from Copilot

**Bank sync**
- Balances, holdings and transactions from your banks and brokerages through
  [SimpleFIN](https://www.simplefin.org/)

**Safety**
- An automatic backup each day you open the app, keeping the last 14, plus one
  before any database upgrade, before any restore, and whenever you click
  "Back up now"
- An optional second backup folder, such as a USB drive or a synced folder
- One-click restore, and export of everything to CSV

## Privacy

- **Your financial data never leaves your computer.** It lives in a local
  SQLite database, not on a server.
- Market prices and news come from free public sources. Only ticker symbols
  are sent to fetch them, never amounts or account details.
- Your SimpleFIN connection is stored in Windows Credential Manager, not in
  the database.
- The database is not encrypted yet. Encryption and an app lock are planned.

## Install

1. Open the [latest release](https://github.com/willbpeters/Tally/releases/latest).
2. Under **Assets**, download `Tally_<version>_x64-setup.exe` and run it.
3. Windows may show **"Windows protected your PC"**, because the installer
   isn't signed with a paid certificate. Click **More info → Run anyway**.

Tally installs for your Windows account only, so no administrator prompt
appears, and it adds Start Menu and Desktop shortcuts.

## Updates

Tally checks for a new version each time it opens. When one is available, a
banner appears at the top of the window:

> Version 0.2.0 is ready. **Install and restart** · Later

Updates are signed, and Tally refuses any download that isn't. Your data
carries over untouched.

## Your data and backups

| What | Where |
| --- | --- |
| Database | `%APPDATA%\com.ledgerly.app\finance.sqlite` |
| Automatic backups | `%APPDATA%\com.ledgerly.app\backups\` |

You can back up, restore and export from **Settings → Backups**. A restore
takes a fresh backup first, so it can always be undone.

The data folder still uses the app's original name. Changing it would
disconnect existing installs from their data.

## Development

### Prerequisites

- Windows 10 or 11 (WebView2 is built in)
- [Node.js](https://nodejs.org) 24 or newer
- [Rust](https://rustup.rs) (stable, MSVC toolchain) and the Microsoft C++
  Build Tools ("Desktop development with C++")

> **Note:** Windows **Smart App Control** blocks self-compiled programs and
> must be turned off to build Tally.

### Getting started

```bash
git clone https://github.com/willbpeters/Tally.git
cd Tally
npm install
npm run tauri dev
```

`npm run tauri dev` opens the app with live reloading. The first start
compiles the Rust side and takes a few minutes. Later starts take seconds.

### Common commands

| Command | What it does |
| --- | --- |
| `npm run tauri dev` | Run the app in development mode |
| `npm test` | Run the TypeScript tests (Vitest) |
| `cargo test` (in `src-tauri/`) | Run the Rust tests |
| `npm run build` | Type-check and build the front end |
| `npm run tauri build` | Build an unsigned installer locally |

### Tech stack

| Layer | Technology |
| --- | --- |
| Desktop shell | [Tauri 2](https://tauri.app) (Rust) |
| Interface | React 19, TypeScript, Vite |
| Charts | Recharts |
| Data | SQLite via `rusqlite` |
| Tests | Vitest and Testing Library; `cargo test` |

## Releasing a new version

Releases are built on GitHub and need no setup on your computer.

1. Push your changes to `master`. Installed copies don't change yet.
2. Go to **Actions → Release → Run workflow** and enter a version higher than
   the last one, such as `0.2.0`.
3. The workflow runs the tests, builds and signs the installer, and publishes
   a GitHub Release. This takes about 8 minutes.
4. Installed copies offer the update the next time they open.
5. Run `git pull` afterwards. The workflow commits the version change to
   `master`.

Updates are signed with a private key kept outside the repository, and stored
on GitHub as the `TAURI_SIGNING_PRIVATE_KEY` secret. **Never commit it.** See
the *Releasing* section of [`docs/HANDOFF.md`](docs/HANDOFF.md) for the
details.

## Project structure

```
├── src/                     React front end
│   ├── app/                 App shell: rails, command bar, update banner
│   ├── features/            One folder per screen (dashboard, holdings, …)
│   ├── domain/              Pure TypeScript finance maths (returns, risk, …)
│   ├── data/                Calls into the Rust side, and React Query hooks
│   └── ui/                  Shared components, theme and formatting
├── src-tauri/               Rust back end
│   ├── src/                 Database, sync, prices, budgets, backups
│   ├── windows/hooks.nsh    Installer additions
│   └── tauri.conf.json      App configuration
├── scripts/                 Version bump script, dev launcher
├── .github/workflows/       The Release workflow
└── docs/                    Handoff notes, to-do list, designs and plans
```

Rust handles all file, network and database work. The finance maths is pure
TypeScript in `src/domain/` with no React or network code, which keeps it easy
to test.

## Documentation

- [`docs/HANDOFF.md`](docs/HANDOFF.md): how everything works, with known
  pitfalls
- [`docs/TODO.md`](docs/TODO.md): what's planned next
- [`docs/superpowers/specs/`](docs/superpowers/specs/): the design behind each
  feature
- [`docs/superpowers/plans/`](docs/superpowers/plans/): step-by-step
  implementation plans
