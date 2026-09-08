# Ledgerly — Handoff & Next Steps

**Last updated:** 2026-09-07
**Repo:** `C:\Users\willi\Dev\FinTech` → GitHub `willbpeters/Ledgerly` (private), branch `master`

## What this project is

A **local-first personal finance desktop app** for Windows, packaged as an `.exe`.
It combines a **portfolio/investment tracker** (à la Wealthfolio) with a
**spending/budgeting tool** (à la Copilot). All data stays on the machine; the
app is free to run and uses no paid services.

**Stack:** Tauri v2 + React 19 + TypeScript + Vite + SQLite (rusqlite).

## Current state: v1 investments + UI redesign + SimpleFIN sync

The v1 investments module (22 tasks) shipped to `master`. Phase 2 — the light/dark
UI redesign and SimpleFIN balance/holdings sync — was built on
`feat/ui-simplefin` from the 2026-09-07 spec and plan.

- **Tests:** 45 TypeScript (Vitest) + 34 Rust (`cargo test`), plus 2 network
  tests marked `#[ignore]` that hit SimpleFIN's public demo — all passing.
- **Build:** `npm run tauri build` → `Ledgerly_0.1.0_x64-setup.exe` + `.msi`
  under `src-tauri/target/release/bundle/`.

### What's built
- **App shell**: left sidebar — Dashboard, Holdings, Accounts, Activity,
  Settings ("Budget" shown as *coming soon*).
- **Accounts**: create/list/delete, types `brokerage` and `cash`.
- **Activity**: an **account context selector at the top** — the entry forms and
  the transaction list below all operate on the selected account. Three tabs:
  quick-add position, full transaction form, and CSV import
  (file → column mapping → preview → commit).
- **Holdings**: overall table, a **per-account breakdown** below it, and a **⚙
  column picker** (persisted to localStorage).
- **Dashboard**: hero total with day-change chip, four stat cards, a
  value-over-time area chart, and allocation donuts with legends.
- **Prices**: keyless Yahoo Finance provider; **auto-refresh** ~5s during US
  market hours and every 15 min outside them; manual refresh in Settings;
  daily portfolio snapshots feed the chart.
- **Domain layer** (pure TypeScript, heavily tested): average-cost basis,
  realized/unrealized gains, positions → holdings aggregation, portfolio
  summary with day change, allocation, value series.
- **Theme**: light / dark / follow-Windows, chosen from the sidebar footer or
  Settings and remembered in `localStorage` under `ledgerly.theme`. Colours are
  CSS variables on `:root` and `:root[data-theme="dark"]`; charts read the same
  tokens so they re-theme too.
- **Shared UI kit** (`src/ui/`): PageHeader, Card, StatCard, Button, Badge,
  EmptyState, DataTable, Tabs, Field, Segmented, ThemeToggle, toasts. Screens
  are built from these, so restyling happens in one place.
- **SimpleFIN sync**: connect in Settings by pasting a setup token *or* an
  access URL, then sync from Settings or the sidebar button. Pulls account
  balances and, where the institution provides them, holdings. Synced accounts
  show a badge and last-synced time in Accounts, and their manual entry forms
  are disabled in Activity.

## Architecture — keep these seams intact

1. **Rust core** (`src-tauri/src/`) — the only layer doing I/O. Owns SQLite
   (all access funnels through `db.rs`, so swapping in encrypted SQLCipher is a
   config change), does network price fetching, and owns `secrets.rs`, which
   stores credentials in Windows Credential Manager.
2. **SimpleFIN** (`src-tauri/src/simplefin/`) — `parse.rs` is pure and
   fixture-tested, `client.rs` does HTTP, `sync.rs` writes to SQLite one account
   per transaction. Commands live in `commands/simplefin.rs`.
3. **Domain** (`src/domain/`) — pure, I/O-free finance math. No React, no
   network. This is where correctness lives; it is thoroughly unit-tested.
4. **UI** (`src/features/`, `src/data/`, `src/ui/`) — React + TanStack Query.

**The single derivation point is now `derivePortfolio()` in
`src/domain/portfolio.ts`** — a pure function that merges manual accounts
(derived from transactions) with SimpleFIN accounts (derived from
`synced_holdings` and `synced_balance`). Both `usePortfolio` and the snapshot
recorder in `useRefresh.ts` call it, so no two screens can disagree.

**Extension points already in place:** `PriceProvider` trait, the account-source
pattern (manual / CSV / SimpleFIN), `secrets.rs`, and the single DB module.

## Gotchas worth knowing

- **Smart App Control must stay OFF** on this machine. It was blocking execution
  of self-compiled unsigned binaries (every Rust build). This is required for
  any local desktop-app development here.
- **Price provider is Yahoo Finance** (`query1.finance.yahoo.com` chart
  endpoint, keyless, requires a browser-like User-Agent). We switched off
  **Stooq** after it began serving a JavaScript anti-bot challenge; the Stooq
  implementation is kept behind the trait but is inactive.
- **The `.exe` is a frozen snapshot.** Code changes do not appear until you run
  `npm run tauri build` again. Use `npm run tauri dev` for live iteration.
- **Windows PowerShell 5.1 does not support `&&`** for chaining commands — run
  commands on separate lines or join with `;`.
- **Money is stored/handled as `f64`** (a deliberate v1 simplification). Round at
  display time via the `money()` / `pct()` helpers.
- **Database location:** `%APPDATA%\com.ledgerly.app\finance.sqlite` — currently
  **unencrypted**. The schema is at `user_version` **2**; migrations are
  version-gated in `db.rs`, so bump `TARGET_VERSION` and add a block to change it.
  A pre-migration backup sits beside it as `finance.sqlite.backup-pre-v2`.
- **SimpleFIN's demo *setup token* is permanently claimed** and returns 403 to
  everyone, so it cannot be used to test the claim flow. Connecting therefore
  accepts an **access URL** as well as a setup token, and "Try the demo" fills in
  `https://demo:demo@beta-bridge.simplefin.org/simplefin`. The demo has three
  cash accounts and no holdings, so holdings parsing is covered by fixtures.
- **The SimpleFIN access URL lives in Windows Credential Manager** under service
  `Ledgerly`, key `simplefin_access_url` — never in SQLite. Deleting the database
  does **not** disconnect SimpleFIN; use Disconnect in Settings.
- **Charts read CSS variables**, so the theme must be applied before they first
  render. `theme.tsx` sets `data-theme` at module load for exactly this reason —
  moving that into an effect reintroduces light-coloured charts in dark mode.

## Open decisions (nothing blocking)

1. **Quick-add cash behaviour.** "Quick add position" records a `buy`, whose cash
   effect is negative, without a matching deposit — so an account's cash (and
   net worth) reads negative unless the user also records deposits. Options:
   auto-create a matching deposit, exclude quick-adds from cash, or leave as-is
   and rely on the user entering deposits.
2. Optional: rename branch `master` → `main` to match the modern GitHub default.

## Remaining work

Each item below should get its own **spec → plan → implement** cycle rather than
being bolted on ad hoc. Suggested order:

1. **Budgeting / spending module** — the other half of the product, and the
   largest remaining piece. Deserves its own design spec.
2. **SimpleFIN transaction import** — the feed already carries transactions; we
   fetch with `balances-only=1` today. This is the natural input to budgeting.
3. **SimpleFIN scheduled auto-sync** — sync is manual today. A timer alongside
   the price auto-refresh would do it.
4. **Encrypted database (SQLCipher) + app lock** — Windows Hello / passkey /
   master password, with an auto-lock timeout.
5. **Holding detail drill-down** — a per-holding view showing individual lots.
   This is in the design spec but was scoped out of v1.
6. **Crypto and manual/other asset types** (real estate, private assets).
7. **Advanced returns** (XIRR / time-weighted return, benchmarks) and
   **historical backfill** for the value-over-time chart (today it only builds
   forward from daily snapshots).
8. **Multi-currency** (v1 is USD-only).

## Reference documents

- **Design specs:** `docs/superpowers/specs/2026-09-04-investments-tracker-design.md`
  and `docs/superpowers/specs/2026-09-07-ui-redesign-and-simplefin-design.md`
- **Original implementation plan (fully executed):**
  `docs/superpowers/plans/2026-09-04-investments-tracker.md`

## Commands

```bash
npm run tauri dev      # run the app live (hot-reloads the UI)
npm test               # TypeScript tests (Vitest)
npm run tauri build    # produce the .exe / .msi installers
```
```bash
cd src-tauri
cargo test             # Rust core tests
```

## Working style

The project owner is newer to coding. Favour plain-English explanations, exact
copy-paste steps, and one decision at a time. Recommend a default rather than
presenting an exhaustive menu of options.
