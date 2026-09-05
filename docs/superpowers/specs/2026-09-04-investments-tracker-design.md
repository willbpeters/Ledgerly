# Personal Finance App — Foundation + Investments Module (Design Spec)

**Date:** 2026-09-04
**Status:** Approved for planning
**Author:** William Peters (with Claude)

## Overview

A local-first personal finance desktop application for Windows, packaged as an
`.exe`. The full product combines **investment/portfolio tracking** (à la
Wealthfolio) and **spending/budgeting** (à la Copilot). This spec covers the
**shared foundation and the complete investments module only**; the budgeting
module is a separate, later spec that plugs into the same app shell.

All data lives locally on the user's machine. The app works offline (except for
optional price fetching). It is free to build and run, using no paid services in
v1.

## Goals

- Track investment accounts, holdings (stocks & ETFs) with lot-level cost basis,
  and cash/savings balances.
- Enter holdings and activity manually, or import transactions from a CSV export.
- Show an accurate portfolio dashboard: total value, gains, allocation, and a
  value-over-time chart.
- Keep the architecture layered so that later additions — SimpleFIN auto-sync,
  database encryption, biometric/passkey login, budgeting, crypto — slot in
  without a rewrite.
- Be approachable for a developer newer to coding: most work in TypeScript,
  minimal Rust, clear structure, exact setup/build instructions.

## Non-Goals (v1)

Designed-for but **not built** in this spec:

- Budgeting / spending module (own spec later).
- SimpleFIN auto-sync (the account-source interface is built now; the SimpleFIN
  adapter is the first fast-follow).
- Encrypted database (SQLCipher) and app authentication (Windows Hello / passkey /
  master password). v1 relies on the Windows user account; the database is a
  plain local SQLite file.
- Crypto and manual/other asset types (real estate, private assets, 401k-by-hand).
- Advanced return metrics (time-weighted return, XIRR/money-weighted, benchmark
  comparison).
- Multi-currency. v1 is **USD-only**.

## Decisions & Rationale

| Decision | Choice | Rationale |
|---|---|---|
| Data ingestion | Manual entry + CSV import; SimpleFIN adapter later | Free, private, no third party in v1; SimpleFIN (privacy-focused, ~$15/yr) chosen over Plaid for later auto-sync |
| Locality | Fully local, offline-capable, data on disk | User priority: keep data local |
| Tech stack | Tauri + React + TypeScript + SQLite | Best security posture, ~10-15MB exe, proven Wealthfolio blueprint, free, cross-platform |
| v1 security | None beyond Windows login; plain SQLite | User chose to start simple and add encryption/auth later; foundation designed to make that a config change, not a refactor |
| Asset types | Stocks/ETFs (cost-basis lots) + cash/savings | User's current holdings; model extensible to crypto/manual later |
| Prices | Keyless auto-fetch + manual override, pluggable provider | Free, zero-signup, private (only tickers leave the machine); keyed provider can be added later |
| Layout | Left sidebar | Scales as Budget/Reports are added; Wealthfolio-style |
| UI polish | Intentionally minimal / re-skinnable | User will redesign the frontend later |
| Value-over-time | Forward-building daily snapshots in v1 | Full historical reconstruction from transactions + historical prices is out of scope for v1; backfill is a later enhancement |
| Currency | USD-only | Simplicity; extensible |

## Architecture

Three layers, chosen so security and sync can be upgraded later in isolation:

### 1. Rust core (Tauri commands) — the trusted layer
- Owns the SQLite database. **All** reads/writes go through here.
- All DB access funnels through a single database module, so switching to
  encrypted SQLCipher later is a configuration change, not a refactor.
- Fetches prices over the network (avoids browser CORS; keeps any future API keys
  off the frontend).
- Exposes a `secrets` interface: a no-op passthrough in v1, backed by Windows
  Credential Manager later (for the SimpleFIN token, etc.).
- Exposes typed commands for accounts, securities, transactions, prices, and
  snapshots (CRUD + queries).

### 2. Domain logic — pure TypeScript, heavily tested
- Finance math with no I/O: cost basis (lot-level), realized/unrealized gains,
  portfolio aggregation, allocation, value-over-time series assembly, day change.
- Pure functions → easy to unit-test and easy to read.
- Consumes raw rows from the Rust core; returns derived metrics to the UI.

### 3. UI — React + TypeScript
- Left-sidebar app shell and screens.
- Talks to the Rust core through a thin, typed API wrapper.
- TanStack Query for data fetching/caching and refetch.

### Key seams (extension points)
- **Account-source interface** — Manual, CSV, and later SimpleFIN each implement
  it. New sources are added without touching existing ones.
- **Price-provider interface** — keyless provider in v1; keyed providers can be
  registered later.
- **Secrets interface** — no-op in v1; Credential Manager later.
- **Database module** — single access point; plain SQLite in v1, SQLCipher later.

## Data Model (SQLite)

- **accounts** — `id`, `name`, `type` (`brokerage` | `cash`), `institution`,
  `currency`, `created_at`
- **securities** — `id`, `ticker`, `name`, `type` (`stock` | `etf`), `currency`
- **transactions** — `id`, `account_id`, `security_id` (nullable for cash moves),
  `type` (`buy` | `sell` | `dividend` | `deposit` | `withdrawal` | `fee` |
  `interest`), `date`, `quantity`, `price`, `amount`, `fees`, `note`
  — **the single source of truth**
- **prices** — `security_id`, `date`, `close`, `source` — cache of fetched or
  manually entered prices
- **snapshots** — `date`, `total_value` — daily portfolio value points for the
  value-over-time chart

Holdings, cost basis, and gains are **derived** from transactions + latest
prices — never stored redundantly.

### Manual entry model
A user can add a position two ways, both of which resolve to `buy` transactions:
- **Lot-by-lot**: one entry per lot (quantity, price, date, fees).
- **Quick add**: a single aggregate (quantity + average cost + date) → one
  synthetic `buy` transaction.

## Screens

Left sidebar: **Dashboard**, **Holdings**, **Accounts**, **Activity**,
**Settings**. "Budget" appears disabled as *coming soon*.

- **Dashboard**
  - Top: total portfolio value + today's change ($ and %).
  - KPI cards: total gain/loss ($ and %), realized gains, cash balance.
  - Charts: value-over-time line; allocation donut (by security type and by
    account).
  - Holdings table preview.
- **Holdings** — full table: ticker, shares, avg cost, last price, market value,
  unrealized gain/loss ($ and %), % of portfolio. Row → holding detail with lots.
- **Accounts** — list/create/edit accounts; per-account value and holdings.
- **Activity** — full transaction list, filterable and editable; add/edit
  transaction; CSV import entry point.
- **Settings** — price refresh controls, data location, CSV import mapping,
  placeholders for future auth/sync/encryption.

## Metrics (v1)

- Total market value; total cost basis.
- Unrealized gain/loss ($ and %).
- Realized gain/loss (from sells).
- Today's change ($ and %) — requires previous close.
- Cash balance.
- Allocation by security type and by account.
- Per-holding: shares, avg cost, last price, market value, unrealized gain/loss,
  % of portfolio.

Advanced returns (XIRR/TWR, benchmarks) are deferred.

## Prices

- **Provider interface** with a keyless implementation (free public EOD/quote
  source; e.g. Stooq/Yahoo-style endpoint — chosen in the plan).
- Fetch happens in the Rust core.
- **Manual override** always available per security.
- **Failure handling**: on fetch failure, show the last-known price with a
  "stale" indicator; never block the UI on the network.

## CSV Import

- Import transactions from a bank/brokerage CSV export.
- Column-mapping step (map the file's columns to the transaction fields).
- **Preview before commit**: validate rows and show a preview; nothing is written
  to the database until the user confirms.

## Error Handling

- **Prices**: last-known value + stale indicator + manual override (above).
- **Import**: validation + preview; no partial writes.
- **Database**: surfaced errors; migrations run on startup.
- **Network**: all network use is optional and non-blocking.

## Testing (TDD)

Test-driven development throughout.

- **Domain (TS)**: thorough unit tests for cost basis, realized/unrealized gains,
  allocation, and time-series assembly — the highest-risk logic.
- **Rust core**: database command tests (CRUD, migrations, queries).
- **Import**: end-to-end test from CSV → previewed transactions → committed rows.

## Packaging

- `tauri build` produces a Windows `.exe` / installer.
- The plan includes exact one-time environment setup (Rust toolchain, C++ build
  tools, Node) and the build command, written for a newer developer.

## Open Items (name only)

- **App name** is a placeholder ("MyFinance"). To be chosen before first build;
  configurable in the app title and packaging metadata.

## Future Phases (post-v1, each its own spec/plan)

1. SimpleFIN auto-sync adapter (+ move its token into Windows Credential Manager).
2. Encrypted database (SQLCipher) + app authentication (Windows Hello / passkey /
   master password) + auto-lock.
3. Budgeting / spending module.
4. Crypto and manual/other asset types.
5. Advanced returns and historical value backfill.
6. Multi-currency.
