# Ledgerly — Handoff & Next Steps

**Last updated:** 2026-09-07
**Repo:** `C:\Users\willi\Dev\FinTech` → GitHub `willbpeters/Ledgerly` (private), branch `master`

## What this project is

A **local-first personal finance desktop app** for Windows, packaged as an `.exe`.
It combines a **portfolio/investment tracker** (à la Wealthfolio) with a
**spending/budgeting tool** (à la Copilot). All data stays on the machine; the
app is free to run and uses no paid services.

**Stack:** Tauri v2 + React 18 + TypeScript + Vite + SQLite (rusqlite).

## Current state: v1 investments module is COMPLETE

All 22 tasks of the original implementation plan were executed test-first,
code-reviewed, merged to `master`, and pushed to GitHub.

- **Tests:** 27 TypeScript (Vitest) + 13 Rust (`cargo test`) — all passing.
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
- **Dashboard**: KPI cards, allocation donuts (by type and by account),
  value-over-time line chart.
- **Prices**: keyless Yahoo Finance provider; **auto-refresh** ~5s during US
  market hours and every 15 min outside them; manual refresh in Settings;
  daily portfolio snapshots feed the chart.
- **Domain layer** (pure TypeScript, heavily tested): average-cost basis,
  realized/unrealized gains, positions → holdings aggregation, portfolio
  summary with day change, allocation, value series.

## Architecture — keep these seams intact

1. **Rust core** (`src-tauri/src/`) — the only layer doing I/O. Owns SQLite
   (all access funnels through `db.rs`, so swapping in encrypted SQLCipher is a
   config change), does network price fetching, and holds a secrets stub.
2. **Domain** (`src/domain/`) — pure, I/O-free finance math. No React, no
   network. This is where correctness lives; it is thoroughly unit-tested.
3. **UI** (`src/features/`, `src/data/`) — React + TanStack Query.
   `src/data/usePortfolio.ts` is the **single derivation point**: every screen
   gets its numbers from there, so Dashboard and Holdings can never disagree.

**Extension points already in place:** `PriceProvider` trait, the account-source
pattern (manual / CSV → SimpleFIN later), a secrets interface, and the single DB
module.

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
  **unencrypted**.

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
2. **SimpleFIN auto-sync adapter** — plus storing its access token in Windows
   Credential Manager (the secrets seam exists for this).
3. **Encrypted database (SQLCipher) + app lock** — Windows Hello / passkey /
   master password, with an auto-lock timeout.
4. **Holding detail drill-down** — a per-holding view showing individual lots.
   This is in the design spec but was scoped out of v1.
5. **Crypto and manual/other asset types** (real estate, private assets).
6. **Advanced returns** (XIRR / time-weighted return, benchmarks) and
   **historical backfill** for the value-over-time chart (today it only builds
   forward from daily snapshots).
7. **Multi-currency** (v1 is USD-only).

## Reference documents

- **Design spec:** `docs/superpowers/specs/2026-09-04-investments-tracker-design.md`
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
