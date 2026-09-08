# Ledgerly — UI Redesign + SimpleFIN Sync (design)

**Date:** 2026-09-07
**Status:** approved by owner, ready for planning
**Scope:** two workstreams that can be built in parallel and merged together.

- **A. UI redesign** — light + dark theme, shared components, every screen restyled.
- **B. SimpleFIN sync** — balances + holdings from SimpleFIN Bridge, token in
  Windows Credential Manager.

Out of scope (each gets its own spec later): transaction import from
SimpleFIN, budgeting, database encryption / app lock, multi-currency.

---

## A. UI redesign

### Goals
- A modern fintech look (Copilot / Wealthfolio calibre) without adding a UI
  framework. Plain CSS variables + small React components keep the code
  approachable.
- Light and dark themes, with a Light / Dark / System toggle persisted in
  `localStorage` (`ledgerly.theme`).
- No behaviour changes: every screen keeps the same data and actions.

### Theme tokens (`src/styles.css`)
Defined on `:root` (light) and overridden by `:root[data-theme="dark"]`. When
the user picks "System", the app sets `data-theme` from
`prefers-color-scheme` and follows changes live.

| Token | Purpose |
|---|---|
| `--bg`, `--surface`, `--surface-2` | page, card, nested/hover surfaces |
| `--ink`, `--ink-2`, `--mut` | primary text, secondary text, muted text |
| `--line`, `--line-2` | hairline borders, stronger borders |
| `--accent`, `--accent-ink`, `--accent-soft` | brand, text-on-accent, tinted background |
| `--pos`, `--pos-soft`, `--neg`, `--neg-soft`, `--warn` | gains / losses / warnings |
| `--radius`, `--radius-sm`, `--shadow` | shape + elevation |
| `--chart-1..6` | categorical chart palette (brand-neutral, readable on both themes) |

Typography: the system stack (`Segoe UI` on Windows) with
`font-variant-numeric: tabular-nums` on all numbers. No web fonts (the app is
offline-capable).

### Shared components (`src/ui/`)
Each is a small function component, styled by class names from `styles.css`.

| Component | Props (essentials) | Notes |
|---|---|---|
| `PageHeader` | `title`, `subtitle?`, `actions?` | Every screen's top row |
| `Card` | `title?`, `subtitle?`, `actions?`, `children` | Replaces ad-hoc `.card` divs |
| `StatCard` | `label`, `value`, `delta?` (number), `hint?` | Dashboard tiles; delta sets pos/neg colour |
| `Button` | `variant: primary\|secondary\|ghost\|danger`, `size?`, `loading?` | Wraps `<button>` |
| `Badge` | `tone: neutral\|accent\|pos\|neg\|warn` | Account source, txn type |
| `EmptyState` | `title`, `body?`, `action?` | Friendly no-data states |
| `DataTable` | `columns`, `rows`, `getKey` | Sticky header, hover rows, numeric alignment |
| `Tabs` | `items`, `value`, `onChange` | Activity tabs |
| `Field` | `label`, `hint?`, `error?`, `children` | Wraps inputs/selects |
| `ThemeToggle` | — | Light / Dark / System segmented control |
| `Toast` provider + `useToast()` | `push({ tone, title, body? })` | Non-blocking feedback (sync done, errors) |

A `useTheme()` hook in `src/ui/theme.ts` owns the persisted preference and
applies `data-theme` to `<html>`.

### Shell
- Sidebar: brand mark, nav items with 16px inline SVG icons, active state uses
  `--accent-soft`. Footer holds the ThemeToggle and, when SimpleFIN is
  connected, a **Sync** button with "Synced 5 min ago" text and a spinner while
  syncing.
- Main area: max-width 1200px, 28px padding, `PageHeader` at top.

### Screens
- **Dashboard**: hero total (large tabular number) + day change chip; four
  `StatCard`s (Total gain, Return, Realized, Cash); value-over-time as an area
  chart with gradient fill and theme-aware axis/grid/tooltip; allocation donuts
  with a legend list beside each (label, value, %).
- **Holdings**: `DataTable` with ticker + security name cell, coloured
  gain/return, weight shown as a slim bar + %. Column picker becomes a popover
  with checkboxes. Per-account sections keep the same table.
- **Accounts**: table gains **Source** (`Badge`: Manual / SimpleFIN) and
  **Last synced** columns; synced accounts show institution from SimpleFIN.
  Add form moves into a `Card` with `Field`s.
- **Activity**: account selector in the page header; three `Tabs`; transaction
  list as `DataTable` with type `Badge`s.
- **Settings**: sections as `Card`s — Appearance (ThemeToggle), Prices,
  SimpleFIN (see B), About (version, data location).

### Charts
Recharts stays. Colours come from `--chart-*` tokens read via
`getComputedStyle` so they follow the theme. Tooltips use a custom component
styled with theme tokens.

### Testing
- Existing Vitest suites keep passing unchanged (no domain changes in A).
- New tests: `theme.test.ts` (persisting + resolving system preference) and a
  smoke render test per shared component.

---

## B. SimpleFIN sync

### What SimpleFIN provides
Verified against the live demo feed (`beta-bridge.simplefin.org`) on
2026-09-07. The Bridge speaks protocol **v1**:

```json
{
  "errors": ["..."],
  "accounts": [{
    "id": "ACT-123", "name": "Brokerage", "currency": "USD",
    "balance": "1234.56", "available-balance": "1234.56",
    "balance-date": 1788912000,
    "transactions": [],
    "holdings": [{
      "id": "...", "created": 1788912000, "currency": "USD",
      "symbol": "VTI", "description": "Vanguard Total Stock Market ETF",
      "shares": "10.5", "cost_basis": "2000.00",
      "market_value": "2500.00", "purchase_price": "190.48"
    }],
    "org": { "id": "...", "name": "Fidelity", "domain": "fidelity.com",
             "sfin-url": "...", "url": "..." }
  }]
}
```

- Numbers arrive as **strings**; dates as **Unix seconds**.
- `holdings` is present but empty for non-investment accounts and for
  brokerages the institution doesn't expose positions for. `symbol` may be
  empty for some holdings.
- The parser must tolerate protocol v2 (`errlist` of `{code,msg}` objects,
  `connections[]` instead of `org`) by treating both shapes: errors → list of
  strings; institution name from `org.name` if present, otherwise from the
  matching `connections[]` entry (by `conn_id`), otherwise `"SimpleFIN"`.

**Connecting:** the user pastes a *Setup Token* (base64 of a claim URL). The
app decodes it and sends `POST <claim-url>` with an empty body; the response
body is the *Access URL* (`https://user:pass@host/simplefin`). Setup tokens are
single-use: a second claim returns 403.

**Fetching:** `GET <access-url>/accounts?balances-only=1` (we don't need
transactions yet). The credentials embedded in the URL become HTTP Basic auth.
Status 402 = SimpleFIN subscription lapsed; 403 = access revoked.

**Demo for testing:** setup token
`aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9kZW1v`
(decodes to `https://beta-bridge.simplefin.org/simplefin/claim/demo`) or the
access URL `https://demo:demo@beta-bridge.simplefin.org/simplefin`. The demo
has three cash accounts and no holdings, so holdings parsing is unit-tested
against a fixture.

### Secrets
The Access URL is the only secret. It is stored in **Windows Credential
Manager** through the `keyring` crate (`keyring = { version = "3",
features = ["windows-native"] }`), service `"Ledgerly"`, user
`"simplefin_access_url"`. It is never written to SQLite or logs. A small
`secrets.rs` module exposes `get(key) / set(key, value) / delete(key)`;
SimpleFIN is its first consumer.

### Schema v2 (`db.rs` migration, `user_version` 1 → 2)
```sql
ALTER TABLE accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','simplefin'));
ALTER TABLE accounts ADD COLUMN external_id TEXT;          -- SimpleFIN account id
ALTER TABLE accounts ADD COLUMN synced_balance REAL;       -- cash balance from SimpleFIN
ALTER TABLE accounts ADD COLUMN last_synced_at TEXT;       -- RFC3339
CREATE UNIQUE INDEX IF NOT EXISTS accounts_external_id ON accounts(external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS synced_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  shares REAL NOT NULL,
  cost_basis REAL NOT NULL,
  market_value REAL NOT NULL,
  as_of TEXT NOT NULL,
  UNIQUE (account_id, security_id)
);
```
`Account` (Rust + TS) gains `source`, `external_id`, `synced_balance`,
`last_synced_at`. New `SyncedHolding` model
(`id, account_id, security_id, shares, cost_basis, market_value, as_of`).

### Rust module `src-tauri/src/simplefin/`
- `mod.rs` — public API used by commands:
  - `claim(setup_token) -> Result<String /* access url */>`
  - `fetch_accounts(access_url) -> Result<Vec<SfAccount>>`
  - `apply(conn, accounts) -> Result<SyncReport>`
- `parse.rs` — pure, unit-tested: `decode_setup_token`, `parse_accounts_json`
  (v1 + v2 tolerant), string→f64 money parsing, epoch→ISO date.
- `client.rs` — `reqwest::blocking` calls (claim POST, accounts GET) with the
  same User-Agent pattern as the price provider. Maps 402/403 to typed errors.
- `sync.rs` — `apply` logic, one SQLite transaction per SimpleFIN account:
  1. Find the Ledgerly account with `external_id = sf.id`. If none, create it:
     name `sf.name`, institution `org.name`, `source='simplefin'`,
     type `brokerage` if `holdings` non-empty else `cash`.
  2. Set `synced_balance = balance`, `last_synced_at = now`.
  3. For each holding with a non-empty `symbol`: get-or-create the security
     (type `etf` if description contains "ETF" or "Fund", else `stock`);
     upsert `synced_holdings`; upsert a `prices` row
     (`date = balance-date`, `close = market_value / shares`,
     `source='simplefin'`) only if no `yahoo` price exists for that date.
     Holdings with no symbol or zero shares are skipped and counted.
  4. Delete `synced_holdings` rows for that account not present in this sync.
- A `SyncReport { accounts_synced, holdings_synced, holdings_skipped,
  errors: Vec<String> }` is returned to the UI.

### Tauri commands (`commands/simplefin.rs`)
| Command | Behaviour |
|---|---|
| `simplefin_status` | `{ connected: bool, last_synced_at: Option<String> }` — never returns the URL |
| `simplefin_connect(setup_token)` | claim → store in Credential Manager → run a first sync → return `SyncReport` |
| `simplefin_sync` | read URL → fetch → apply → return `SyncReport` |
| `simplefin_disconnect(delete_accounts: bool)` | remove credential; optionally delete synced accounts (cascade clears holdings). Otherwise they stay with their last synced data. |
| `synced_holdings_list` | all rows, for the frontend derivation |

Errors are `String`s in plain English: "That setup token has already been
used — generate a new one in SimpleFIN Bridge.", "Your SimpleFIN subscription
needs renewing.", "Couldn't reach SimpleFIN. Check your connection.".

### Domain merge (`src/domain/synced.ts`, pure + tested)
`usePortfolio` gains one query (`synced_holdings_list`) and calls:

- `syncedPositions(holdings, latestPrices) -> Position[]` — one `Position` per
  synced holding: `shares`, `costBasis`, `avgCost = costBasis/shares`,
  `lastPrice = latestPrices.get(security_id) ?? market_value/shares`,
  `marketValue = shares * lastPrice`, `unrealized`, `realized = 0`.
- `mergeCash(txnCash: Map, accounts) -> Map` — for accounts with
  `source === 'simplefin'`, cash is `synced_balance ?? 0` (transactions in a
  synced account, if any, are ignored for cash); manual accounts unchanged.

Positions from transactions are computed only for manual accounts, then
concatenated with synced positions before `aggregateHoldings`. Everything
downstream (summary, allocation, byAccount) is untouched — the single
derivation point still holds.

### UI
- **Settings → SimpleFIN card**
  - Not connected: three numbered plain-English steps (sign up, connect banks,
    create setup token), a textarea to paste the token, **Connect** button.
    Below, a small "Try the demo" link that fills the demo token.
  - Connected: status line ("Connected · last synced 5 min ago"), **Sync now**,
    **Disconnect** (confirm dialog with "also remove synced accounts" checkbox),
    last sync report (accounts/holdings counts, skipped-symbol note, errors).
- **Sidebar footer**: Sync button + relative time when connected; toast on
  completion or error.
- **Accounts**: Source badge, Last synced column; Delete is allowed for synced
  accounts (they will reappear on next sync unless disconnected — the confirm
  text says so).
- **Activity**: the account selector marks synced accounts "(synced)"; forms
  still work (manual transactions in a synced account affect only realized
  gains, never cash — a hint says so).

### Auto-sync
Manual only in this version (Connect triggers the first sync; Sync button and
Settings trigger later ones). A scheduled sync can be added later beside the
price auto-refresh.

### Testing
- Rust: `parse.rs` fixtures (demo JSON, a brokerage fixture with holdings,
  a v2-shaped fixture, symbol-less holding, malformed numbers); `sync.rs`
  against `open_in_memory()` (creates accounts, updates on second run, removes
  stale holdings, skips symbol-less); `db.rs` migration test bumps to 2 and
  checks the new table/columns exist on a v1 database.
- TS: `synced.test.ts` for both pure functions; a `usePortfolio`-level test
  that manual + synced accounts don't double count.
- Manual end-to-end with the demo token before the owner pays for SimpleFIN.

---

## Sequencing
1. Workstream A (UI) and B-Rust (parse/client/sync/commands/schema) proceed in
   parallel — they touch disjoint files except `Account` type, `api.ts`,
   `queries.ts`, and `Settings.tsx`, which B integrates last.
2. B-frontend (domain merge, Settings card, sidebar sync, badges) lands on top
   of A's components.
3. Update `docs/HANDOFF.md`.
