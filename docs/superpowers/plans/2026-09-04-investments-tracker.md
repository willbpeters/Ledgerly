# Foundation + Investments Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Windows desktop app (Tauri + React + TypeScript + SQLite) that tracks investment accounts, stock/ETF holdings with lot-level cost basis, and cash, with a dashboard, manual entry, CSV import, and keyless price fetching — packaged as an `.exe`.

**Architecture:** Three layers. (1) A Rust "core" (Tauri commands) owns the SQLite database and network price fetching — the only code that touches I/O. (2) A pure-TypeScript "domain" module does all finance math (cost basis, gains, allocation, time series) as I/O-free functions that are heavily unit-tested. (3) A React UI (left-sidebar shell) talks to the core through a thin typed wrapper and renders domain output. Extension seams (account-source interface, price-provider trait, secrets interface, single DB access point) keep later additions — SimpleFIN sync, encryption, auth, budgeting — from requiring a rewrite.

**Tech Stack:** Tauri v2, React 18, TypeScript, Vite, `rusqlite` (bundled SQLite), `reqwest` (price fetch), React Router, TanStack Query, Recharts, PapaParse. Tests: Vitest + Testing Library (TS), `cargo test` (Rust).

---

## Conventions used throughout this plan

**Money & quantities:** stored/handled as JS `number` (SQLite `REAL`). This is a known v1 simplification (floating-point rounding); acceptable for a single-user tool. Round only at display time with the `money()`/`pct()` helpers defined in Task 12. Do not "fix" this by adding a decimal library unless a later spec calls for it.

**Transaction cash-effect conventions** (the single rule all cash math obeys — implemented once in `cashEffect`, Task 9):

| type | fields used | cash effect on the account |
|---|---|---|
| `buy` | quantity, price, fees | `-(quantity*price + fees)` |
| `sell` | quantity, price, fees | `+(quantity*price - fees)` |
| `dividend` | amount | `+amount` |
| `interest` | amount | `+amount` |
| `deposit` | amount | `+amount` |
| `withdrawal` | amount | `-amount` |
| `fee` | amount | `-amount` |

**Cost basis method:** average cost, computed per `(account, security)` by folding that pair's transactions in date order. A `buy` raises shares and total cost; a `sell` removes shares at the current average cost and adds `proceeds - avgCost*qtySold` to realized gain. `dividend`/`interest`/`deposit`/`withdrawal`/`fee` never change share count or cost basis.

**Commit style:** every task ends by committing. Conventional-commit prefixes (`feat:`, `test:`, `chore:`, `docs:`).

**Working directory:** repo root is `C:\Users\willi\Dev\FinTech`. Frontend code lives at repo root (`src/`), Rust lives in `src-tauri/`.

---

## File structure (created across the plan)

```
FinTech/
├─ src/
│  ├─ main.tsx                     # React entry (scaffold)
│  ├─ App.tsx                      # Router + QueryClient + AppShell
│  ├─ app/
│  │  ├─ AppShell.tsx              # sidebar layout
│  │  └─ Sidebar.tsx               # nav links
│  ├─ data/
│  │  ├─ api.ts                    # typed invoke() wrappers over Rust commands
│  │  └─ queries.ts                # TanStack Query hooks
│  ├─ domain/
│  │  ├─ types.ts                  # shared TS types
│  │  ├─ cash.ts                   # cashEffect, cashByAccount, totalCash
│  │  ├─ positions.ts             # buildPositions, aggregateHoldings, accountMarketValues
│  │  ├─ summary.ts                # buildSummary
│  │  ├─ allocation.ts             # allocationByType, allocationByAccount
│  │  └─ series.ts                 # toValueSeries
│  ├─ features/
│  │  ├─ dashboard/Dashboard.tsx
│  │  ├─ holdings/Holdings.tsx
│  │  ├─ accounts/Accounts.tsx
│  │  ├─ accounts/AccountForm.tsx
│  │  ├─ activity/Activity.tsx
│  │  ├─ activity/TransactionForm.tsx
│  │  ├─ activity/AddPositionForm.tsx
│  │  ├─ activity/csvImport.ts     # parse + map + validate (pure)
│  │  ├─ activity/CsvImportForm.tsx    # import wizard UI
│  │  └─ settings/Settings.tsx
│  ├─ ui/                          # tiny shared presentational bits
│  │  ├─ format.ts                 # money(), pct(), fmtDate()
│  │  ├─ Card.tsx
│  │  └─ Table.tsx
│  └─ styles.css                   # minimal, intentionally plain
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/
│     ├─ main.rs                   # scaffold entry
│     ├─ lib.rs                    # run(): manage Db state, register commands
│     ├─ db.rs                     # connection, migrations, Db state
│     ├─ models.rs                 # serde structs
│     ├─ commands/
│     │  ├─ mod.rs
│     │  ├─ accounts.rs
│     │  ├─ securities.rs
│     │  ├─ transactions.rs
│     │  ├─ prices.rs
│     │  └─ snapshots.rs
│     ├─ prices/
│     │  ├─ mod.rs                 # PriceProvider trait + fetch orchestration
│     │  └─ stooq.rs               # keyless Stooq provider
│     └─ secrets.rs                # Secrets trait + NoopSecrets (v1)
├─ docs/superpowers/…              # spec + this plan
└─ (config: package.json, vite.config.ts, tsconfig.json, vitest.config.ts)
```

---

## Phase 0 — Environment & scaffold

### Task 1: One-time environment setup (developer machine)

**Files:** none (local tooling). This is manual setup; verify each command's output before moving on.

- [ ] **Step 1: Install Node.js (LTS)**

Download and run the Windows installer from https://nodejs.org (LTS). Then verify:

Run: `node -v && npm -v`
Expected: prints a Node version ≥ 20 and an npm version (e.g. `v20.x` / `10.x`).

- [ ] **Step 2: Install Rust**

Download and run `rustup-init.exe` from https://rustup.rs (accept defaults). Restart the terminal, then verify:

Run: `rustc --version && cargo --version`
Expected: prints a rustc and cargo version.

- [ ] **Step 3: Install Microsoft C++ Build Tools**

Rust needs the MSVC linker. Install "Visual Studio Build Tools" from
https://visualstudio.microsoft.com/visual-cpp-build-tools/ → in the installer,
check **"Desktop development with C++"** → Install. (WebView2 is already present on
Windows 11, so no separate install is needed.)

- [ ] **Step 4: Confirm the toolchain builds Rust**

Run: `cargo new --bin %TEMP%\rusttest && cd %TEMP%\rusttest && cargo run`
Expected: prints `Hello, world!`. If it fails with a linker error, the C++ Build
Tools step didn't complete — redo Step 3. Delete `%TEMP%\rusttest` after.

### Task 2: Scaffold the Tauri + React + TypeScript app

**Files:** creates the whole project skeleton under the repo root.

- [ ] **Step 1: Run the Tauri scaffolder into the current repo**

The repo root already contains `.git`, `.gitignore`, and `docs/`. Scaffold into a
temp folder, then move its contents in (the scaffolder won't write into a
non-empty dir).

Run:
```bash
cd "C:/Users/willi/Dev/FinTech"
npm create tauri-app@latest fintech-scaffold -- --template react-ts --manager npm
```
When prompted for anything, accept defaults. Expected: creates `fintech-scaffold/`
with `src/`, `src-tauri/`, `package.json`, etc.

- [ ] **Step 2: Move scaffold contents into the repo root**

Run (PowerShell):
```bash
Get-ChildItem -Force "C:/Users/willi/Dev/FinTech/fintech-scaffold" | Where-Object { $_.Name -ne '.git' -and $_.Name -ne '.gitignore' } | Move-Item -Destination "C:/Users/willi/Dev/FinTech"
Remove-Item -Recurse -Force "C:/Users/willi/Dev/FinTech/fintech-scaffold"
```
Expected: repo root now has `src/`, `src-tauri/`, `package.json`, `vite.config.ts`,
`index.html`. If the scaffold brought its own `.gitignore`, keep the repo's
existing one (do not overwrite).

- [ ] **Step 3: Install JS dependencies**

Run:
```bash
cd "C:/Users/willi/Dev/FinTech"
npm install
```
Expected: `node_modules/` created, no errors.

- [ ] **Step 4: Run the app in dev to confirm it launches**

Run: `npm run tauri dev`
Expected: a desktop window opens showing the default Tauri+React starter page.
First run compiles Rust and is slow (minutes). Close the window to stop.

- [ ] **Step 5: Commit the scaffold**

```bash
git add -A
git commit -m "chore: scaffold Tauri + React + TypeScript app"
```

### Task 3: Add project dependencies and test tooling

**Files:**
- Modify: `package.json` (scripts + deps, via npm)
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add runtime JS deps**

Run:
```bash
cd "C:/Users/willi/Dev/FinTech"
npm install react-router-dom @tanstack/react-query recharts papaparse
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom @types/papaparse
```
Expected: installs succeed.

- [ ] **Step 2: Add the test script**

In `package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

- [ ] **Step 4: Create `src/test/setup.ts`**

```ts
import "@testing-library/jest-dom";
```

- [ ] **Step 5: Verify the test runner works (no tests yet)**

Run: `npm test`
Expected: Vitest runs and reports "No test files found" (exit 0) — this confirms
config loads.

- [ ] **Step 6: Add Rust deps to `src-tauri/Cargo.toml`**

Under `[dependencies]`, add (keep the scaffold's existing `tauri`, `serde`,
`serde_json` lines):
```toml
rusqlite = { version = "0.32", features = ["bundled"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
anyhow = "1"
chrono = { version = "0.4", features = ["clock"] }
```

- [ ] **Step 7: Verify Rust deps resolve**

Run: `cd src-tauri && cargo build`
Expected: downloads crates and compiles successfully (slow first time). Return to
repo root afterward.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: add app dependencies and Vitest tooling"
```

---

## Phase 1 — Database foundation (Rust core)

### Task 4: Database connection, schema, and migrations

**Files:**
- Create: `src-tauri/src/db.rs`
- Create: `src-tauri/src/schema.sql`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the schema `src-tauri/src/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('brokerage','cash')),
  institution TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS securities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  name TEXT,
  type TEXT NOT NULL CHECK (type IN ('stock','etf')),
  currency TEXT NOT NULL DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN
    ('buy','sell','dividend','deposit','withdrawal','fee','interest')),
  date TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS prices (
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (security_id, date)
);

CREATE TABLE IF NOT EXISTS snapshots (
  date TEXT PRIMARY KEY,
  total_value REAL NOT NULL
);
```

- [ ] **Step 2: Write `src-tauri/src/db.rs`**

```rust
use rusqlite::Connection;
use std::sync::Mutex;

/// Single access point for the database. Swapping to an encrypted backend
/// (SQLCipher) later happens here, not in callers.
pub struct Db(pub Mutex<Connection>);

const SCHEMA: &str = include_str!("schema.sql");

/// Open (or create) the database at `path` and apply the schema.
pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    apply_migrations(&conn)?;
    Ok(conn)
}

/// Open an in-memory database (used by tests).
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    apply_migrations(&conn)?;
    Ok(conn)
}

/// Version-gated migrations. v1 is the whole base schema. To add a change later:
/// bump TARGET_VERSION and add a match arm that runs the new statements.
const TARGET_VERSION: i64 = 1;

fn apply_migrations(conn: &Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current < 1 {
        conn.execute_batch(SCHEMA)?;
    }
    // future: if current < 2 { conn.execute_batch(MIGRATION_2)?; } ...
    conn.execute_batch(&format!("PRAGMA user_version = {};", TARGET_VERSION))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_create_all_tables_and_set_version() {
        let conn = open_in_memory().unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TARGET_VERSION);
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN
                 ('accounts','securities','transactions','prices','snapshots')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 5);
    }
}
```

- [ ] **Step 3: Wire modules and DB state into `src-tauri/src/lib.rs`**

Replace the file's `run()` body so it declares the module and manages `Db`. Keep
the `#[cfg_attr(mobile, tauri::mobile_entry_point)]` attribute the scaffold added.

```rust
mod db;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // keep whatever plugins scaffold added
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("create app data dir");
            let conn = db::open(&dir.join("finance.sqlite")).expect("open db");
            app.manage(db::Db(std::sync::Mutex::new(conn)));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
(If the scaffold's `run()` had `.invoke_handler(...)` with a sample `greet`
command, remove that line for now — Task 6 adds the real handler.)

- [ ] **Step 4: Run the Rust test to verify migrations**

Run: `cd src-tauri && cargo test db::tests::migrations_create_all_tables_and_set_version`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): sqlite connection, schema, and migration runner"
```

### Task 5: Serde models

**Files:**
- Create: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod models;`)

- [ ] **Step 1: Write `src-tauri/src/models.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub institution: Option<String>,
    pub currency: String,
    pub created_at: String,
}

#[derive(Deserialize)]
pub struct NewAccount {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub institution: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Security {
    pub id: i64,
    pub ticker: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    pub currency: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub security_id: Option<i64>,
    #[serde(rename = "type")]
    pub type_: String,
    pub date: String,
    pub quantity: f64,
    pub price: f64,
    pub amount: f64,
    pub fees: f64,
    pub note: Option<String>,
}

#[derive(Deserialize)]
pub struct NewTransaction {
    pub account_id: i64,
    pub security_id: Option<i64>,
    #[serde(rename = "type")]
    pub type_: String,
    pub date: String,
    pub quantity: f64,
    pub price: f64,
    pub amount: f64,
    pub fees: f64,
    pub note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Price {
    pub security_id: i64,
    pub date: String,
    pub close: f64,
    pub source: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Snapshot {
    pub date: String,
    pub total_value: f64,
}
```

- [ ] **Step 2: Add `mod models;` to `src-tauri/src/lib.rs`**

Add near the top with the other `mod` lines: `mod models;`

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: compiles (warnings about unused structs are fine for now).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(core): serde models for db entities"
```

### Task 6: Account commands

**Files:**
- Create: `src-tauri/src/commands/mod.rs`
- Create: `src-tauri/src/commands/accounts.rs`
- Modify: `src-tauri/src/lib.rs` (`mod commands;` + register handler)

- [ ] **Step 1: Create `src-tauri/src/commands/mod.rs`**

```rust
pub mod accounts;
pub mod securities;
pub mod transactions;
pub mod prices;
pub mod snapshots;
```
(The later modules don't exist yet; create empty placeholder files now so this
compiles, then fill them in their tasks.)

Run:
```bash
cd "C:/Users/willi/Dev/FinTech"
"" | Out-File -Encoding utf8 src-tauri/src/commands/securities.rs
"" | Out-File -Encoding utf8 src-tauri/src/commands/transactions.rs
"" | Out-File -Encoding utf8 src-tauri/src/commands/prices.rs
"" | Out-File -Encoding utf8 src-tauri/src/commands/snapshots.rs
```

- [ ] **Step 2: Write the failing test in `src-tauri/src/commands/accounts.rs`**

Commands take `tauri::State<Db>`, which is awkward to unit-test, so put the logic
in plain functions that take `&Connection`, and make the `#[tauri::command]`
wrappers thin. Test the plain functions.

```rust
use crate::db::Db;
use crate::models::{Account, NewAccount};
use rusqlite::Connection;

pub fn create(conn: &Connection, a: NewAccount) -> rusqlite::Result<Account> {
    let created_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO accounts (name, type, institution, currency, created_at)
         VALUES (?1, ?2, ?3, 'USD', ?4)",
        rusqlite::params![a.name, a.type_, a.institution, created_at],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Account> {
    conn.query_row(
        "SELECT id,name,type,institution,currency,created_at FROM accounts WHERE id=?1",
        [id],
        row_to_account,
    )
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Account>> {
    let mut stmt = conn.prepare(
        "SELECT id,name,type,institution,currency,created_at FROM accounts ORDER BY name",
    )?;
    let rows = stmt.query_map([], row_to_account)?;
    rows.collect()
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM accounts WHERE id=?1", [id])?;
    Ok(())
}

fn row_to_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        name: r.get(1)?,
        type_: r.get(2)?,
        institution: r.get(3)?,
        currency: r.get(4)?,
        created_at: r.get(5)?,
    })
}

#[tauri::command]
pub fn accounts_list(db: tauri::State<Db>) -> Result<Vec<Account>, String> {
    let conn = db.0.lock().unwrap();
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounts_create(db: tauri::State<Db>, account: NewAccount) -> Result<Account, String> {
    let conn = db.0.lock().unwrap();
    create(&conn, account).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounts_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    delete(&conn, id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn create_then_list_returns_account() {
        let conn = db::open_in_memory().unwrap();
        create(&conn, NewAccount { name: "Brokerage".into(), type_: "brokerage".into(), institution: Some("Fidelity".into()) }).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Brokerage");
        assert_eq!(all[0].currency, "USD");
    }
}
```

- [ ] **Step 3: Add `mod commands;` and register handlers in `src-tauri/src/lib.rs`**

Add `mod commands;` near the other `mod` lines, and add the invoke handler to the
builder chain (before `.run(...)`):
```rust
        .invoke_handler(tauri::generate_handler![
            commands::accounts::accounts_list,
            commands::accounts::accounts_create,
            commands::accounts::accounts_delete,
        ])
```

- [ ] **Step 4: Run the test**

Run: `cd src-tauri && cargo test commands::accounts::tests::create_then_list_returns_account`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): account commands (list/create/delete)"
```

### Task 7: Security & transaction commands

**Files:**
- Modify: `src-tauri/src/commands/securities.rs`
- Modify: `src-tauri/src/commands/transactions.rs`
- Modify: `src-tauri/src/lib.rs` (register new handlers)

- [ ] **Step 1: Write `securities.rs` with a failing test**

```rust
use crate::db::Db;
use crate::models::Security;
use rusqlite::Connection;

/// Get an existing security by ticker or create it. Tickers are upper-cased.
pub fn get_or_create(conn: &Connection, ticker: &str, name: Option<&str>, type_: &str)
    -> rusqlite::Result<Security> {
    let t = ticker.trim().to_uppercase();
    conn.execute(
        "INSERT INTO securities (ticker,name,type,currency) VALUES (?1,?2,?3,'USD')
         ON CONFLICT(ticker) DO NOTHING",
        rusqlite::params![t, name, type_],
    )?;
    conn.query_row(
        "SELECT id,ticker,name,type,currency FROM securities WHERE ticker=?1",
        [t],
        row_to_security,
    )
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Security>> {
    let mut stmt = conn.prepare("SELECT id,ticker,name,type,currency FROM securities ORDER BY ticker")?;
    stmt.query_map([], row_to_security)?.collect()
}

fn row_to_security(r: &rusqlite::Row) -> rusqlite::Result<Security> {
    Ok(Security { id: r.get(0)?, ticker: r.get(1)?, name: r.get(2)?, type_: r.get(3)?, currency: r.get(4)? })
}

#[tauri::command]
pub fn securities_list(db: tauri::State<Db>) -> Result<Vec<Security>, String> {
    let conn = db.0.lock().unwrap();
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn securities_get_or_create(db: tauri::State<Db>, ticker: String, name: Option<String>, kind: String)
    -> Result<Security, String> {
    let conn = db.0.lock().unwrap();
    get_or_create(&conn, &ticker, name.as_deref(), &kind).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn get_or_create_is_idempotent_and_uppercases() {
        let conn = db::open_in_memory().unwrap();
        let a = get_or_create(&conn, "voo", Some("Vanguard S&P 500"), "etf").unwrap();
        let b = get_or_create(&conn, "VOO", None, "etf").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.ticker, "VOO");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
}
```

- [ ] **Step 2: Run the securities test**

Run: `cd src-tauri && cargo test commands::securities::tests::get_or_create_is_idempotent_and_uppercases`
Expected: PASS.

- [ ] **Step 3: Write `transactions.rs` with a failing test**

```rust
use crate::db::Db;
use crate::models::{NewTransaction, Transaction};
use rusqlite::Connection;

pub fn create(conn: &Connection, t: NewTransaction) -> rusqlite::Result<Transaction> {
    conn.execute(
        "INSERT INTO transactions
           (account_id,security_id,type,date,quantity,price,amount,fees,note)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![t.account_id, t.security_id, t.type_, t.date,
                          t.quantity, t.price, t.amount, t.fees, t.note],
    )?;
    get(conn, conn.last_insert_rowid())
}

/// Insert many transactions atomically (used by CSV import).
pub fn create_many(conn: &mut Connection, items: Vec<NewTransaction>) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    for t in &items {
        tx.execute(
            "INSERT INTO transactions
               (account_id,security_id,type,date,quantity,price,amount,fees,note)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![t.account_id, t.security_id, t.type_, t.date,
                              t.quantity, t.price, t.amount, t.fees, t.note],
        )?;
    }
    tx.commit()?;
    Ok(items.len())
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Transaction> {
    conn.query_row(
        "SELECT id,account_id,security_id,type,date,quantity,price,amount,fees,note
         FROM transactions WHERE id=?1",
        [id], row_to_txn)
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Transaction>> {
    let mut stmt = conn.prepare(
        "SELECT id,account_id,security_id,type,date,quantity,price,amount,fees,note
         FROM transactions ORDER BY date DESC, id DESC")?;
    stmt.query_map([], row_to_txn)?.collect()
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM transactions WHERE id=?1", [id])?;
    Ok(())
}

fn row_to_txn(r: &rusqlite::Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get(0)?, account_id: r.get(1)?, security_id: r.get(2)?, type_: r.get(3)?,
        date: r.get(4)?, quantity: r.get(5)?, price: r.get(6)?, amount: r.get(7)?,
        fees: r.get(8)?, note: r.get(9)?,
    })
}

#[tauri::command]
pub fn transactions_list(db: tauri::State<Db>) -> Result<Vec<Transaction>, String> {
    let conn = db.0.lock().unwrap();
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transactions_create(db: tauri::State<Db>, txn: NewTransaction) -> Result<Transaction, String> {
    let conn = db.0.lock().unwrap();
    create(&conn, txn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transactions_create_many(db: tauri::State<Db>, txns: Vec<NewTransaction>) -> Result<usize, String> {
    let mut conn = db.0.lock().unwrap();
    create_many(&mut conn, txns).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transactions_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    delete(&conn, id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, commands::accounts};
    use crate::models::NewAccount;

    fn acct(conn: &Connection) -> i64 {
        accounts::create(conn, NewAccount { name: "B".into(), type_: "brokerage".into(), institution: None }).unwrap().id
    }

    #[test]
    fn create_and_list_transaction() {
        let conn = db::open_in_memory().unwrap();
        let a = acct(&conn);
        create(&conn, NewTransaction { account_id: a, security_id: None, type_: "deposit".into(),
            date: "2026-01-02".into(), quantity: 0.0, price: 0.0, amount: 1000.0, fees: 0.0, note: None }).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn create_many_is_atomic() {
        let mut conn = db::open_in_memory().unwrap();
        let a = acct(&conn);
        let n = create_many(&mut conn, vec![
            NewTransaction { account_id: a, security_id: None, type_: "deposit".into(), date: "2026-01-01".into(), quantity:0.0, price:0.0, amount:500.0, fees:0.0, note:None },
            NewTransaction { account_id: a, security_id: None, type_: "deposit".into(), date: "2026-01-03".into(), quantity:0.0, price:0.0, amount:250.0, fees:0.0, note:None },
        ]).unwrap();
        assert_eq!(n, 2);
        assert_eq!(list(&conn).unwrap().len(), 2);
    }
}
```

- [ ] **Step 4: Register the new handlers in `src-tauri/src/lib.rs`**

Add these lines inside `tauri::generate_handler![ ... ]`:
```rust
            commands::securities::securities_list,
            commands::securities::securities_get_or_create,
            commands::transactions::transactions_list,
            commands::transactions::transactions_create,
            commands::transactions::transactions_create_many,
            commands::transactions::transactions_delete,
```

- [ ] **Step 5: Run the transaction tests**

Run: `cd src-tauri && cargo test commands::transactions::tests`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): security and transaction commands"
```

### Task 8: Price & snapshot commands (storage only; fetching in Phase 4)

**Files:**
- Modify: `src-tauri/src/commands/prices.rs`
- Modify: `src-tauri/src/commands/snapshots.rs`
- Modify: `src-tauri/src/lib.rs` (register handlers)

- [ ] **Step 1: Write `prices.rs` storage functions + failing test**

```rust
use crate::db::Db;
use crate::models::Price;
use rusqlite::Connection;

pub fn upsert(conn: &Connection, security_id: i64, date: &str, close: f64, source: &str)
    -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO prices (security_id,date,close,source) VALUES (?1,?2,?3,?4)
         ON CONFLICT(security_id,date) DO UPDATE SET close=excluded.close, source=excluded.source",
        rusqlite::params![security_id, date, close, source],
    )?;
    Ok(())
}

/// Latest close per security (most recent date), returned as (security_id, close).
pub fn latest_all(conn: &Connection) -> rusqlite::Result<Vec<(i64, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT p.security_id, p.close FROM prices p
         JOIN (SELECT security_id, MAX(date) d FROM prices GROUP BY security_id) m
           ON p.security_id=m.security_id AND p.date=m.d")?;
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

/// Previous close per security (second most recent date), for day-change math.
pub fn previous_all(conn: &Connection) -> rusqlite::Result<Vec<(i64, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT security_id, close FROM (
            SELECT security_id, date, close,
                   ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY date DESC) rn
            FROM prices)
         WHERE rn = 2")?;
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
}

pub fn list_for(conn: &Connection, security_id: i64) -> rusqlite::Result<Vec<Price>> {
    let mut stmt = conn.prepare(
        "SELECT security_id,date,close,source FROM prices WHERE security_id=?1 ORDER BY date DESC")?;
    stmt.query_map([security_id], |r| Ok(Price {
        security_id: r.get(0)?, date: r.get(1)?, close: r.get(2)?, source: r.get(3)? }))?.collect()
}

#[tauri::command]
pub fn prices_latest(db: tauri::State<Db>) -> Result<Vec<(i64, f64)>, String> {
    let conn = db.0.lock().unwrap();
    latest_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prices_previous(db: tauri::State<Db>) -> Result<Vec<(i64, f64)>, String> {
    let conn = db.0.lock().unwrap();
    previous_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prices_set_manual(db: tauri::State<Db>, security_id: i64, date: String, close: f64)
    -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    upsert(&conn, security_id, &date, close, "manual").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn latest_and_previous_pick_right_rows() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,name,type,currency) VALUES ('AAPL',NULL,'stock','USD')", []).unwrap();
        let sid: i64 = conn.query_row("SELECT id FROM securities WHERE ticker='AAPL'", [], |r| r.get(0)).unwrap();
        upsert(&conn, sid, "2026-01-01", 100.0, "stooq").unwrap();
        upsert(&conn, sid, "2026-01-02", 110.0, "stooq").unwrap();
        assert_eq!(latest_all(&conn).unwrap(), vec![(sid, 110.0)]);
        assert_eq!(previous_all(&conn).unwrap(), vec![(sid, 100.0)]);
    }
}
```

- [ ] **Step 2: Write `snapshots.rs` + failing test**

```rust
use crate::db::Db;
use crate::models::Snapshot;
use rusqlite::Connection;

pub fn record(conn: &Connection, date: &str, total_value: f64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO snapshots (date,total_value) VALUES (?1,?2)
         ON CONFLICT(date) DO UPDATE SET total_value=excluded.total_value",
        rusqlite::params![date, total_value],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Snapshot>> {
    let mut stmt = conn.prepare("SELECT date,total_value FROM snapshots ORDER BY date")?;
    stmt.query_map([], |r| Ok(Snapshot { date: r.get(0)?, total_value: r.get(1)? }))?.collect()
}

#[tauri::command]
pub fn snapshots_list(db: tauri::State<Db>) -> Result<Vec<Snapshot>, String> {
    let conn = db.0.lock().unwrap();
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snapshots_record(db: tauri::State<Db>, date: String, total_value: f64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    record(&conn, &date, total_value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn record_upserts_same_date() {
        let conn = db::open_in_memory().unwrap();
        record(&conn, "2026-01-01", 100.0).unwrap();
        record(&conn, "2026-01-01", 150.0).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].total_value, 150.0);
    }
}
```

- [ ] **Step 3: Register handlers in `src-tauri/src/lib.rs`**

Add inside `generate_handler![ ... ]`:
```rust
            commands::prices::prices_latest,
            commands::prices::prices_previous,
            commands::prices::prices_set_manual,
            commands::snapshots::snapshots_list,
            commands::snapshots::snapshots_record,
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test commands::prices commands::snapshots`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): price and snapshot storage commands"
```

---

## Phase 2 — Domain logic (pure TypeScript, TDD)

### Task 9: Types + cash math

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/cash.ts`
- Create: `src/domain/cash.test.ts`

- [ ] **Step 1: Write `src/domain/types.ts`**

```ts
export type AccountType = "brokerage" | "cash";
export type SecurityType = "stock" | "etf";
export type TxnType =
  | "buy" | "sell" | "dividend" | "deposit" | "withdrawal" | "fee" | "interest";

export interface Account {
  id: number; name: string; type: AccountType;
  institution: string | null; currency: string; created_at: string;
}
export interface Security {
  id: number; ticker: string; name: string | null;
  type: SecurityType; currency: string;
}
export interface Transaction {
  id: number; account_id: number; security_id: number | null;
  type: TxnType; date: string; quantity: number; price: number;
  amount: number; fees: number; note: string | null;
}
export interface Price { security_id: number; date: string; close: number; source: string; }
export interface Snapshot { date: string; total_value: number; }

/** A holding aggregated across accounts, by security. */
export interface Holding {
  security_id: number; ticker: string; type: SecurityType;
  shares: number; avgCost: number; costBasis: number;
  lastPrice: number; marketValue: number;
  unrealized: number; unrealizedPct: number; realized: number;
}
export interface PortfolioSummary {
  totalValue: number; investedValue: number; cash: number;
  totalCostBasis: number; unrealized: number; unrealizedPct: number;
  realized: number; dayChange: number; dayChangePct: number;
}
export interface AllocationSlice { label: string; value: number; pct: number; }
export interface SeriesPoint { date: string; value: number; }
```

- [ ] **Step 2: Write the failing test `src/domain/cash.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { cashEffect, cashByAccount, totalCash } from "./cash";
import type { Transaction } from "./types";

const t = (p: Partial<Transaction>): Transaction => ({
  id: 0, account_id: 1, security_id: null, type: "deposit", date: "2026-01-01",
  quantity: 0, price: 0, amount: 0, fees: 0, note: null, ...p,
});

describe("cashEffect", () => {
  it("buy reduces cash by cost plus fees", () => {
    expect(cashEffect(t({ type: "buy", quantity: 10, price: 50, fees: 1 }))).toBe(-501);
  });
  it("sell increases cash by proceeds minus fees", () => {
    expect(cashEffect(t({ type: "sell", quantity: 10, price: 50, fees: 1 }))).toBe(499);
  });
  it("deposit/dividend/interest add amount; withdrawal/fee subtract", () => {
    expect(cashEffect(t({ type: "deposit", amount: 100 }))).toBe(100);
    expect(cashEffect(t({ type: "dividend", amount: 5 }))).toBe(5);
    expect(cashEffect(t({ type: "interest", amount: 2 }))).toBe(2);
    expect(cashEffect(t({ type: "withdrawal", amount: 40 }))).toBe(-40);
    expect(cashEffect(t({ type: "fee", amount: 3 }))).toBe(-3);
  });
});

describe("cashByAccount / totalCash", () => {
  it("sums per account and overall", () => {
    const txns = [
      t({ account_id: 1, type: "deposit", amount: 1000 }),
      t({ account_id: 1, type: "buy", quantity: 10, price: 50, fees: 0 }),
      t({ account_id: 2, type: "deposit", amount: 300 }),
    ];
    const byAcct = cashByAccount(txns);
    expect(byAcct.get(1)).toBe(500);
    expect(byAcct.get(2)).toBe(300);
    expect(totalCash(txns)).toBe(800);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- cash`
Expected: FAIL — `cashEffect` is not defined / module not found.

- [ ] **Step 4: Implement `src/domain/cash.ts`**

```ts
import type { Transaction } from "./types";

export function cashEffect(t: Transaction): number {
  switch (t.type) {
    case "buy": return -(t.quantity * t.price + t.fees);
    case "sell": return t.quantity * t.price - t.fees;
    case "deposit":
    case "dividend":
    case "interest": return t.amount;
    case "withdrawal":
    case "fee": return -t.amount;
    default: return 0;
  }
}

export function cashByAccount(txns: Transaction[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of txns) m.set(t.account_id, (m.get(t.account_id) ?? 0) + cashEffect(t));
  return m;
}

export function totalCash(txns: Transaction[]): number {
  return txns.reduce((sum, t) => sum + cashEffect(t), 0);
}
```

- [ ] **Step 5: Run to confirm pass**

Run: `npm test -- cash`
Expected: PASS (all cash tests green).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(domain): shared types and cash math"
```

### Task 10: Positions, holdings, and account market values

**Files:**
- Create: `src/domain/positions.ts`
- Create: `src/domain/positions.test.ts`

- [ ] **Step 1: Write the failing test `src/domain/positions.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildPositions, aggregateHoldings, accountMarketValues } from "./positions";
import type { Transaction, Security } from "./types";

const AAPL: Security = { id: 10, ticker: "AAPL", name: "Apple", type: "stock", currency: "USD" };
const txn = (p: Partial<Transaction>): Transaction => ({
  id: 0, account_id: 1, security_id: 10, type: "buy", date: "2026-01-01",
  quantity: 0, price: 0, amount: 0, fees: 0, note: null, ...p,
});

describe("buildPositions (average cost)", () => {
  it("computes shares, avg cost, market value, unrealized", () => {
    const txns = [
      txn({ type: "buy", date: "2026-01-01", quantity: 10, price: 100 }),
      txn({ type: "buy", date: "2026-02-01", quantity: 10, price: 120 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    expect(pos).toHaveLength(1);
    expect(pos[0].shares).toBe(20);
    expect(pos[0].avgCost).toBe(110);       // (10*100 + 10*120) / 20
    expect(pos[0].costBasis).toBe(2200);
    expect(pos[0].marketValue).toBe(2600);  // 20 * 130
    expect(pos[0].unrealized).toBe(400);
  });

  it("realizes gains on sells at running average cost", () => {
    const txns = [
      txn({ type: "buy", date: "2026-01-01", quantity: 10, price: 100 }),
      txn({ type: "sell", date: "2026-03-01", quantity: 4, price: 150 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 150]]));
    expect(pos[0].shares).toBe(6);
    expect(pos[0].avgCost).toBe(100);
    expect(pos[0].realized).toBe(200);      // 4 * (150 - 100)
    expect(pos[0].costBasis).toBe(600);     // 6 * 100
  });

  it("drops fully-closed positions from holdings but keeps realized", () => {
    const txns = [
      txn({ type: "buy", quantity: 5, price: 100 }),
      txn({ type: "sell", quantity: 5, price: 130 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    expect(pos[0].shares).toBe(0);
    expect(pos[0].realized).toBe(150);
  });
});

describe("aggregateHoldings", () => {
  it("groups positions by security across accounts, weighted avg cost", () => {
    const txns = [
      txn({ account_id: 1, type: "buy", quantity: 10, price: 100 }),
      txn({ account_id: 2, type: "buy", quantity: 10, price: 140 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    const holdings = aggregateHoldings(pos, [AAPL]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].ticker).toBe("AAPL");
    expect(holdings[0].shares).toBe(20);
    expect(holdings[0].avgCost).toBe(120);
    expect(holdings[0].marketValue).toBe(2600);
    expect(holdings[0].unrealizedPct).toBeCloseTo((200 / 2400) * 100, 6);
  });

  it("omits securities with zero shares", () => {
    const txns = [txn({ type: "buy", quantity: 5, price: 100 }), txn({ type: "sell", quantity: 5, price: 130 })];
    const holdings = aggregateHoldings(buildPositions(txns, new Map([[10, 130]])), [AAPL]);
    expect(holdings).toHaveLength(0);
  });
});

describe("accountMarketValues", () => {
  it("adds each account's positions value to its cash", () => {
    const txns = [
      txn({ account_id: 1, type: "deposit", security_id: null, amount: 5000 }),
      txn({ account_id: 1, type: "buy", quantity: 10, price: 100 }),
    ];
    const pos = buildPositions(txns, new Map([[10, 130]]));
    const values = accountMarketValues(pos, txns);
    // cash: 5000 - 1000 = 4000; positions: 10*130 = 1300 → 5300
    expect(values.get(1)).toBe(5300);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- positions`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/domain/positions.ts`**

```ts
import type { Transaction, Security, Holding } from "./types";
import { cashByAccount } from "./cash";

export interface Position {
  account_id: number; security_id: number;
  shares: number; avgCost: number; costBasis: number;
  lastPrice: number; marketValue: number; unrealized: number; realized: number;
}

function keyOf(accountId: number, securityId: number) { return `${accountId}:${securityId}`; }

/** Fold transactions per (account, security) in date order using average cost. */
export function buildPositions(
  txns: Transaction[],
  latestPrices: Map<number, number>,
): Position[] {
  const relevant = txns
    .filter((t) => t.security_id != null && (t.type === "buy" || t.type === "sell"))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));

  const acc = new Map<string, { account_id: number; security_id: number; shares: number; cost: number; realized: number }>();
  for (const t of relevant) {
    const sid = t.security_id as number;
    const k = keyOf(t.account_id, sid);
    const cur = acc.get(k) ?? { account_id: t.account_id, security_id: sid, shares: 0, cost: 0, realized: 0 };
    if (t.type === "buy") {
      cur.shares += t.quantity;
      cur.cost += t.quantity * t.price + t.fees;
    } else {
      const avg = cur.shares > 0 ? cur.cost / cur.shares : 0;
      const qty = Math.min(t.quantity, cur.shares);
      cur.realized += qty * t.price - t.fees - avg * qty;
      cur.shares -= qty;
      cur.cost -= avg * qty;
      if (cur.shares <= 1e-9) { cur.shares = 0; cur.cost = 0; }
    }
    acc.set(k, cur);
  }

  return [...acc.values()].map((p) => {
    const lastPrice = latestPrices.get(p.security_id) ?? 0;
    const avgCost = p.shares > 0 ? p.cost / p.shares : 0;
    const marketValue = p.shares * lastPrice;
    return {
      account_id: p.account_id, security_id: p.security_id,
      shares: p.shares, avgCost, costBasis: p.cost,
      lastPrice, marketValue, unrealized: marketValue - p.cost, realized: p.realized,
    };
  });
}

/** Group positions by security across accounts. Omits zero-share securities. */
export function aggregateHoldings(positions: Position[], securities: Security[]): Holding[] {
  const secById = new Map(securities.map((s) => [s.id, s]));
  const bySec = new Map<number, Holding>();
  for (const p of positions) {
    const s = secById.get(p.security_id);
    if (!s) continue;
    const h = bySec.get(p.security_id) ?? {
      security_id: p.security_id, ticker: s.ticker, type: s.type,
      shares: 0, avgCost: 0, costBasis: 0, lastPrice: p.lastPrice,
      marketValue: 0, unrealized: 0, unrealizedPct: 0, realized: 0,
    };
    h.shares += p.shares;
    h.costBasis += p.costBasis;
    h.marketValue += p.marketValue;
    h.unrealized += p.unrealized;
    h.realized += p.realized;
    h.lastPrice = p.lastPrice;
    bySec.set(p.security_id, h);
  }
  return [...bySec.values()]
    .filter((h) => h.shares > 0)
    .map((h) => ({
      ...h,
      avgCost: h.shares > 0 ? h.costBasis / h.shares : 0,
      unrealizedPct: h.costBasis > 0 ? (h.unrealized / h.costBasis) * 100 : 0,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

/** Per-account total value = cash in account + market value of its positions. */
export function accountMarketValues(positions: Position[], txns: Transaction[]): Map<number, number> {
  const values = new Map<number, number>(cashByAccount(txns));
  for (const p of positions) {
    values.set(p.account_id, (values.get(p.account_id) ?? 0) + p.marketValue);
  }
  return values;
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- positions`
Expected: PASS (all positions tests green).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(domain): positions, holdings aggregation, account values"
```

### Task 11: Portfolio summary, allocation, and value series

**Files:**
- Create: `src/domain/summary.ts`
- Create: `src/domain/allocation.ts`
- Create: `src/domain/series.ts`
- Create: `src/domain/summary.test.ts`
- Create: `src/domain/allocation.test.ts`
- Create: `src/domain/series.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/domain/summary.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildSummary } from "./summary";
import type { Holding } from "./types";

const h = (p: Partial<Holding>): Holding => ({
  security_id: 1, ticker: "X", type: "stock", shares: 10, avgCost: 100,
  costBasis: 1000, lastPrice: 130, marketValue: 1300, unrealized: 300,
  unrealizedPct: 30, realized: 0, ...p,
});

describe("buildSummary", () => {
  it("totals value, gains, and day change", () => {
    const holdings = [h({ security_id: 1, shares: 10, costBasis: 1000, marketValue: 1300, unrealized: 300, realized: 50 })];
    const prev = new Map([[1, 125]]); // yesterday close
    const s = buildSummary(holdings, 500, prev);
    expect(s.investedValue).toBe(1300);
    expect(s.cash).toBe(500);
    expect(s.totalValue).toBe(1800);
    expect(s.totalCostBasis).toBe(1000);
    expect(s.unrealized).toBe(300);
    expect(s.unrealizedPct).toBeCloseTo(30, 6);
    expect(s.realized).toBe(50);
    expect(s.dayChange).toBe(50);          // 10 * (130 - 125)
    expect(s.dayChangePct).toBeCloseTo((50 / 1750) * 100, 6); // vs prior invested+cash
  });

  it("day change is zero when no previous price", () => {
    const s = buildSummary([h({})], 0, new Map());
    expect(s.dayChange).toBe(0);
    expect(s.dayChangePct).toBe(0);
  });
});
```

`src/domain/allocation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { allocationByType, allocationByAccount } from "./allocation";
import type { Holding, Account } from "./types";

const h = (p: Partial<Holding>): Holding => ({
  security_id: 1, ticker: "X", type: "stock", shares: 1, avgCost: 1, costBasis: 1,
  lastPrice: 1, marketValue: 100, unrealized: 0, unrealizedPct: 0, realized: 0, ...p,
});

describe("allocationByType", () => {
  it("groups holdings market value by type and appends cash", () => {
    const holdings = [h({ type: "stock", marketValue: 600 }), h({ type: "etf", marketValue: 300 })];
    const slices = allocationByType(holdings, 100);
    const byLabel = Object.fromEntries(slices.map((s) => [s.label, s]));
    expect(byLabel["Stocks"].value).toBe(600);
    expect(byLabel["ETFs"].value).toBe(300);
    expect(byLabel["Cash"].value).toBe(100);
    expect(byLabel["Stocks"].pct).toBeCloseTo(60, 6);
  });
});

describe("allocationByAccount", () => {
  it("labels slices by account name", () => {
    const accounts: Account[] = [
      { id: 1, name: "Brokerage", type: "brokerage", institution: null, currency: "USD", created_at: "" },
      { id: 2, name: "Savings", type: "cash", institution: null, currency: "USD", created_at: "" },
    ];
    const values = new Map([[1, 700], [2, 300]]);
    const slices = allocationByAccount(values, accounts);
    const byLabel = Object.fromEntries(slices.map((s) => [s.label, s]));
    expect(byLabel["Brokerage"].value).toBe(700);
    expect(byLabel["Savings"].pct).toBeCloseTo(30, 6);
  });
});
```

`src/domain/series.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toValueSeries } from "./series";

describe("toValueSeries", () => {
  it("maps snapshots to chart points sorted by date", () => {
    const pts = toValueSeries([
      { date: "2026-02-01", total_value: 200 },
      { date: "2026-01-01", total_value: 100 },
    ]);
    expect(pts).toEqual([
      { date: "2026-01-01", value: 100 },
      { date: "2026-02-01", value: 200 },
    ]);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- summary allocation series`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `src/domain/summary.ts`**

```ts
import type { Holding, PortfolioSummary } from "./types";

export function buildSummary(
  holdings: Holding[],
  cash: number,
  previousPrices: Map<number, number>,
): PortfolioSummary {
  const investedValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const totalCostBasis = holdings.reduce((s, h) => s + h.costBasis, 0);
  const unrealized = holdings.reduce((s, h) => s + h.unrealized, 0);
  const realized = holdings.reduce((s, h) => s + h.realized, 0);

  let dayChange = 0;
  let priorInvested = 0;
  let hasPrev = false;
  for (const h of holdings) {
    const prev = previousPrices.get(h.security_id);
    if (prev == null) continue;
    hasPrev = true;
    dayChange += h.shares * (h.lastPrice - prev);
    priorInvested += h.shares * prev;
  }
  const priorTotal = priorInvested + cash;
  const totalValue = investedValue + cash;

  return {
    totalValue, investedValue, cash, totalCostBasis, unrealized,
    unrealizedPct: totalCostBasis > 0 ? (unrealized / totalCostBasis) * 100 : 0,
    realized,
    dayChange: hasPrev ? dayChange : 0,
    dayChangePct: hasPrev && priorTotal > 0 ? (dayChange / priorTotal) * 100 : 0,
  };
}
```

- [ ] **Step 4: Implement `src/domain/allocation.ts`**

```ts
import type { Holding, Account, AllocationSlice } from "./types";

const TYPE_LABEL: Record<string, string> = { stock: "Stocks", etf: "ETFs" };

function withPct(entries: { label: string; value: number }[]): AllocationSlice[] {
  const total = entries.reduce((s, e) => s + e.value, 0);
  return entries
    .filter((e) => e.value > 0)
    .map((e) => ({ ...e, pct: total > 0 ? (e.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

export function allocationByType(holdings: Holding[], cash: number): AllocationSlice[] {
  const byType = new Map<string, number>();
  for (const h of holdings) {
    const label = TYPE_LABEL[h.type] ?? h.type;
    byType.set(label, (byType.get(label) ?? 0) + h.marketValue);
  }
  const entries = [...byType.entries()].map(([label, value]) => ({ label, value }));
  if (cash > 0) entries.push({ label: "Cash", value: cash });
  return withPct(entries);
}

export function allocationByAccount(
  accountValues: Map<number, number>,
  accounts: Account[],
): AllocationSlice[] {
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const entries = [...accountValues.entries()].map(([id, value]) => ({
    label: nameById.get(id) ?? `Account ${id}`, value,
  }));
  return withPct(entries);
}
```

- [ ] **Step 5: Implement `src/domain/series.ts`**

```ts
import type { Snapshot, SeriesPoint } from "./types";

export function toValueSeries(snapshots: Snapshot[]): SeriesPoint[] {
  return snapshots
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((s) => ({ date: s.date, value: s.total_value }));
}
```

- [ ] **Step 6: Run to confirm pass**

Run: `npm test`
Expected: PASS — all domain suites green (cash, positions, summary, allocation, series).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(domain): portfolio summary, allocation, value series"
```

---

## Phase 3 — Data layer + app shell

### Task 12: Formatting helpers + data API wrappers

**Files:**
- Create: `src/ui/format.ts`
- Create: `src/ui/format.test.ts`
- Create: `src/data/api.ts`

- [ ] **Step 1: Write the failing test `src/ui/format.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { money, pct, fmtDate } from "./format";

describe("format helpers", () => {
  it("money formats USD with two decimals", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(-50)).toBe("-$50.00");
  });
  it("pct formats with sign and one decimal", () => {
    expect(pct(12.34)).toBe("+12.3%");
    expect(pct(-3)).toBe("-3.0%");
  });
  it("fmtDate passes through ISO date", () => {
    expect(fmtDate("2026-01-02")).toBe("2026-01-02");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- format`
Expected: FAIL.

- [ ] **Step 3: Implement `src/ui/format.ts`**

```ts
export function money(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${abs}`;
}
export function pct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${Math.abs(n).toFixed(1)}%`;
}
export function fmtDate(iso: string): string { return iso.slice(0, 10); }
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- format`
Expected: PASS.

- [ ] **Step 5: Implement `src/data/api.ts` (typed invoke wrappers)**

```ts
import { invoke } from "@tauri-apps/api/core";
import type { Account, Security, Transaction, Snapshot } from "../domain/types";

export interface NewAccount { name: string; type: string; institution: string | null; }
export interface NewTransaction {
  account_id: number; security_id: number | null; type: string; date: string;
  quantity: number; price: number; amount: number; fees: number; note: string | null;
}

export const api = {
  accounts: {
    list: () => invoke<Account[]>("accounts_list"),
    create: (account: NewAccount) => invoke<Account>("accounts_create", { account }),
    delete: (id: number) => invoke<void>("accounts_delete", { id }),
  },
  securities: {
    list: () => invoke<Security[]>("securities_list"),
    getOrCreate: (ticker: string, name: string | null, kind: string) =>
      invoke<Security>("securities_get_or_create", { ticker, name, kind }),
  },
  transactions: {
    list: () => invoke<Transaction[]>("transactions_list"),
    create: (txn: NewTransaction) => invoke<Transaction>("transactions_create", { txn }),
    createMany: (txns: NewTransaction[]) => invoke<number>("transactions_create_many", { txns }),
    delete: (id: number) => invoke<void>("transactions_delete", { id }),
  },
  prices: {
    latest: () => invoke<[number, number][]>("prices_latest"),
    previous: () => invoke<[number, number][]>("prices_previous"),
    setManual: (security_id: number, date: string, close: number) =>
      invoke<void>("prices_set_manual", { securityId: security_id, date, close }),
    refresh: () => invoke<number>("prices_refresh"), // added in Task 15
  },
  snapshots: {
    list: () => invoke<Snapshot[]>("snapshots_list"),
    record: (date: string, total_value: number) =>
      invoke<void>("snapshots_record", { date, totalValue: total_value }),
  },
};
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ui): format helpers and typed data API layer"
```

### Task 13: App shell, routing, and query client

**Files:**
- Create: `src/app/Sidebar.tsx`
- Create: `src/app/AppShell.tsx`
- Create: `src/styles.css`
- Modify: `src/App.tsx`
- Modify: `src/main.tsx`
- Create: `src/data/queries.ts`
- Create placeholder screens: `src/features/{dashboard/Dashboard,holdings/Holdings,accounts/Accounts,activity/Activity,settings/Settings}.tsx`

- [ ] **Step 1: Write `src/styles.css` (minimal, intentionally plain)**

```css
:root { --bg:#f7f8fa; --card:#fff; --ink:#1a1d21; --mut:#6b7280; --line:#e5e7eb;
        --accent:#4f46e5; --pos:#16a34a; --neg:#dc2626; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.5 system-ui, sans-serif; color:var(--ink); background:var(--bg); }
.layout { display:flex; min-height:100vh; }
.sidebar { width:200px; background:var(--card); border-right:1px solid var(--line);
           padding:16px; display:flex; flex-direction:column; gap:4px; }
.brand { font-weight:700; color:var(--accent); margin-bottom:16px; }
.navlink { padding:8px 10px; border-radius:8px; color:var(--mut); text-decoration:none; }
.navlink.active { background:#eef2ff; color:var(--accent); }
.navlink.disabled { opacity:.5; pointer-events:none; }
.main { flex:1; padding:24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
.grid { display:grid; gap:12px; }
.pos { color:var(--pos); } .neg { color:var(--neg); }
table { width:100%; border-collapse:collapse; }
th,td { padding:8px; border-bottom:1px solid var(--line); text-align:right; }
th:first-child, td:first-child { text-align:left; }
button { font:inherit; padding:8px 12px; border:1px solid var(--line); border-radius:8px;
         background:var(--accent); color:#fff; cursor:pointer; }
button.secondary { background:var(--card); color:var(--ink); }
input,select { font:inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; }
label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--mut); }
.row { display:flex; gap:12px; flex-wrap:wrap; align-items:flex-end; }
```

- [ ] **Step 2: Write `src/app/Sidebar.tsx`**

```tsx
import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/holdings", label: "Holdings" },
  { to: "/accounts", label: "Accounts" },
  { to: "/activity", label: "Activity" },
];

export function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="brand">◆ MyFinance</div>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end}
          className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
          {l.label}
        </NavLink>
      ))}
      <span className="navlink disabled">Budget · soon</span>
      <div style={{ flex: 1 }} />
      <NavLink to="/settings" className={({ isActive }) => "navlink" + (isActive ? " active" : "")}>
        Settings
      </NavLink>
    </nav>
  );
}
```

- [ ] **Step 3: Write `src/app/AppShell.tsx`**

```tsx
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="main"><Outlet /></main>
    </div>
  );
}
```

- [ ] **Step 4: Write placeholder screens**

Create each of these files with a minimal component (they get filled in later
tasks). Example `src/features/dashboard/Dashboard.tsx`:
```tsx
export function Dashboard() { return <h1>Dashboard</h1>; }
```
Do the same, changing name/heading, for:
- `src/features/holdings/Holdings.tsx` → `export function Holdings()`
- `src/features/accounts/Accounts.tsx` → `export function Accounts()`
- `src/features/activity/Activity.tsx` → `export function Activity()`
- `src/features/settings/Settings.tsx` → `export function Settings()`

- [ ] **Step 5: Write `src/App.tsx`**

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { Dashboard } from "./features/dashboard/Dashboard";
import { Holdings } from "./features/holdings/Holdings";
import { Accounts } from "./features/accounts/Accounts";
import { Activity } from "./features/activity/Activity";
import { Settings } from "./features/settings/Settings";
import "./styles.css";

const queryClient = new QueryClient();
const router = createBrowserRouter([
  {
    path: "/", element: <AppShell />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "holdings", element: <Holdings /> },
      { path: "accounts", element: <Accounts /> },
      { path: "activity", element: <Activity /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
```

- [ ] **Step 6: Ensure `src/main.tsx` renders `App`**

The scaffold already renders `<App />`; confirm it imports from `./App` and has
no leftover starter markup. It should look like:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode><App /></React.StrictMode>,
);
```

- [ ] **Step 7: Write `src/data/queries.ts` (TanStack hooks used by screens)**

```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type NewAccount, type NewTransaction } from "./api";

export const keys = {
  accounts: ["accounts"] as const,
  securities: ["securities"] as const,
  transactions: ["transactions"] as const,
  latest: ["prices", "latest"] as const,
  previous: ["prices", "previous"] as const,
  snapshots: ["snapshots"] as const,
};

export const useAccounts = () => useQuery({ queryKey: keys.accounts, queryFn: api.accounts.list });
export const useSecurities = () => useQuery({ queryKey: keys.securities, queryFn: api.securities.list });
export const useTransactions = () => useQuery({ queryKey: keys.transactions, queryFn: api.transactions.list });
export const useLatestPrices = () => useQuery({ queryKey: keys.latest, queryFn: api.prices.latest });
export const usePreviousPrices = () => useQuery({ queryKey: keys.previous, queryFn: api.prices.previous });
export const useSnapshots = () => useQuery({ queryKey: keys.snapshots, queryFn: api.snapshots.list });

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: NewAccount) => api.accounts.create(a),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.accounts.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}
export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (t: NewTransaction) => api.transactions.create(t),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.transactions }),
  });
}
export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.transactions.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.transactions }),
  });
}
```

- [ ] **Step 8: Run the app and click through nav**

Run: `npm run tauri dev`
Expected: window opens with the left sidebar; clicking Dashboard/Holdings/
Accounts/Activity/Settings swaps the heading; "Budget · soon" is greyed. Close.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(ui): app shell, routing, query client, data hooks"
```

---

## Phase 4 — Accounts, manual entry, prices

### Task 14: Accounts screen (create / list / delete)

**Files:**
- Create: `src/features/accounts/AccountForm.tsx`
- Modify: `src/features/accounts/Accounts.tsx`

- [ ] **Step 1: Write `src/features/accounts/AccountForm.tsx`**

```tsx
import { useState } from "react";
import { useCreateAccount } from "../../data/queries";

export function AccountForm() {
  const create = useCreateAccount();
  const [name, setName] = useState("");
  const [type, setType] = useState("brokerage");
  const [institution, setInstitution] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), type, institution: institution.trim() || null },
      { onSuccess: () => { setName(""); setInstitution(""); } },
    );
  }

  return (
    <form className="row" onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Brokerage" /></label>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="brokerage">Brokerage</option>
          <option value="cash">Cash / Savings</option>
        </select>
      </label>
      <label>Institution<input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Fidelity" /></label>
      <button type="submit" disabled={create.isPending}>Add account</button>
    </form>
  );
}
```

- [ ] **Step 2: Write `src/features/accounts/Accounts.tsx`**

```tsx
import { useAccounts, useDeleteAccount } from "../../data/queries";
import { AccountForm } from "./AccountForm";

export function Accounts() {
  const { data: accounts = [], isLoading } = useAccounts();
  const del = useDeleteAccount();

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Accounts</h1>
      <div className="card"><AccountForm /></div>
      <div className="card">
        {isLoading ? <p>Loading…</p> : accounts.length === 0 ? (
          <p>No accounts yet. Add one above.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Institution</th><th></th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td><td>{a.type}</td><td>{a.institution ?? "—"}</td>
                  <td><button className="secondary" onClick={() => {
                    if (confirm(`Delete "${a.name}"? This removes its transactions.`)) del.mutate(a.id);
                  }}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Manually verify**

Run: `npm run tauri dev` → go to Accounts → add "Brokerage"/brokerage/"Fidelity";
it appears in the table; delete it (confirm dialog) and it disappears. Close.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(accounts): create, list, delete accounts UI"
```

### Task 15: Keyless price provider (Rust) + refresh command

**Files:**
- Create: `src-tauri/src/prices/mod.rs`
- Create: `src-tauri/src/prices/stooq.rs`
- Modify: `src-tauri/src/lib.rs` (`mod prices;` + register `prices_refresh`)
- Modify: `src-tauri/src/commands/prices.rs` (add `prices_refresh` command)

- [ ] **Step 1: Write the Stooq CSV parser with a failing test in `src-tauri/src/prices/stooq.rs`**

Stooq's daily CSV endpoint (`https://stooq.com/q/d/l/?s=aapl.us&i=d`) returns rows
`Date,Open,High,Low,Close,Volume`. We only need the last two closes. Parsing is
pure and testable; the network call is separate.

```rust
/// Parse Stooq daily CSV; return (date, close) rows in file order (oldest first).
pub fn parse_daily_csv(csv: &str) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for line in csv.lines().skip(1) {
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 5 { continue; }
        if let Ok(close) = cols[4].parse::<f64>() {
            out.push((cols[0].to_string(), close));
        }
    }
    out
}

/// The Stooq URL for a US ticker's daily history.
pub fn daily_url(ticker: &str) -> String {
    format!("https://stooq.com/q/d/l/?s={}.us&i=d", ticker.trim().to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_two_closes() {
        let csv = "Date,Open,High,Low,Close,Volume\n\
                   2026-01-01,10,11,9,10.5,1000\n\
                   2026-01-02,10.5,12,10,11.25,1200\n";
        let rows = parse_daily_csv(csv);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1], ("2026-01-02".to_string(), 11.25));
    }

    #[test]
    fn builds_lowercase_us_url() {
        assert_eq!(daily_url("AAPL"), "https://stooq.com/q/d/l/?s=aapl.us&i=d");
    }
}
```

- [ ] **Step 2: Run the parser test**

Run: `cd src-tauri && cargo test prices::stooq::tests`
Expected: 2 passed. (Add `mod prices;` to `lib.rs` first if the module isn't
found — see Step 4.)

- [ ] **Step 3: Write `src-tauri/src/prices/mod.rs` (provider trait + fetch orchestration)**

```rust
pub mod stooq;

use crate::db::Db;
use crate::commands::prices::upsert;

/// A source of security prices. v1 has one keyless implementation (Stooq);
/// keyed providers can implement this later without touching callers.
pub trait PriceProvider {
    /// Fetch recent (date, close) rows for a ticker, oldest first.
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>>;
    fn name(&self) -> &'static str;
}

pub struct StooqProvider;

impl PriceProvider for StooqProvider {
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>> {
        let url = stooq::daily_url(ticker);
        let body = reqwest::blocking::get(url)?.text()?;
        Ok(stooq::parse_daily_csv(&body))
    }
    fn name(&self) -> &'static str { "stooq" }
}

/// Fetch prices for every security and store the latest two closes each.
/// Returns the count of securities successfully updated. Never fails the whole
/// run because one ticker errored.
pub fn refresh_all(db: &Db, provider: &dyn PriceProvider) -> Result<usize, String> {
    let tickers: Vec<(i64, String)> = {
        let conn = db.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, ticker FROM securities").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let mut updated = 0usize;
    for (sid, ticker) in tickers {
        match provider.recent(&ticker) {
            Ok(rows) if !rows.is_empty() => {
                let conn = db.0.lock().unwrap();
                for (date, close) in rows.iter().rev().take(2) {
                    let _ = upsert(&conn, sid, date, *close, provider.name());
                }
                updated += 1;
            }
            _ => { /* leave last-known price in place */ }
        }
    }
    Ok(updated)
}
```

Note: this uses `reqwest::blocking`, so enable that feature. In
`src-tauri/Cargo.toml` change the reqwest line to:
```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "blocking"] }
```

- [ ] **Step 4: Add the `prices_refresh` command to `src-tauri/src/commands/prices.rs`**

Append:
```rust
#[tauri::command]
pub fn prices_refresh(db: tauri::State<Db>) -> Result<usize, String> {
    crate::prices::refresh_all(&db, &crate::prices::StooqProvider)
}
```

- [ ] **Step 5: Register module + command in `src-tauri/src/lib.rs`**

Add `mod prices;` with the other module declarations, and add
`commands::prices::prices_refresh,` inside `generate_handler![ ... ]`.

- [ ] **Step 6: Verify everything compiles and tests pass**

Run: `cd src-tauri && cargo test`
Expected: all Rust tests pass (db, accounts, securities, transactions, prices,
snapshots, stooq).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(core): keyless Stooq price provider and refresh command"
```

### Task 16: Add-position and transaction forms (manual entry)

**Files:**
- Create: `src/features/activity/AddPositionForm.tsx`
- Create: `src/features/activity/TransactionForm.tsx`

- [ ] **Step 1: Write `src/features/activity/AddPositionForm.tsx`**

"Quick add" a holding: pick account, enter ticker + shares + avg cost + date;
creates the security (if new) and one `buy` transaction.

```tsx
import { useState } from "react";
import { useAccounts, useCreateTransaction } from "../../data/queries";
import { api } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";

export function AddPositionForm() {
  const { data: accounts = [] } = useAccounts();
  const createTxn = useCreateTransaction();
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<number | "">("");
  const [ticker, setTicker] = useState("");
  const [kind, setKind] = useState("stock");
  const [shares, setShares] = useState("");
  const [avgCost, setAvgCost] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const acct = Number(accountId), qty = Number(shares), price = Number(avgCost);
    if (!acct || !ticker.trim() || !(qty > 0) || !(price >= 0)) {
      setError("Fill account, ticker, positive shares, and cost."); return;
    }
    const sec = await api.securities.getOrCreate(ticker.trim(), null, kind);
    await qc.invalidateQueries({ queryKey: keys.securities });
    createTxn.mutate(
      { account_id: acct, security_id: sec.id, type: "buy", date,
        quantity: qty, price, amount: qty * price, fees: 0, note: "Quick add" },
      { onSuccess: () => { setTicker(""); setShares(""); setAvgCost(""); } },
    );
  }

  return (
    <form className="row" onSubmit={submit}>
      <label>Account
        <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Select…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label>Ticker<input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="VOO" /></label>
      <label>Type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="stock">Stock</option><option value="etf">ETF</option>
        </select>
      </label>
      <label>Shares<input value={shares} onChange={(e) => setShares(e.target.value)} inputMode="decimal" /></label>
      <label>Avg cost<input value={avgCost} onChange={(e) => setAvgCost(e.target.value)} inputMode="decimal" /></label>
      <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="submit">Add position</button>
      {error && <span className="neg">{error}</span>}
    </form>
  );
}
```

- [ ] **Step 2: Write `src/features/activity/TransactionForm.tsx`**

A general transaction entry (buy/sell/dividend/deposit/withdrawal/fee/interest).
Security is required only for buy/sell/dividend.

```tsx
import { useState } from "react";
import { useAccounts, useSecurities, useCreateTransaction } from "../../data/queries";
import { api, type NewTransaction } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";
import type { TxnType } from "../../domain/types";

const NEEDS_SECURITY: TxnType[] = ["buy", "sell", "dividend"];
const NEEDS_QTY_PRICE: TxnType[] = ["buy", "sell"];

export function TransactionForm() {
  const { data: accounts = [] } = useAccounts();
  const { data: securities = [] } = useSecurities();
  const createTxn = useCreateTransaction();
  const qc = useQueryClient();

  const [accountId, setAccountId] = useState<number | "">("");
  const [type, setType] = useState<TxnType>("buy");
  const [ticker, setTicker] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [fees, setFees] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const acct = Number(accountId);
    if (!acct) { setError("Pick an account."); return; }

    let security_id: number | null = null;
    if (NEEDS_SECURITY.includes(type)) {
      if (!ticker.trim()) { setError("This type needs a ticker."); return; }
      const sec = await api.securities.getOrCreate(ticker.trim(), null, "stock");
      await qc.invalidateQueries({ queryKey: keys.securities });
      security_id = sec.id;
    }
    const qty = Number(quantity) || 0, pr = Number(price) || 0, fee = Number(fees) || 0;
    let amt = Number(amount) || 0;
    if (NEEDS_QTY_PRICE.includes(type)) amt = qty * pr;

    const txn: NewTransaction = {
      account_id: acct, security_id, type, date,
      quantity: qty, price: pr, amount: amt, fees: fee, note: null,
    };
    createTxn.mutate(txn, { onSuccess: () => { setQuantity(""); setPrice(""); setAmount(""); setFees(""); } });
  }

  const showSec = NEEDS_SECURITY.includes(type);
  const showQtyPrice = NEEDS_QTY_PRICE.includes(type);

  return (
    <form className="row" onSubmit={submit}>
      <label>Account
        <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
          <option value="">Select…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value as TxnType)}>
          {["buy","sell","dividend","deposit","withdrawal","fee","interest"].map((t) =>
            <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      {showSec && (
        <label>Ticker
          <input list="sec-list" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} />
          <datalist id="sec-list">{securities.map((s) => <option key={s.id} value={s.ticker} />)}</datalist>
        </label>
      )}
      <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {showQtyPrice ? (
        <>
          <label>Quantity<input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" /></label>
          <label>Price<input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></label>
          <label>Fees<input value={fees} onChange={(e) => setFees(e.target.value)} inputMode="decimal" /></label>
        </>
      ) : (
        <label>Amount<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
      )}
      <button type="submit">Add</button>
      {error && <span className="neg">{error}</span>}
    </form>
  );
}
```

- [ ] **Step 3: Commit (screens wired up in Task 17)**

```bash
git add -A
git commit -m "feat(activity): manual add-position and transaction forms"
```

---

## Phase 5 — Activity, dashboard, holdings, CSV import, snapshots

### Task 17: Activity screen (forms + transaction list + delete)

**Files:**
- Modify: `src/features/activity/Activity.tsx`

- [ ] **Step 1: Write `src/features/activity/Activity.tsx`**

```tsx
import { useState } from "react";
import { useTransactions, useSecurities, useAccounts, useDeleteTransaction } from "../../data/queries";
import { AddPositionForm } from "./AddPositionForm";
import { TransactionForm } from "./TransactionForm";
import { money, fmtDate } from "../../ui/format";

export function Activity() {
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();
  const { data: accounts = [] } = useAccounts();
  const del = useDeleteTransaction();
  const [tab, setTab] = useState<"position" | "transaction">("position");

  const secTicker = (id: number | null) => securities.find((s) => s.id === id)?.ticker ?? "—";
  const acctName = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Activity</h1>
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <button className={tab === "position" ? "" : "secondary"} onClick={() => setTab("position")}>Quick add position</button>
          <button className={tab === "transaction" ? "" : "secondary"} onClick={() => setTab("transaction")}>Add transaction</button>
        </div>
        {tab === "position" ? <AddPositionForm /> : <TransactionForm />}
      </div>
      <div className="card">
        {txns.length === 0 ? <p>No transactions yet.</p> : (
          <table>
            <thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Ticker</th><th>Qty</th><th>Price</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.date)}</td><td>{acctName(t.account_id)}</td><td>{t.type}</td>
                  <td>{secTicker(t.security_id)}</td>
                  <td>{t.quantity || "—"}</td><td>{t.price ? money(t.price) : "—"}</td>
                  <td>{money(t.amount)}</td>
                  <td><button className="secondary" onClick={() => del.mutate(t.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Manually verify end to end**

Run: `npm run tauri dev`. Create an account (Accounts). In Activity → Quick add
position, add VOO 10 sh @ 100. It appears in the transaction list. Add a deposit
via "Add transaction". Close.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(activity): activity screen with forms and transaction list"
```

### Task 18: Holdings screen

**Files:**
- Create: `src/data/usePortfolio.ts` (shared selector hook)
- Modify: `src/features/holdings/Holdings.tsx`

- [ ] **Step 1: Write `src/data/usePortfolio.ts`**

Central hook that pulls raw data and runs the domain functions once, reused by
Holdings and Dashboard.

```ts
import { useMemo } from "react";
import { useTransactions, useSecurities, useAccounts, useLatestPrices, usePreviousPrices } from "./queries";
import { buildPositions, aggregateHoldings, accountMarketValues } from "../domain/positions";
import { buildSummary } from "../domain/summary";
import { allocationByType, allocationByAccount } from "../domain/allocation";
import { totalCash } from "../domain/cash";

export function usePortfolio() {
  const { data: txns = [], isLoading: l1 } = useTransactions();
  const { data: securities = [], isLoading: l2 } = useSecurities();
  const { data: accounts = [], isLoading: l3 } = useAccounts();
  const { data: latest = [], isLoading: l4 } = useLatestPrices();
  const { data: previous = [], isLoading: l5 } = usePreviousPrices();

  return useMemo(() => {
    const latestMap = new Map<number, number>(latest);
    const prevMap = new Map<number, number>(previous);
    const positions = buildPositions(txns, latestMap);
    const holdings = aggregateHoldings(positions, securities);
    const cash = totalCash(txns);
    const summary = buildSummary(holdings, cash, prevMap);
    const acctValues = accountMarketValues(positions, txns);
    return {
      holdings, summary, cash,
      allocationType: allocationByType(holdings, cash),
      allocationAccount: allocationByAccount(acctValues, accounts),
      accountValues: acctValues, accounts,
      isLoading: l1 || l2 || l3 || l4 || l5,
    };
  }, [txns, securities, accounts, latest, previous, l1, l2, l3, l4, l5]);
}
```

- [ ] **Step 2: Write `src/features/holdings/Holdings.tsx`**

```tsx
import { usePortfolio } from "../../data/usePortfolio";
import { money, pct } from "../../ui/format";

export function Holdings() {
  const { holdings, isLoading } = usePortfolio();
  if (isLoading) return <p>Loading…</p>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Holdings</h1>
      <div className="card">
        {holdings.length === 0 ? <p>No holdings yet. Add a position in Activity.</p> : (
          <table>
            <thead><tr>
              <th>Ticker</th><th>Shares</th><th>Avg cost</th><th>Last</th>
              <th>Market value</th><th>Unrealized</th><th>%</th>
            </tr></thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.security_id}>
                  <td>{h.ticker}</td>
                  <td>{h.shares}</td>
                  <td>{money(h.avgCost)}</td>
                  <td>{h.lastPrice ? money(h.lastPrice) : "—"}</td>
                  <td>{money(h.marketValue)}</td>
                  <td className={h.unrealized >= 0 ? "pos" : "neg"}>{money(h.unrealized)}</td>
                  <td className={h.unrealizedPct >= 0 ? "pos" : "neg"}>{pct(h.unrealizedPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Manually verify**

Run: `npm run tauri dev`. With the VOO position added earlier, Holdings shows a
row. `Last`/`Market value` show "—" until prices are fetched (next: refresh in
Settings, Task 21) — that's expected. Close.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(holdings): holdings table with derived metrics"
```

### Task 19: Dashboard (KPIs + charts)

**Files:**
- Modify: `src/features/dashboard/Dashboard.tsx`

- [ ] **Step 1: Write `src/features/dashboard/Dashboard.tsx`**

```tsx
import { PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";
import { usePortfolio } from "../../data/usePortfolio";
import { useSnapshots } from "../../data/queries";
import { toValueSeries } from "../../domain/series";
import { money, pct } from "../../ui/format";

const COLORS = ["#4f46e5", "#16a34a", "#f59e0b", "#db2777", "#0891b2", "#7c3aed"];

export function Dashboard() {
  const { summary, allocationType, isLoading } = usePortfolio();
  const { data: snapshots = [] } = useSnapshots();
  const series = toValueSeries(snapshots);
  if (isLoading) return <p>Loading…</p>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Dashboard</h1>
      <div>
        <div style={{ color: "var(--mut)", fontSize: 12 }}>Total portfolio</div>
        <div style={{ fontSize: 32, fontWeight: 800 }}>{money(summary.totalValue)}</div>
        <div className={summary.dayChange >= 0 ? "pos" : "neg"}>
          {money(summary.dayChange)} today ({pct(summary.dayChangePct)})
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <Kpi label="Total gain" value={money(summary.unrealized)} tone={summary.unrealized} />
        <Kpi label="Return" value={pct(summary.unrealizedPct)} tone={summary.unrealizedPct} />
        <Kpi label="Realized" value={money(summary.realized)} tone={summary.realized} />
        <Kpi label="Cash" value={money(summary.cash)} />
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--mut)", marginBottom: 8 }}>Value over time</div>
          {series.length < 2 ? <p style={{ color: "var(--mut)" }}>Chart builds as daily snapshots accumulate.</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={series}>
                <XAxis dataKey="date" fontSize={11} /><YAxis fontSize={11} width={70} />
                <Tooltip formatter={(v: number) => money(v)} />
                <Line type="monotone" dataKey="value" stroke="#4f46e5" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="card">
          <div style={{ fontSize: 12, color: "var(--mut)", marginBottom: 8 }}>Allocation</div>
          {allocationType.length === 0 ? <p style={{ color: "var(--mut)" }}>No holdings yet.</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={allocationType} dataKey="value" nameKey="label" innerRadius={50} outerRadius={80}>
                  {allocationType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip formatter={(v: number) => money(v)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const cls = tone == null ? "" : tone >= 0 ? "pos" : "neg";
  return (
    <div className="card">
      <div style={{ fontSize: 10, textTransform: "uppercase", color: "var(--mut)" }}>{label}</div>
      <div className={cls} style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Manually verify**

Run: `npm run tauri dev`. Dashboard shows total value (cash + any priced
holdings), KPI cards, allocation donut (Cash slice at least), and the "chart
builds as snapshots accumulate" note. Close.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(dashboard): KPIs, allocation donut, value-over-time chart"
```

### Task 20: CSV import (pure parse/map/validate + wizard UI)

**Files:**
- Create: `src/features/activity/csvImport.ts`
- Create: `src/features/activity/csvImport.test.ts`
- Create: `src/features/activity/CsvImportForm.tsx`
- Modify: `src/features/activity/Activity.tsx` (add a third tab)

- [ ] **Step 1: Write the failing test `src/features/activity/csvImport.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { rowsToTransactions, type ColumnMap } from "./csvImport";

const map: ColumnMap = { date: "Date", type: "Action", ticker: "Symbol", quantity: "Qty", price: "Price", amount: "Amount", fees: "Fee" };

describe("rowsToTransactions", () => {
  it("maps valid rows and reports errors for bad ones", () => {
    const rows = [
      { Date: "2026-01-02", Action: "buy", Symbol: "VOO", Qty: "10", Price: "100", Amount: "", Fee: "1" },
      { Date: "", Action: "buy", Symbol: "AAPL", Qty: "5", Price: "150", Amount: "", Fee: "0" }, // missing date
      { Date: "2026-01-05", Action: "wat", Symbol: "X", Qty: "1", Price: "1", Amount: "", Fee: "0" }, // bad type
    ];
    const { valid, errors } = rowsToTransactions(rows, map, 7 /* accountId */);
    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ account_id: 7, type: "buy", quantity: 10, price: 100, fees: 1, amount: 1000 });
    expect(valid[0].tickerRaw).toBe("VOO");
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(2);
    expect(errors[1].reason).toMatch(/type/i);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- csvImport`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/features/activity/csvImport.ts`**

```ts
import type { TxnType } from "../../domain/types";

export interface ColumnMap {
  date: string; type: string; ticker: string;
  quantity: string; price: string; amount: string; fees: string;
}
/** A parsed row ready to import; carries the raw ticker so the caller can
 *  resolve it to a security_id via the backend before inserting. */
export interface StagedTxn {
  account_id: number; tickerRaw: string; security_id: number | null;
  type: TxnType; date: string; quantity: number; price: number; amount: number;
  fees: number; note: string | null;
}
export interface RowError { line: number; reason: string; }

const TYPES: TxnType[] = ["buy","sell","dividend","deposit","withdrawal","fee","interest"];
const NEEDS_SECURITY: TxnType[] = ["buy","sell","dividend"];
const NEEDS_QTY_PRICE: TxnType[] = ["buy","sell"];

const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[$,]/g, "").trim()); return isNaN(n) ? 0 : n; };

export function rowsToTransactions(
  rows: Record<string, string>[],
  map: ColumnMap,
  accountId: number,
): { valid: StagedTxn[]; errors: RowError[] } {
  const valid: StagedTxn[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    const line = i + 1;
    const date = (row[map.date] ?? "").trim();
    const rawType = (row[map.type] ?? "").trim().toLowerCase();
    const ticker = (row[map.ticker] ?? "").trim().toUpperCase();

    if (!date) { errors.push({ line, reason: "Missing date" }); return; }
    if (!TYPES.includes(rawType as TxnType)) { errors.push({ line, reason: `Unknown type "${rawType}"` }); return; }
    const type = rawType as TxnType;
    if (NEEDS_SECURITY.includes(type) && !ticker) { errors.push({ line, reason: `Type "${type}" needs a ticker` }); return; }

    const quantity = num(row[map.quantity]);
    const price = num(row[map.price]);
    const fees = num(row[map.fees]);
    let amount = num(row[map.amount]);
    if (NEEDS_QTY_PRICE.includes(type)) amount = quantity * price;

    valid.push({
      account_id: accountId, tickerRaw: NEEDS_SECURITY.includes(type) ? ticker : "",
      security_id: null, type, date, quantity, price, amount, fees, note: "CSV import",
    });
  });

  return { valid, errors };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- csvImport`
Expected: PASS.

- [ ] **Step 5: Implement `src/features/activity/CsvImportForm.tsx`**

```tsx
import { useState } from "react";
import Papa from "papaparse";
import { useAccounts } from "../../data/queries";
import { api } from "../../data/api";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../../data/queries";
import { rowsToTransactions, type ColumnMap, type StagedTxn, type RowError } from "./csvImport";
import { money } from "../../ui/format";

const FIELDS: (keyof ColumnMap)[] = ["date","type","ticker","quantity","price","amount","fees"];

export function CsvImport() {
  const { data: accounts = [] } = useAccounts();
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState<number | "">("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [map, setMap] = useState<ColumnMap>({ date:"",type:"",ticker:"",quantity:"",price:"",amount:"",fees:"" });
  const [preview, setPreview] = useState<{ valid: StagedTxn[]; errors: RowError[] } | null>(null);
  const [done, setDone] = useState("");

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    Papa.parse<Record<string, string>>(file, {
      header: true, skipEmptyLines: true,
      complete: (res) => {
        setHeaders(res.meta.fields ?? []);
        setRows(res.data);
        setPreview(null); setDone("");
      },
    });
  }

  function buildPreview() {
    if (!accountId) return;
    setPreview(rowsToTransactions(rows, map, Number(accountId)));
  }

  async function commit() {
    if (!preview) return;
    // resolve tickers → security ids
    const resolved = [];
    for (const t of preview.valid) {
      let security_id = t.security_id;
      if (t.tickerRaw) {
        const sec = await api.securities.getOrCreate(t.tickerRaw, null, "stock");
        security_id = sec.id;
      }
      resolved.push({ account_id: t.account_id, security_id, type: t.type, date: t.date,
        quantity: t.quantity, price: t.price, amount: t.amount, fees: t.fees, note: t.note });
    }
    const n = await api.transactions.createMany(resolved);
    await qc.invalidateQueries({ queryKey: keys.transactions });
    await qc.invalidateQueries({ queryKey: keys.securities });
    setDone(`Imported ${n} transactions.`);
    setPreview(null); setRows([]); setHeaders([]);
  }

  return (
    <div className="grid" style={{ gap: 12 }}>
      <div className="row">
        <label>Into account
          <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Select…</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>CSV file<input type="file" accept=".csv" onChange={onFile} /></label>
      </div>

      {headers.length > 0 && (
        <div className="row">
          {FIELDS.map((f) => (
            <label key={f}>{f}
              <select value={map[f]} onChange={(e) => setMap({ ...map, [f]: e.target.value })}>
                <option value="">—</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </label>
          ))}
          <button onClick={buildPreview} disabled={!accountId || !map.date || !map.type}>Preview</button>
        </div>
      )}

      {preview && (
        <div className="card">
          <p>{preview.valid.length} valid, <span className="neg">{preview.errors.length} skipped</span>.</p>
          {preview.errors.slice(0, 5).map((e, i) => <div key={i} className="neg">Line {e.line}: {e.reason}</div>)}
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Ticker</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead>
            <tbody>
              {preview.valid.slice(0, 10).map((t, i) => (
                <tr key={i}><td>{t.date}</td><td>{t.type}</td><td>{t.tickerRaw || "—"}</td>
                  <td>{t.quantity || "—"}</td><td>{t.price ? money(t.price) : "—"}</td><td>{money(t.amount)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="row"><button onClick={commit} disabled={preview.valid.length === 0}>Import {preview.valid.length}</button></div>
        </div>
      )}
      {done && <p className="pos">{done}</p>}
    </div>
  );
}
```

- [ ] **Step 6: Add a CSV tab to `src/features/activity/Activity.tsx`**

Add `"csv"` to the tab union and a third button + panel. Change the tab state
line to:
```tsx
  const [tab, setTab] = useState<"position" | "transaction" | "csv">("position");
```
Add the import at the top: `import { CsvImport } from "./CsvImportForm";`
Add a third button in the button row:
```tsx
          <button className={tab === "csv" ? "" : "secondary"} onClick={() => setTab("csv")}>Import CSV</button>
```
And render it by replacing the panel line with:
```tsx
        {tab === "position" ? <AddPositionForm /> : tab === "transaction" ? <TransactionForm /> : <CsvImport />}
```

- [ ] **Step 7: Manually verify**

Create a small CSV with headers `Date,Action,Symbol,Qty,Price,Amount,Fee` and a
couple of `buy` rows plus one bad row. Run `npm run tauri dev` → Activity →
Import CSV → pick account → choose file → map columns → Preview (bad row shows as
skipped) → Import. Rows appear in the list. Close.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(activity): CSV import with column mapping and preview"
```

### Task 21: Settings — price refresh + daily snapshot

**Files:**
- Modify: `src/features/settings/Settings.tsx`
- Create: `src/data/useRefresh.ts`

- [ ] **Step 1: Write `src/data/useRefresh.ts`**

Refreshes prices, then records today's snapshot from the freshly computed total.

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { keys } from "./queries";
import { buildPositions, aggregateHoldings } from "../domain/positions";
import { totalCash } from "../domain/cash";

export function useRefreshPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const updated = await api.prices.refresh();
      await qc.invalidateQueries({ queryKey: keys.latest });
      await qc.invalidateQueries({ queryKey: keys.previous });

      // recompute total value and record today's snapshot
      const [txns, securities, latest] = await Promise.all([
        api.transactions.list(), api.securities.list(), api.prices.latest(),
      ]);
      const holdings = aggregateHoldings(buildPositions(txns, new Map(latest)), securities);
      const invested = holdings.reduce((s, h) => s + h.marketValue, 0);
      const total = invested + totalCash(txns);
      await api.snapshots.record(new Date().toISOString().slice(0, 10), total);
      await qc.invalidateQueries({ queryKey: keys.snapshots });
      return updated;
    },
  });
}
```

- [ ] **Step 2: Write `src/features/settings/Settings.tsx`**

```tsx
import { useRefreshPrices } from "../../data/useRefresh";

export function Settings() {
  const refresh = useRefreshPrices();
  return (
    <div className="grid" style={{ gap: 16 }}>
      <h1>Settings</h1>
      <div className="card grid" style={{ gap: 8 }}>
        <h3 style={{ margin: 0 }}>Prices</h3>
        <p style={{ color: "var(--mut)", margin: 0 }}>
          Fetch the latest closing prices for your tickers (keyless, from a free public source),
          then record today's portfolio value for the chart.
        </p>
        <div className="row">
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Refreshing…" : "Refresh prices now"}
          </button>
          {refresh.isSuccess && <span className="pos">Updated {refresh.data} securities.</span>}
          {refresh.isError && <span className="neg">Refresh failed — check your connection.</span>}
        </div>
      </div>
      <div className="card">
        <h3 style={{ margin: "0 0 8px" }}>Coming later</h3>
        <ul style={{ color: "var(--mut)" }}>
          <li>SimpleFIN auto-sync</li>
          <li>Encrypted database + app lock (Windows Hello / passkey)</li>
          <li>Budgeting module</li>
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Manually verify the full loop**

Run: `npm run tauri dev`. Ensure you have a holding (e.g. VOO). Go to Settings →
Refresh prices now → "Updated N securities". Holdings now shows Last/Market
value; Dashboard total updates; after refreshing on two different days the
value-over-time chart begins to draw. Close.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(settings): price refresh and daily snapshot recording"
```

---

## Phase 6 — Package the exe

### Task 22: Name the app and build the installer

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml` (package name, optional)

- [ ] **Step 1: Set the product name and identifier**

In `src-tauri/tauri.conf.json` set:
```json
{
  "productName": "MyFinance",
  "identifier": "com.myfinance.app",
  "version": "0.1.0"
}
```
(Replace `MyFinance` / identifier with the real chosen name before release. The
identifier must be reverse-domain and unique.)

- [ ] **Step 2: Confirm the app window title**

In `src-tauri/tauri.conf.json` under `app.windows[0]`, set `"title": "MyFinance"`.

- [ ] **Step 3: Build the release bundle**

Run: `npm run tauri build`
Expected: after compiling, prints paths to the built artifacts under
`src-tauri/target/release/bundle/` — an `.exe` (in `.../nsis/` or `.../msi/`).
First build is slow.

- [ ] **Step 4: Smoke-test the built app**

Run the produced installer/exe from `src-tauri/target/release/bundle/…`. The app
launches as a standalone window, and data you enter persists across restarts
(stored under `%APPDATA%\com.myfinance.app\finance.sqlite`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: set product name/identifier and enable release build"
```

---

## Final verification

- [ ] **Run the whole test suite**

Run: `npm test && (cd src-tauri && cargo test)`
Expected: all TypeScript domain/format/csv suites pass; all Rust command/db/price
suites pass.

- [ ] **End-to-end manual pass** (`npm run tauri dev`)

1. Create a brokerage account and a cash account.
2. Quick-add a couple of stock/ETF positions with cost basis.
3. Add a deposit and a dividend transaction.
4. Import a small CSV (with one intentionally bad row → shown as skipped).
5. Settings → Refresh prices → Holdings/Dashboard update.
6. Confirm Dashboard totals, allocation donut, and holdings gains look right.
7. Delete a transaction and confirm figures recompute.

---

## Self-review notes (author)

- **Spec coverage:** accounts, stocks/ETFs + cost-basis lots (avg-cost via
  transactions), cash, manual entry (quick-add + full form), CSV import
  (map + preview + commit), keyless prices + manual override
  (`prices_set_manual`) + stale behavior (last-known price retained on failure),
  dashboard metrics (§4 of spec), value-over-time via forward snapshots,
  allocation by type and account, layered architecture with the four extension
  seams (account-source via CSV/manual + `create_many`, price-provider trait,
  secrets stubbed, single DB module), local SQLite, USD-only, exe packaging —
  all present.
- **Deferred (per spec):** SimpleFIN adapter, encryption/auth, budgeting, crypto/
  manual assets, advanced returns, historical backfill, multi-currency — not in
  this plan by design.
- **Secrets seam:** the spec calls for a `secrets` interface stub. It is created
  as `src-tauri/src/secrets.rs` in the file map; since nothing in v1 stores a
  secret (no SimpleFIN yet), add it as a trivial `pub trait Secrets { }` +
  `pub struct NoopSecrets;` only when the SimpleFIN task arrives — do not wire it
  now (YAGNI). This is the one intentional deviation from eager creation.
- **Type consistency:** `NewTransaction`/`NewAccount` shapes match between
  `api.ts` and Rust `models.rs`; invoke arg names are camelCased to match Tauri's
  default (`securityId`, `totalValue`); domain function names
  (`buildPositions`/`aggregateHoldings`/`accountMarketValues`/`buildSummary`/
  `allocationByType`/`allocationByAccount`/`toValueSeries`/`cashEffect`/
  `totalCash`/`cashByAccount`) are used identically in tests, `usePortfolio`, and
  `useRefresh`.
```
