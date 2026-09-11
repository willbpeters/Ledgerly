# Ledgerly — Handoff & Next Steps

**Last updated:** 2026-09-11
**Repo:** `C:\Users\willi\Dev\FinTech` → GitHub `willbpeters/Ledgerly` (private), branch `master`

## What this project is

A **local-first personal finance desktop app** for Windows, packaged as an `.exe`.
It combines a **portfolio/investment tracker** (à la Wealthfolio) with a
**spending/budgeting tool** (à la Copilot). All data stays on the machine; the
app is free to run and uses no paid services.

**Stack:** Tauri v2 + React 19 + TypeScript + Vite + SQLite (rusqlite).

## Current state: investments, SimpleFIN sync, budgeting, command-rail UI

The v1 investments module (22 tasks) shipped to `master`. Phase 2 added SimpleFIN
balance and holdings sync plus a themed component kit. Phase 3 replaced the shell
and palette with the "command rail" direction on warm off-white, chosen by the
owner from four mockups, later moved from indigo to green. Phase 4 added the
budgeting and spending module.

- **Tests:** 126 TypeScript (Vitest) + 89 Rust (`cargo test`), plus 4 tests marked
  `#[ignore]` that touch the network or the OS credential store — all passing.
- **Build:** `npm run tauri build` → `Ledgerly_0.1.0_x64-setup.exe` + `.msi`
  under `src-tauri/target/release/bundle/`.

### What's built
- **Markets**: a screen answering "what happened to what I own?" and "is this
  me or the whole market?". A strip of S&P/Nasdaq/Dow beside your own day
  change; held companies with their day move and latest headlines, biggest
  mover first; held index funds with what they track; and an earnings strip for
  the next 14 days with beat/miss on quarters just reported. Everything renders
  from a SQLite cache, so the screen never blocks on the network and works
  offline. Headlines are shown **beside** moves and never presented as their
  cause. Spec: `docs/superpowers/specs/2026-09-10-markets-news-earnings-design.md`
- **App shell** (the "command rail" design, chosen from four mockups): a 64px
  **icon rail** on the left, a **command bar** across the top carrying the
  screen name, a Ctrl-K search that jumps to filtered Holdings, sync status and
  the Sync button, and a 322px **insight rail** on the right with tabs for
  recent Activity, today's Movers and Accounts, plus a "needs attention" block.
  The right rail is collapsible from the command bar (remembered in
  `localStorage`) and hides itself under 1180px.
- **Spending** (the budgeting module): a month stepper; spent, income, left over
  and a needs-a-category count; every spending category with its monthly limit,
  progress bar and remainder; and the month's transactions with an inline
  category picker. Changing a category can write a payee rule that later syncs
  obey. Categories and the learned rules are managed in Settings.
- **Accounts**: create/list/delete, types `brokerage`, `cash` and `credit`, with
  the type editable because SimpleFIN never says which accounts are cards.
  Each account can be **hidden**: a hidden account keeps syncing and keeps its
  rows, but drops out of net worth, cash, allocation, the charts, the insight
  rail and the daily snapshots. Accounts is the only screen that still shows
  them, behind a "Show hidden (n)" toggle.
- **Activity**: an **account context selector at the top** — the entry forms and
  the transaction list below all operate on the selected account. Three tabs:
  quick-add position, full transaction form, and CSV import
  (file → column mapping → preview → commit). Picking a **synced** account
  instead lists that account's **bank transactions** (date, description,
  category, amount), read-only, because those live in a different table.
- **Holdings**: overall table, a **per-account breakdown** below it, and a **⚙
  column picker** (persisted to localStorage).
- **Dashboard**: a serif net-worth figure with today, all-time and cash beside
  it; a value-over-time area chart with a 1M/3M/1Y/All range picker whose Y axis
  zooms to the data rather than anchoring at zero; and a positions table.
- **Risk (Phase 1)**: a **Concentration** card on the dashboard — largest
  holding, top-5 combined, cash share, and **effective positions**
  (`1 / Σwᵢ²`), which is how many equally-sized holdings the portfolio
  actually behaves like. Maths is pure in `src/domain/risk.ts`. The card
  describes and never advises; see the spec for the phases still to come.
- **Price history**: `prices_backfill` stores **two years of daily closes**
  per security (`HISTORY_RANGE`), run once when `prices_history_depth` shows
  the database has fewer than `MIN_HISTORY_DAYS` (200). This is the
  foundation for beta, volatility, drawdown and correlation.
- **Prices**: keyless Yahoo Finance provider; **auto-refresh** once a minute
  during US market hours and every 15 min outside them, **paused while the
  window is hidden** and refreshed immediately on return; manual refresh in
  Settings; daily portfolio snapshots feed the chart. The cadence decision is
  a pure function in `src/data/refreshSchedule.ts`, so it is unit-tested.
- **Domain layer** (pure TypeScript, heavily tested): average-cost basis,
  realized/unrealized gains, positions → holdings aggregation, portfolio
  summary with day change, allocation, value series.
- **Theme**: warm off-white paper by default, with dark and follow-Windows in
  Settings, remembered in `localStorage` under `ledgerly.theme`. Colours are CSS
  variables on `:root` and `:root[data-theme="dark"]`; charts read the same
  tokens so they re-theme too.
- **Type**: Instrument Sans for the interface, Newsreader for the headline
  figure, both **bundled as woff2** in `src/assets/fonts` and declared with
  `@font-face` in `styles.css`. They are deliberately not loaded from Google so
  the app looks right with no network.
- **Shared UI kit** (`src/ui/`): PageHeader, Card, StatCard, Button, Badge,
  EmptyState, DataTable, Tabs, Field, Segmented, ThemeToggle, toasts. Screens
  are built from these, so restyling happens in one place.
- **SimpleFIN sync**: connect in Settings by pasting a setup token *or* an
  access URL, then sync from Settings or the command bar. Pulls account
  balances, holdings where the institution provides them, and **transactions**.
  Syncing is incremental from a few days before the newest row held; "Import
  2 years" pages backwards in 45-day windows, which is what SimpleFIN asks for.
  Synced accounts show a badge and last-synced time in Accounts, and their
  manual entry forms are disabled in Activity.

### Reliability pass (2026-09-08)
- **Error boundary** (`src/ui/ErrorBoundary.tsx`) wraps both the whole app and
  each screen inside `AppShell`. A render crash now shows an explanation and a
  Reload button instead of a blank white window — which is what the packaged
  `.exe` used to show, with no console to explain it. A broken screen leaves the
  rails usable.
- **Quick add position is cash-neutral.** It writes a deposit and the buy
  together via the atomic `transactions_create_many`, built by
  `quickAddTransactions()` in `src/domain/quickAdd.ts`. This closes what was
  open decision #1.
- **Price polling backed off** from 5s to 60s and paused when hidden (above).

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

**Hidden accounts are filtered inside `derivePortfolio()`**, not in each
screen: it drops hidden accounts along with their transactions and synced
holdings before deriving anything. Filtering only the account list would leave
a hidden manual account's transactions still counting toward cash, because
`manualOnly()` removes synced accounts, not hidden ones.

**Extension points already in place:** `PriceProvider` trait, the account-source
pattern (manual / CSV / SimpleFIN), `secrets.rs`, and the single DB module.

## Gotchas worth knowing

- **Yahoo's `quoteSummary` endpoint is dead to us.** It answers
  `401 Invalid Crumb` to any plain HTTP client — the same anti-bot pattern that
  took Stooq away. Earnings therefore come from Nasdaq's keyless endpoints
  (`api.nasdaq.com/api/calendar/earnings`, `/company/{SYM}/earnings-surprise`,
  `/analyst/{SYM}/earnings-forecast`). Do not "fix" the earnings code by
  reaching for quoteSummary.
- **Nasdaq's JSON mixes types for the same idea.** `eps` is a number while
  `consensusForecast` is a string, `epsForecast` arrives as `"$1.05"`, and a
  loss is `"($0.31)"`. Everything numeric goes through `nasdaq_parse::money`.
  The forecast response also carries **two** `rows` arrays — quarterly and
  yearly — and only the quarterly one is parsed.
- **`security_profile.quote_type` is what splits the Markets screen** into
  companies and funds. It is not a hardcoded ticker list, so it stays right as
  holdings change. A security with no profile yet is shown as a company rather
  than hidden — hiding a holding until its first profile fetch lands reads as
  data loss.
- **Index levels live in `index_quotes`, not `securities`.** Putting ^GSPC in
  `securities` would make the S&P appear in Holdings and the allocation chart
  as though it were owned.
- **The Markets refresh is cadence-gated, and that is a politeness budget.**
  `refresh_all` refetches profiles weekly and earnings daily, gated on stored
  `updated_at` stamps; only news runs every poll. Removing those gates turns
  roughly 6 requests per poll into roughly 27. This is the same budget that
  cost the project Stooq — see the note above about `MARKET_HOURS_MS`.
- **v5 adds the Markets tables** (`news_items`, `earnings_events`,
  `security_profile`, `index_quotes`). Every statement is `IF NOT EXISTS` and
  the completeness check is `v5_is_complete`.

- **Smart App Control must stay OFF** on this machine. It was blocking execution
  of self-compiled unsigned binaries (every Rust build). This is required for
  any local desktop-app development here.
- **Price provider is Yahoo Finance** (`query1.finance.yahoo.com` chart
  endpoint, keyless, requires a browser-like User-Agent). We switched off
  **Stooq** after it began serving a JavaScript anti-bot challenge; the Stooq
  implementation is kept behind the trait but is inactive.
- **Price refreshing is a politeness budget.** Every refresh fetches each
  security from Yahoo in a separate blocking request, one after another, so the
  interval multiplies by the number of holdings. At the old 5s cadence a
  20-holding portfolio made ~240 requests a minute, which invites a 429 and a
  repeat of the Stooq problem. Do not shorten `MARKET_HOURS_MS` without batching
  the fetches first.
- **The `.exe` is a frozen snapshot.** Code changes do not appear until you run
  `npm run tauri build` again. Use `npm run tauri dev` for live iteration.
- **Windows PowerShell 5.1 does not support `&&`** for chaining commands — run
  commands on separate lines or join with `;`.
- **Money is stored/handled as `f64`** (a deliberate v1 simplification). Round at
  display time via the `money()` / `pct()` helpers.
- **Database location:** `%APPDATA%\com.ledgerly.app\finance.sqlite` — currently
  **unencrypted**. The schema is at `user_version` **5**; migrations are
  version-gated in `db.rs`, so bump `TARGET_VERSION` and add a block to change it.
  A pre-migration backup sits beside it as `finance.sqlite.backup-pre-v2`.
- **v3 rebuilds the accounts table** to widen its `type` CHECK to accept
  `credit`, because SQLite cannot alter a CHECK. It runs with foreign keys off
  so the rebuild does not cascade-delete transactions, and switches them back on
  afterwards. Tested against a populated v1 database.
- **v4 adds `accounts.hidden`** (INTEGER, default 0). Its completeness check is
  `v4_is_complete`, and it deliberately runs **after** the v3 block: the v3
  accounts rebuild recreates the table without this column, so a v3 repair on a
  v4 database would drop it — checking v4 afterwards puts it straight back.
- **The version stamp is a record, not a gate.** v2, v3 and v4 each run when
  their *objects* are missing; the stamp decides nothing except whether the
  base schema is needed. A stamp can be wrong in both directions — ahead of the
  schema (interrupted migration) or **behind** it (an older build re-stamping a
  database it had already migrated, which is exactly what a downgrade during
  development does). Trusting it while behind re-runs `ALTER TABLE ADD COLUMN`
  on an existing column: a hard SQLite error that panics the app at startup,
  since `db::open` is `.expect()`ed in `lib.rs`. Columns are therefore added
  through `add_column_if_missing`, never raw.
- **Migrations do not trust the version stamp alone.** `apply_migrations`
  also checks that the v3 objects are really present (`v3_is_complete`) and
  re-applies them if not. This exists because a real database was found
  stamped `user_version = 3` while carrying a v2 schema — every budget query
  failed with `no such table: category_rules`, and the version gate meant it
  could never repair itself. `execute_batch` is not transactional, so a
  migration interrupted half-way leaves exactly this state; both halves of v3
  are now idempotent (the accounts rebuild is skipped when the CHECK already
  accepts `credit`, the budget tables are all `IF NOT EXISTS`) and the version
  is stamped step by step rather than once at the end. **Keep any new
  migration idempotent and add it to the completeness check.**
- **There are two transaction tables, and they are not interchangeable.**
  `transactions` holds investment activity (buy/sell/deposit/dividend), written
  by manual entry and CSV import. `bank_transactions` holds bank and card
  activity, written **only** by SimpleFIN sync via `budget/store.rs`. SimpleFIN
  never writes a row to `transactions`. Any screen showing "transactions" has
  to decide which it means — Activity now branches on `account.source`, and
  Spending reads `bank_transactions` only.
- **`refresh_all` and `backfill_all` are deliberately different.** The refresh
  keeps only the two most recent closes because it runs every 60s; the backfill
  keeps every close because the risk maths needs history. Do not merge them, and
  do not put the backfill on the polling timer.
- **Categorising happens in Rust at sync time**, not in the UI, so categories
  are right before any screen opens. The ladder is in `budget/categorize.rs`: a
  manual choice is never overruled, then user rules (MCC, payee, description),
  then the merchant-code map in `budget/mcc.rs`, then the sign of the amount.
- **SimpleFIN transactions carry an `mcc`** — the card network's merchant
  category code — which is what makes auto-categorisation accurate. Do not
  replace it with text matching on the description.
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

1. Optional: rename branch `master` → `main` to match the modern GitHub default.

## Remaining work

Each item below should get its own **spec → plan → implement** cycle rather than
being bolted on ad hoc. Suggested order:

0. **Local model summaries for the Markets screen** — an optional Ollama
   integration that reads `news_items` plus current positions and writes a
   short cross-holding summary ("INTC and MU both moved on the same
   memory-pricing story"). The model must **never restate a number** — every
   figure renders from SQLite, and a fluent wrong figure in a finance app is
   the worst available failure — and must describe rather than recommend, as
   the risk module already does. Ollama stays an *optional* dependency,
   detected on localhost: no Ollama, no summary panel, everything else
   unaffected. See the follow-on section of the Markets spec.
1. **SimpleFIN scheduled auto-sync** — sync is manual today. A timer alongside
   the price auto-refresh would do it.
2. **Encrypted database (SQLCipher) + app lock** — Windows Hello / passkey /
   master password, with an auto-lock timeout.
3. **Holding detail drill-down** — a per-holding view showing individual lots.
   This is in the design spec but was scoped out of v1.
4. **Crypto and manual/other asset types** (real estate, private assets).
5. **Risk analytics phases 2-4** — market exposure (beta vs SPY, volatility,
   R²), downside (max drawdown, historical VaR/CVaR), and diversification
   (correlation, ETF-overlap detection). Phase 0 (price history) and Phase 1
   (concentration) are done. Spec:
   `docs/superpowers/specs/2026-09-08-risk-analytics-design.md`
6. **Advanced returns** (XIRR / time-weighted return, benchmarks) and
   **historical backfill** for the value-over-time chart (today it only builds
   forward from daily snapshots).
6. **Multi-currency** (v1 is USD-only).

## Reference documents

- **Budgeting spec:** `docs/superpowers/specs/2026-09-07-budgeting-design.md`
- **Design canvas:** the four dashboard directions and the type study live in
  `design/ledgerly-dashboard/` as `.dc.html` sources; the 2.5MB seeded canvas is
  git-ignored and rebuilt from them.
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
