# UI Redesign + SimpleFIN Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Ledgerly a modern light/dark UI built from small shared components, and add SimpleFIN sync (balances + holdings) with the access URL kept in Windows Credential Manager.

**Architecture:** Two workstreams. **B-Rust** (Tasks 1–6) adds a `simplefin` module, a `secrets` module, schema v2, and Tauri commands — pure parsing and sync logic are unit-tested against fixtures and an in-memory SQLite. **A-UI** (Tasks 7–14) adds theme tokens, a `useTheme` provider, shared components in `src/ui/`, and restyles every screen without changing behaviour. **Integration** (Tasks 15–18) moves portfolio derivation into a pure `derivePortfolio()` that merges synced holdings/balances, wires the SimpleFIN commands into Settings and the sidebar, and updates docs.

**Tech Stack:** Tauri v2, Rust (rusqlite, reqwest blocking, serde_json, keyring 3, base64, percent-encoding, chrono), React 19 + TypeScript, TanStack Query, Recharts, Vitest + Testing Library. Plain CSS variables (no UI framework).

**Spec:** `docs/superpowers/specs/2026-09-07-ui-redesign-and-simplefin-design.md`

**Conventions for every task:**
- Windows PowerShell 5.1: run commands on separate lines, never join with `&&`.
- Rust tests: `cd src-tauri` then `cargo test`. TS tests: `npm test` from the repo root. Type-check: `npx tsc --noEmit`.
- Commit after each task with the message shown. All commits end with the line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tasks 1–6 and Tasks 7–14 touch disjoint files and may run in parallel. Tasks 15–18 run after both are done, in order.

---

## File map

**Created (Rust)**
- `src-tauri/src/secrets.rs` — Credential Manager get/set/delete.
- `src-tauri/src/simplefin/mod.rs` — module root, re-exports.
- `src-tauri/src/simplefin/parse.rs` — pure parsing of setup tokens and `/accounts` JSON.
- `src-tauri/src/simplefin/client.rs` — HTTP claim + fetch.
- `src-tauri/src/simplefin/sync.rs` — write SimpleFIN accounts/holdings into SQLite.
- `src-tauri/src/commands/simplefin.rs` — Tauri commands.

**Modified (Rust)**
- `src-tauri/Cargo.toml` — deps.
- `src-tauri/src/db.rs` — migration v2.
- `src-tauri/src/models.rs` — `Account` new fields, `SyncedHolding`.
- `src-tauri/src/commands/accounts.rs` — select/return new fields.
- `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` — register.

**Created (TS)**
- `src/ui/theme.tsx` (+ `theme.test.ts`) — theme preference + provider.
- `src/ui/toast.tsx` — toast provider.
- `src/ui/components.tsx` (+ `components.test.tsx`) — PageHeader, Card, StatCard, Button, Badge, EmptyState, Tabs, Field.
- `src/ui/DataTable.tsx` — table.
- `src/ui/ThemeToggle.tsx` — segmented control.
- `src/ui/chartColors.ts` — read `--chart-*` tokens.
- `src/app/icons.tsx` — inline SVG icons.
- `src/app/SyncButton.tsx` — sidebar sync control.
- `src/domain/synced.ts` (+ test) — synced positions + cash merge.
- `src/domain/portfolio.ts` (+ test) — `derivePortfolio()` pure derivation.
- `src/features/settings/SimplefinCard.tsx` — connect / sync / disconnect UI.

**Modified (TS)**
- `src/styles.css` — full rewrite.
- `src/App.tsx`, `src/app/AppShell.tsx`, `src/app/Sidebar.tsx`.
- `src/features/**` screens.
- `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts`, `src/data/usePortfolio.ts`, `src/data/useRefresh.ts`, `src/ui/format.ts`.
- `src/domain/allocation.test.ts` — account fixtures gain the new fields.
- `docs/HANDOFF.md`.

---

# Workstream B-Rust

### Task 1: Dependencies + secrets module

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/secrets.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod secrets;`)

- [ ] **Step 1: Add dependencies**

In `src-tauri/Cargo.toml`, under `[dependencies]`, add:

```toml
keyring = { version = "3", features = ["windows-native"] }
base64 = "0.22"
percent-encoding = "2"
```

- [ ] **Step 2: Create `src-tauri/src/secrets.rs`**

```rust
//! Secrets live in the OS credential store (Windows Credential Manager),
//! never in SQLite or logs. Keys are short identifiers like
//! "simplefin_access_url".
use keyring::{Entry, Error};

const SERVICE: &str = "Ledgerly";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("Credential store unavailable: {e}"))
}

/// Read a secret. `Ok(None)` when nothing is stored under `key`.
pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Couldn't read from the credential store: {e}")),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("Couldn't save to the credential store: {e}"))
}

/// Remove a secret. Succeeds if it was already absent.
pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Couldn't remove from the credential store: {e}")),
    }
}
```

- [ ] **Step 3: Register the module**

In `src-tauri/src/lib.rs`, after `mod prices;` add:

```rust
mod secrets;
```

- [ ] **Step 4: Build to verify**

Run (from `src-tauri`): `cargo build`
Expected: compiles. (The `secrets` module may warn as unused until Task 6 — that's fine.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/secrets.rs src-tauri/src/lib.rs
git commit -m "feat(core): add secrets module backed by Windows Credential Manager"
```

---

### Task 2: Schema v2 migration + models

**Files:**
- Modify: `src-tauri/src/db.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/commands/accounts.rs`

- [ ] **Step 1: Write the failing migration test**

In `src-tauri/src/db.rs`, inside `mod tests`, add:

```rust
    #[test]
    fn migrates_v1_database_to_v2() {
        // Build a v1 database by hand, then run the migrations on it.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch("PRAGMA user_version = 1;").unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,institution,currency,created_at)
             VALUES ('Old','brokerage',NULL,'USD','2026-01-01')",
            [],
        ).unwrap();

        apply_migrations(&conn).unwrap();

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 2);
        // existing rows default to manual
        let source: String = conn
            .query_row("SELECT source FROM accounts WHERE name='Old'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "manual");
        let has_table: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='synced_holdings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_table, 1);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test migrates_v1_database_to_v2`
Expected: FAIL — version is 1, `source` column missing.

- [ ] **Step 3: Implement the migration**

Replace the `TARGET_VERSION` constant and `apply_migrations` in `src-tauri/src/db.rs` with:

```rust
/// Version-gated migrations. v1 is the whole base schema; v2 adds SimpleFIN
/// sync columns and the synced_holdings table. To add a change later: bump
/// TARGET_VERSION and add another `if current < N` block.
const TARGET_VERSION: i64 = 2;

const MIGRATION_2: &str = "
ALTER TABLE accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual','simplefin'));
ALTER TABLE accounts ADD COLUMN external_id TEXT;
ALTER TABLE accounts ADD COLUMN synced_balance REAL;
ALTER TABLE accounts ADD COLUMN last_synced_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_external_id
  ON accounts(external_id) WHERE external_id IS NOT NULL;
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
";

fn apply_migrations(conn: &Connection) -> rusqlite::Result<()> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current < 1 {
        conn.execute_batch(SCHEMA)?;
    }
    if current < 2 {
        conn.execute_batch(MIGRATION_2)?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {};", TARGET_VERSION))?;
    Ok(())
}
```

- [ ] **Step 4: Update models**

In `src-tauri/src/models.rs`, replace the `Account` struct with:

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub institution: Option<String>,
    pub currency: String,
    pub created_at: String,
    /// "manual" or "simplefin"
    pub source: String,
    /// SimpleFIN account id when source == "simplefin"
    pub external_id: Option<String>,
    /// Cash balance reported by SimpleFIN at the last sync
    pub synced_balance: Option<f64>,
    /// RFC3339 timestamp of the last successful sync
    pub last_synced_at: Option<String>,
}
```

and append at the end of the file:

```rust
#[derive(Serialize, Deserialize, Clone)]
pub struct SyncedHolding {
    pub id: i64,
    pub account_id: i64,
    pub security_id: i64,
    pub shares: f64,
    pub cost_basis: f64,
    pub market_value: f64,
    pub as_of: String,
}
```

- [ ] **Step 5: Update account queries**

In `src-tauri/src/commands/accounts.rs`, replace the SELECT strings and `row_to_account`:

```rust
const COLS: &str = "id,name,type,institution,currency,created_at,source,external_id,synced_balance,last_synced_at";

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Account> {
    conn.query_row(
        &format!("SELECT {COLS} FROM accounts WHERE id=?1"),
        [id],
        row_to_account,
    )
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Account>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM accounts ORDER BY name"))?;
    let rows = stmt.query_map([], row_to_account)?;
    rows.collect()
}

fn row_to_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        name: r.get(1)?,
        type_: r.get(2)?,
        institution: r.get(3)?,
        currency: r.get(4)?,
        created_at: r.get(5)?,
        source: r.get(6)?,
        external_id: r.get(7)?,
        synced_balance: r.get(8)?,
        last_synced_at: r.get(9)?,
    })
}
```

Add to the existing `create_then_list_returns_account` test, after the currency assertion:

```rust
        assert_eq!(all[0].source, "manual");
        assert!(all[0].external_id.is_none());
```

- [ ] **Step 6: Run all Rust tests**

Run: `cargo test`
Expected: all pass, including `migrates_v1_database_to_v2` and the existing `migrations_create_all_tables_and_set_version` (its `TARGET_VERSION` assertion now reads 2).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/models.rs src-tauri/src/commands/accounts.rs
git commit -m "feat(db): schema v2 with account sync fields and synced_holdings"
```

---

### Task 3: SimpleFIN parsing (pure)

**Files:**
- Create: `src-tauri/src/simplefin/mod.rs`
- Create: `src-tauri/src/simplefin/parse.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod simplefin;`)

- [ ] **Step 1: Create the module root**

`src-tauri/src/simplefin/mod.rs`:

```rust
//! SimpleFIN Bridge integration: token claim, account fetch, and sync into
//! SQLite. `parse` is pure and fixture-tested; `client` does HTTP; `sync`
//! writes to the database.
pub mod parse;
pub mod client;
pub mod sync;

pub use parse::{SfAccount, SfAccountSet, SfHolding};
pub use sync::SyncReport;
```

(`client` and `sync` are created in Tasks 4 and 5. Until then, create them as empty files so the crate compiles: `src-tauri/src/simplefin/client.rs` and `src-tauri/src/simplefin/sync.rs` each containing only `// filled in by a later task`, and temporarily comment out the `pub use sync::SyncReport;` line — Task 5 restores it.)

In `src-tauri/src/lib.rs` add `mod simplefin;` after `mod secrets;`.

- [ ] **Step 2: Write the failing parse tests**

`src-tauri/src/simplefin/parse.rs` — start with the tests block only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const DEMO_JSON: &str = r#"{"errors":[],"accounts":[
      {"id":"Demo Savings","name":"SimpleFIN Savings","currency":"USD","balance":"114405.51",
       "available-balance":"114405.51","balance-date":1788912000,"transactions":[],"holdings":[],
       "org":{"domain":"beta-bridge.simplefin.org","name":"SimpleFIN Demo","sfin-url":"x","url":"y","id":"simplefin.demoorg"}},
      {"id":"Demo Checking","name":"SimpleFIN Checking","currency":"USD","balance":"24668.87",
       "balance-date":1788912000,"transactions":[],"holdings":[],
       "org":{"name":"SimpleFIN Demo"}}
    ]}"#;

    const BROKERAGE_JSON: &str = r#"{"errors":["Connection to Fidelity may need attention"],"accounts":[
      {"id":"ACT-1","name":"Roth IRA","currency":"USD","balance":"250.10","balance-date":1788912000,
       "holdings":[
         {"id":"h1","symbol":"vti","description":"Vanguard Total Stock Market ETF","shares":"10.5","cost_basis":"2000.00","market_value":"2500.00","purchase_price":"190.48"},
         {"id":"h2","symbol":"","description":"Money Market Fund","shares":"5","cost_basis":"5","market_value":"5"},
         {"id":"h3","symbol":"AAPL","description":"Apple Inc","shares":2,"cost_basis":300,"market_value":"400"}
       ],
       "org":{"name":"Fidelity"}}
    ]}"#;

    const V2_JSON: &str = r#"{"errlist":[{"code":"E1","msg":"Bank needs re-auth"}],
      "connections":[{"conn_id":"c1","name":"Chase","org_id":"o1","sfin_url":"x"}],
      "accounts":[{"id":"A9","name":"Checking","conn_id":"c1","currency":"USD","balance":"12.00","balance-date":1788912000}]}"#;

    #[test]
    fn decodes_setup_token_to_claim_url() {
        let token = "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9kZW1v";
        assert_eq!(
            decode_setup_token(token).unwrap(),
            "https://beta-bridge.simplefin.org/simplefin/claim/demo"
        );
    }

    #[test]
    fn decodes_setup_token_with_whitespace_and_no_padding() {
        let token = " aHR0cHM6Ly9leGFtcGxlLmNvbS9jbGFpbS9hYmM\n";
        assert_eq!(decode_setup_token(token).unwrap(), "https://example.com/claim/abc");
    }

    #[test]
    fn rejects_garbage_token() {
        assert!(decode_setup_token("not a token!!").is_err());
        assert!(decode_setup_token("").is_err());
        // valid base64 but not an https URL
        assert!(decode_setup_token("aGVsbG8=").is_err());
    }

    #[test]
    fn parses_demo_feed() {
        let set = parse_accounts_json(DEMO_JSON).unwrap();
        assert!(set.errors.is_empty());
        assert_eq!(set.accounts.len(), 2);
        let a = &set.accounts[0];
        assert_eq!(a.id, "Demo Savings");
        assert_eq!(a.name, "SimpleFIN Savings");
        assert_eq!(a.institution, "SimpleFIN Demo");
        assert!((a.balance - 114405.51).abs() < 1e-9);
        assert_eq!(a.balance_date, "2026-09-08");
        assert!(a.holdings.is_empty());
    }

    #[test]
    fn parses_holdings_and_errors() {
        let set = parse_accounts_json(BROKERAGE_JSON).unwrap();
        assert_eq!(set.errors, vec!["Connection to Fidelity may need attention".to_string()]);
        let a = &set.accounts[0];
        assert_eq!(a.institution, "Fidelity");
        assert_eq!(a.holdings.len(), 3);
        assert_eq!(a.holdings[0].symbol, "VTI"); // upper-cased
        assert!((a.holdings[0].shares - 10.5).abs() < 1e-9);
        assert!((a.holdings[0].cost_basis - 2000.0).abs() < 1e-9);
        assert!((a.holdings[0].market_value - 2500.0).abs() < 1e-9);
        assert_eq!(a.holdings[1].symbol, ""); // symbol-less kept; sync skips it
        assert!((a.holdings[2].shares - 2.0).abs() < 1e-9); // numeric JSON accepted
        assert!((a.holdings[2].cost_basis - 300.0).abs() < 1e-9);
    }

    #[test]
    fn parses_v2_shape() {
        let set = parse_accounts_json(V2_JSON).unwrap();
        assert_eq!(set.errors, vec!["Bank needs re-auth".to_string()]);
        assert_eq!(set.accounts[0].institution, "Chase");
        assert!((set.accounts[0].balance - 12.0).abs() < 1e-9);
    }

    #[test]
    fn money_handles_strings_numbers_and_junk() {
        use serde_json::json;
        assert_eq!(money(&json!("1,234.50")), 1234.5);
        assert_eq!(money(&json!(-3)), -3.0);
        assert_eq!(money(&json!("abc")), 0.0);
        assert_eq!(money(&json!(null)), 0.0);
    }

    #[test]
    fn malformed_json_is_a_readable_error() {
        let err = parse_accounts_json("<html>").unwrap_err();
        assert!(err.contains("couldn't read"));
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cargo test simplefin::parse`
Expected: compile errors (functions not defined).

- [ ] **Step 4: Implement `parse.rs`** (above the tests block)

```rust
//! Pure parsing of SimpleFIN data. No I/O — everything here is unit-tested
//! against fixtures.
use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct SfHolding {
    /// Upper-cased ticker; empty when SimpleFIN doesn't provide one.
    pub symbol: String,
    pub description: String,
    pub shares: f64,
    pub cost_basis: f64,
    pub market_value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SfAccount {
    pub id: String,
    pub name: String,
    pub institution: String,
    pub currency: String,
    pub balance: f64,
    /// YYYY-MM-DD derived from `balance-date`
    pub balance_date: String,
    pub holdings: Vec<SfHolding>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SfAccountSet {
    pub errors: Vec<String>,
    pub accounts: Vec<SfAccount>,
}

const BAD_TOKEN: &str = "That doesn't look like a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge and try again.";

/// A setup token is base64 of an https claim URL. Tolerates surrounding
/// whitespace, URL-safe alphabet, and missing padding.
pub fn decode_setup_token(token: &str) -> Result<String, String> {
    let cleaned: String = token.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Err("Paste your SimpleFIN setup token first.".into());
    }
    use base64::engine::general_purpose as b64;
    let bytes = b64::STANDARD
        .decode(&cleaned)
        .or_else(|_| b64::STANDARD_NO_PAD.decode(&cleaned))
        .or_else(|_| b64::URL_SAFE.decode(&cleaned))
        .or_else(|_| b64::URL_SAFE_NO_PAD.decode(&cleaned))
        .map_err(|_| BAD_TOKEN.to_string())?;
    let url = String::from_utf8(bytes).map_err(|_| BAD_TOKEN.to_string())?;
    let url = url.trim().to_string();
    if !url.starts_with("https://") {
        return Err(BAD_TOKEN.into());
    }
    Ok(url)
}

/// SimpleFIN sends money as strings ("1234.56"); be lenient about numbers
/// and thousands separators. Anything unparseable is 0.
pub fn money(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().replace(',', "").parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Unix seconds (number or numeric string) → YYYY-MM-DD (UTC). Falls back to today.
pub fn epoch_to_date(v: &Value) -> String {
    let secs = v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()));
    secs.and_then(|s| chrono::DateTime::from_timestamp(s, 0))
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(today)
}

/// Parse a `/accounts` response. Accepts protocol v1 (`errors`, `org`) and
/// v2 (`errlist`, `connections`).
pub fn parse_accounts_json(body: &str) -> Result<SfAccountSet, String> {
    let root: Value = serde_json::from_str(body)
        .map_err(|_| "SimpleFIN sent a response Ledgerly couldn't read. Try again in a minute.".to_string())?;

    let mut errors: Vec<String> = Vec::new();
    if let Some(arr) = root.get("errors").and_then(Value::as_array) {
        errors.extend(arr.iter().filter_map(Value::as_str).map(str::to_string));
    }
    if let Some(arr) = root.get("errlist").and_then(Value::as_array) {
        errors.extend(arr.iter().map(|e| {
            e.get("msg").and_then(Value::as_str).unwrap_or("Unknown SimpleFIN error").to_string()
        }));
    }

    let mut connections: HashMap<String, String> = HashMap::new();
    if let Some(arr) = root.get("connections").and_then(Value::as_array) {
        for c in arr {
            if let (Some(id), Some(name)) =
                (c.get("conn_id").and_then(Value::as_str), c.get("name").and_then(Value::as_str))
            {
                connections.insert(id.to_string(), name.to_string());
            }
        }
    }

    let accounts = root
        .get("accounts")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|a| parse_account(a, &connections)).collect())
        .unwrap_or_default();

    Ok(SfAccountSet { errors, accounts })
}

fn parse_account(a: &Value, connections: &HashMap<String, String>) -> Option<SfAccount> {
    let id = a.get("id")?.as_str()?.to_string();
    let name = a.get("name").and_then(Value::as_str).unwrap_or("Account").to_string();
    let institution = a
        .get("org")
        .and_then(|o| o.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            a.get("conn_id")
                .and_then(Value::as_str)
                .and_then(|c| connections.get(c).cloned())
        })
        .unwrap_or_else(|| "SimpleFIN".to_string());
    let currency = a.get("currency").and_then(Value::as_str).unwrap_or("USD").to_string();
    let balance = a.get("balance").map(money).unwrap_or(0.0);
    let balance_date = a.get("balance-date").map(epoch_to_date).unwrap_or_else(today);
    let holdings = a
        .get("holdings")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(parse_holding).collect())
        .unwrap_or_default();
    Some(SfAccount { id, name, institution, currency, balance, balance_date, holdings })
}

fn parse_holding(h: &Value) -> SfHolding {
    let text = |k: &str| h.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let num = |k: &str| h.get(k).map(money).unwrap_or(0.0);
    SfHolding {
        symbol: text("symbol").to_uppercase(),
        description: text("description"),
        shares: num("shares"),
        cost_basis: num("cost_basis"),
        market_value: num("market_value"),
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test simplefin::parse`
Expected: 8 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/simplefin src-tauri/src/lib.rs
git commit -m "feat(simplefin): pure parser for setup tokens and account feeds"
```

---

### Task 4: SimpleFIN HTTP client

**Files:**
- Create (replace stub): `src-tauri/src/simplefin/client.rs`

- [ ] **Step 1: Write the failing test for URL preparation**

`src-tauri/src/simplefin/client.rs` tests block:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_credentials_and_builds_accounts_url() {
        let (url, user, pass) =
            accounts_request_parts("https://demo:p%40ss@beta-bridge.simplefin.org/simplefin").unwrap();
        assert_eq!(url, "https://beta-bridge.simplefin.org/simplefin/accounts?balances-only=1");
        assert_eq!(user, "demo");
        assert_eq!(pass.as_deref(), Some("p@ss")); // percent-decoded
    }

    #[test]
    fn tolerates_trailing_slash() {
        let (url, _, _) = accounts_request_parts("https://u:p@host/simplefin/").unwrap();
        assert_eq!(url, "https://host/simplefin/accounts?balances-only=1");
    }

    #[test]
    fn rejects_invalid_url() {
        assert!(accounts_request_parts("nope").is_err());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test simplefin::client`
Expected: compile error, `accounts_request_parts` missing.

- [ ] **Step 3: Implement `client.rs`** (above tests)

```rust
//! HTTP calls to SimpleFIN Bridge. Errors are plain-English strings meant to
//! be shown directly in the UI.
use super::parse::{self, SfAccountSet};
use std::time::Duration;

pub const NETWORK_ERR: &str =
    "Couldn't reach SimpleFIN. Check your internet connection and try again.";
const BAD_STORED: &str =
    "The saved SimpleFIN connection is invalid. Disconnect, then connect again with a new setup token.";

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Ledgerly/0.1 (Windows; +https://github.com/willbpeters/Ledgerly)")
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

/// Exchange a one-time setup token for a permanent access URL.
pub fn claim(setup_token: &str) -> Result<String, String> {
    let claim_url = parse::decode_setup_token(setup_token)?;
    let resp = http()?
        .post(&claim_url)
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .send()
        .map_err(|_| NETWORK_ERR.to_string())?;
    match resp.status().as_u16() {
        200 => {
            let url = resp.text().map_err(|_| NETWORK_ERR.to_string())?.trim().to_string();
            if url.starts_with("http") {
                Ok(url)
            } else {
                Err("SimpleFIN returned an unexpected reply while connecting. Generate a fresh setup token and try again.".into())
            }
        }
        403 => Err("That setup token has already been used or has expired. Generate a new one in SimpleFIN Bridge and paste it here.".into()),
        s => Err(format!("SimpleFIN returned an unexpected status ({s}) while connecting. Try again later.")),
    }
}

/// Split `https://user:pass@host/simplefin` into
/// (`https://host/simplefin/accounts?balances-only=1`, user, pass).
pub fn accounts_request_parts(access_url: &str) -> Result<(String, String, Option<String>), String> {
    let mut url = reqwest::Url::parse(access_url).map_err(|_| BAD_STORED.to_string())?;
    if !url.has_host() {
        return Err(BAD_STORED.into());
    }
    let decode = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string();
    let user = decode(url.username());
    let pass = url.password().map(decode);
    url.set_username("").ok();
    url.set_password(None).ok();
    let path = format!("{}/accounts", url.path().trim_end_matches('/'));
    url.set_path(&path);
    url.set_query(Some("balances-only=1"));
    Ok((url.to_string(), user, pass))
}

/// Fetch every account (balances + holdings, no transactions).
pub fn fetch_accounts(access_url: &str) -> Result<SfAccountSet, String> {
    let (url, user, pass) = accounts_request_parts(access_url)?;
    let mut req = http()?.get(url);
    if !user.is_empty() {
        req = req.basic_auth(user, pass);
    }
    let resp = req.send().map_err(|_| NETWORK_ERR.to_string())?;
    match resp.status().as_u16() {
        200 => {
            let body = resp.text().map_err(|_| NETWORK_ERR.to_string())?;
            parse::parse_accounts_json(&body)
        }
        402 => Err("Your SimpleFIN subscription needs renewing before Ledgerly can sync.".into()),
        403 => Err("SimpleFIN rejected the saved connection. Disconnect, then connect again with a new setup token.".into()),
        s => Err(format!("SimpleFIN returned an unexpected status ({s}). Try again later.")),
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test simplefin::client`
Expected: 3 pass.

- [ ] **Step 5: Optional live check (network)**

Run: `cargo test --ignored live_demo_fetch` after adding this test to the block above:

```rust
    #[test]
    #[ignore = "hits the network"]
    fn live_demo_fetch() {
        let set = fetch_accounts("https://demo:demo@beta-bridge.simplefin.org/simplefin").unwrap();
        assert!(set.accounts.len() >= 2);
    }
```

Expected: passes when online.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/simplefin/client.rs
git commit -m "feat(simplefin): HTTP client for token claim and account fetch"
```

---

### Task 5: Sync into SQLite

**Files:**
- Create (replace stub): `src-tauri/src/simplefin/sync.rs`
- Modify: `src-tauri/src/simplefin/mod.rs` (restore `pub use sync::SyncReport;`)

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/simplefin/sync.rs` tests block:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::simplefin::parse::{SfAccount, SfHolding};

    fn holding(sym: &str, shares: f64, cost: f64, mv: f64) -> SfHolding {
        SfHolding { symbol: sym.into(), description: format!("{sym} Fund"), shares, cost_basis: cost, market_value: mv }
    }
    fn account(id: &str, balance: f64, holdings: Vec<SfHolding>) -> SfAccount {
        SfAccount {
            id: id.into(), name: format!("Acct {id}"), institution: "Demo Bank".into(),
            currency: "USD".into(), balance, balance_date: "2026-09-07".into(), holdings,
        }
    }
    fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn first_sync_creates_accounts_with_type_from_holdings() {
        let mut conn = db::open_in_memory().unwrap();
        let set = SfAccountSet {
            errors: vec![],
            accounts: vec![
                account("cash1", 100.0, vec![]),
                account("brk1", 5.0, vec![holding("VTI", 10.0, 2000.0, 2500.0)]),
            ],
        };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.accounts_synced, 2);
        assert_eq!(r.holdings_synced, 1);
        assert_eq!(r.holdings_skipped, 0);
        assert!(r.errors.is_empty());

        let t: String = conn.query_row("SELECT type FROM accounts WHERE external_id='cash1'", [], |r| r.get(0)).unwrap();
        assert_eq!(t, "cash");
        let t: String = conn.query_row("SELECT type FROM accounts WHERE external_id='brk1'", [], |r| r.get(0)).unwrap();
        assert_eq!(t, "brokerage");
        let src: String = conn.query_row("SELECT source FROM accounts WHERE external_id='brk1'", [], |r| r.get(0)).unwrap();
        assert_eq!(src, "simplefin");
        let bal: f64 = conn.query_row("SELECT synced_balance FROM accounts WHERE external_id='cash1'", [], |r| r.get(0)).unwrap();
        assert_eq!(bal, 100.0);
        // security created, holding row present, price written from market_value/shares
        assert_eq!(count(&conn, "SELECT count(*) FROM securities WHERE ticker='VTI' AND type='etf'"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM synced_holdings"), 1);
        let close: f64 = conn.query_row("SELECT close FROM prices WHERE source='simplefin'", [], |r| r.get(0)).unwrap();
        assert_eq!(close, 250.0);
    }

    #[test]
    fn second_sync_updates_in_place_and_removes_stale_holdings() {
        let mut conn = db::open_in_memory().unwrap();
        let first = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 5.0, vec![
            holding("VTI", 10.0, 2000.0, 2500.0), holding("AAPL", 1.0, 100.0, 150.0),
        ])] };
        apply(&mut conn, &first).unwrap();
        let second = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 9.0, vec![
            holding("VTI", 12.0, 2400.0, 3000.0),
        ])] };
        let r = apply(&mut conn, &second).unwrap();
        assert_eq!(r.accounts_synced, 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM accounts"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM synced_holdings"), 1);
        let shares: f64 = conn.query_row("SELECT shares FROM synced_holdings", [], |r| r.get(0)).unwrap();
        assert_eq!(shares, 12.0);
        let bal: f64 = conn.query_row("SELECT synced_balance FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(bal, 9.0);
    }

    #[test]
    fn skips_symbolless_and_zero_share_holdings() {
        let mut conn = db::open_in_memory().unwrap();
        let set = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 0.0, vec![
            holding("", 5.0, 5.0, 5.0), holding("VTI", 0.0, 0.0, 0.0), holding("AAPL", 1.0, 100.0, 150.0),
        ])] };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.holdings_synced, 1);
        assert_eq!(r.holdings_skipped, 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM securities"), 1);
    }

    #[test]
    fn does_not_overwrite_yahoo_price_for_same_date() {
        let mut conn = db::open_in_memory().unwrap();
        let sec = crate::commands::securities::get_or_create(&conn, "VTI", None, "etf").unwrap();
        crate::commands::prices::upsert(&conn, sec.id, "2026-09-07", 999.0, "yahoo").unwrap();
        let set = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 0.0, vec![holding("VTI", 10.0, 2000.0, 2500.0)])] };
        apply(&mut conn, &set).unwrap();
        let close: f64 = conn.query_row("SELECT close FROM prices WHERE security_id=?1 AND date='2026-09-07'", [sec.id], |r| r.get(0)).unwrap();
        assert_eq!(close, 999.0);
    }

    #[test]
    fn feed_errors_are_passed_through() {
        let mut conn = db::open_in_memory().unwrap();
        let set = SfAccountSet { errors: vec!["Bank needs attention".into()], accounts: vec![] };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.errors, vec!["Bank needs attention".to_string()]);
        assert_eq!(r.accounts_synced, 0);
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test simplefin::sync`
Expected: compile error, `apply`/`SyncReport` missing.

- [ ] **Step 3: Implement `sync.rs`** (above tests)

```rust
//! Write a parsed SimpleFIN account set into SQLite. Each SimpleFIN account
//! is applied in its own transaction so one bad account never half-updates
//! another.
use super::parse::{SfAccount, SfAccountSet};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct SyncReport {
    pub accounts_synced: usize,
    pub holdings_synced: usize,
    pub holdings_skipped: usize,
    pub errors: Vec<String>,
}

pub fn apply(conn: &mut Connection, set: &SfAccountSet) -> Result<SyncReport, String> {
    let mut report = SyncReport { errors: set.errors.clone(), ..Default::default() };
    let now = chrono::Utc::now().to_rfc3339();
    for sf in &set.accounts {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        match apply_account(&tx, sf, &now) {
            Ok((synced, skipped)) => {
                tx.commit().map_err(|e| e.to_string())?;
                report.accounts_synced += 1;
                report.holdings_synced += synced;
                report.holdings_skipped += skipped;
            }
            Err(e) => {
                // tx drops → rolled back
                report.errors.push(format!("{}: {e}", sf.name));
            }
        }
    }
    Ok(report)
}

fn is_fund(description: &str) -> bool {
    let d = description.to_lowercase();
    d.contains("etf") || d.contains("fund") || d.contains("index") || d.contains("trust")
}

/// Returns (holdings synced, holdings skipped).
fn apply_account(tx: &Connection, sf: &SfAccount, now: &str) -> rusqlite::Result<(usize, usize)> {
    let existing: Option<i64> = tx
        .query_row("SELECT id FROM accounts WHERE external_id=?1", [&sf.id], |r| r.get(0))
        .optional()?;
    let account_id = match existing {
        Some(id) => id,
        None => {
            let type_ = if sf.holdings.is_empty() { "cash" } else { "brokerage" };
            tx.execute(
                "INSERT INTO accounts (name,type,institution,currency,created_at,source,external_id)
                 VALUES (?1,?2,?3,'USD',?4,'simplefin',?5)",
                params![sf.name, type_, sf.institution, now, sf.id],
            )?;
            tx.last_insert_rowid()
        }
    };
    tx.execute(
        "UPDATE accounts SET synced_balance=?1, last_synced_at=?2 WHERE id=?3",
        params![sf.balance, now, account_id],
    )?;

    let mut kept: Vec<i64> = Vec::new();
    let mut skipped = 0usize;
    for h in &sf.holdings {
        if h.symbol.is_empty() || h.shares <= 0.0 {
            skipped += 1;
            continue;
        }
        let kind = if is_fund(&h.description) { "etf" } else { "stock" };
        let name = if h.description.is_empty() { None } else { Some(h.description.as_str()) };
        let sec = crate::commands::securities::get_or_create(tx, &h.symbol, name, kind)?;
        tx.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(account_id,security_id) DO UPDATE SET
               shares=excluded.shares, cost_basis=excluded.cost_basis,
               market_value=excluded.market_value, as_of=excluded.as_of",
            params![account_id, sec.id, h.shares, h.cost_basis, h.market_value, sf.balance_date],
        )?;
        let has_yahoo: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM prices WHERE security_id=?1 AND date=?2 AND source='yahoo')",
            params![sec.id, sf.balance_date],
            |r| r.get(0),
        )?;
        if !has_yahoo && h.market_value > 0.0 {
            crate::commands::prices::upsert(tx, sec.id, &sf.balance_date, h.market_value / h.shares, "simplefin")?;
        }
        kept.push(sec.id);
    }

    if kept.is_empty() {
        tx.execute("DELETE FROM synced_holdings WHERE account_id=?1", [account_id])?;
    } else {
        let ids = kept.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
        tx.execute(
            &format!("DELETE FROM synced_holdings WHERE account_id=?1 AND security_id NOT IN ({ids})"),
            [account_id],
        )?;
    }
    Ok((kept.len(), skipped))
}
```

Restore `pub use sync::SyncReport;` in `mod.rs`.

- [ ] **Step 4: Run the tests**

Run: `cargo test simplefin`
Expected: parse (8) + client (3) + sync (5) all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/simplefin
git commit -m "feat(simplefin): apply account balances and holdings to SQLite"
```

---

### Task 6: Tauri commands + registration

**Files:**
- Create: `src-tauri/src/commands/simplefin.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test for the holdings list and status query**

`src-tauri/src/commands/simplefin.rs` tests block:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn list_holdings_and_last_synced() {
        let conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id,last_synced_at)
             VALUES ('B','brokerage','USD','2026-01-01','simplefin','x','2026-09-07T10:00:00Z')", []).unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('VTI','etf','USD')", []).unwrap();
        conn.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (1,1,10,2000,2500,'2026-09-07')", []).unwrap();
        let rows = list_holdings(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].shares, 10.0);
        assert_eq!(last_synced_at(&conn).unwrap().as_deref(), Some("2026-09-07T10:00:00Z"));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test commands::simplefin`
Expected: compile error.

- [ ] **Step 3: Implement the commands**

`src-tauri/src/commands/simplefin.rs`:

```rust
use crate::db::Db;
use crate::models::SyncedHolding;
use crate::secrets;
use crate::simplefin::{client, sync, SyncReport};
use rusqlite::Connection;
use serde::Serialize;

const KEY: &str = "simplefin_access_url";

#[derive(Serialize)]
pub struct SimplefinStatus {
    pub connected: bool,
    pub last_synced_at: Option<String>,
}

pub fn list_holdings(conn: &Connection) -> rusqlite::Result<Vec<SyncedHolding>> {
    let mut stmt = conn.prepare(
        "SELECT id,account_id,security_id,shares,cost_basis,market_value,as_of
         FROM synced_holdings ORDER BY account_id, security_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SyncedHolding {
            id: r.get(0)?, account_id: r.get(1)?, security_id: r.get(2)?,
            shares: r.get(3)?, cost_basis: r.get(4)?, market_value: r.get(5)?, as_of: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn last_synced_at(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT MAX(last_synced_at) FROM accounts WHERE source='simplefin'",
        [],
        |r| r.get::<_, Option<String>>(0),
    )
}

fn run_sync(db: &Db, access_url: &str) -> Result<SyncReport, String> {
    // Network first, without holding the DB lock.
    let set = client::fetch_accounts(access_url)?;
    let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    sync::apply(&mut conn, &set)
}

#[tauri::command]
pub fn simplefin_status(db: tauri::State<Db>) -> Result<SimplefinStatus, String> {
    let connected = secrets::get(KEY)?.is_some();
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let last = last_synced_at(&conn).map_err(|e| e.to_string())?;
    Ok(SimplefinStatus { connected, last_synced_at: last })
}

#[tauri::command]
pub fn simplefin_connect(db: tauri::State<Db>, setup_token: String) -> Result<SyncReport, String> {
    let access_url = client::claim(&setup_token)?;
    secrets::set(KEY, &access_url)?;
    run_sync(&db, &access_url)
}

#[tauri::command]
pub fn simplefin_sync(db: tauri::State<Db>) -> Result<SyncReport, String> {
    let access_url = secrets::get(KEY)?
        .ok_or_else(|| "SimpleFIN isn't connected yet. Paste a setup token in Settings to connect.".to_string())?;
    run_sync(&db, &access_url)
}

#[tauri::command]
pub fn simplefin_disconnect(db: tauri::State<Db>, delete_accounts: bool) -> Result<(), String> {
    secrets::delete(KEY)?;
    if delete_accounts {
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("DELETE FROM accounts WHERE source='simplefin'", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn synced_holdings_list(db: tauri::State<Db>) -> Result<Vec<SyncedHolding>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list_holdings(&conn).map_err(|e| e.to_string())
}
```

In `src-tauri/src/commands/mod.rs` add `pub mod simplefin;`.

In `src-tauri/src/lib.rs`, inside `generate_handler![...]` after `commands::snapshots::snapshots_record,` add:

```rust
            commands::simplefin::simplefin_status,
            commands::simplefin::simplefin_connect,
            commands::simplefin::simplefin_sync,
            commands::simplefin::simplefin_disconnect,
            commands::simplefin::synced_holdings_list,
```

- [ ] **Step 4: Run all Rust tests and a build**

Run: `cargo test` then `cargo build`
Expected: all tests pass (13 original + ~18 new), build clean with no warnings about unused `secrets`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/simplefin.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(simplefin): Tauri commands for connect, sync, status, disconnect"
```

---

# Workstream A-UI

### Task 7: Theme tokens, stylesheet, and `useTheme`

**Files:**
- Rewrite: `src/styles.css`
- Create: `src/ui/theme.tsx`, `src/ui/theme.test.ts`
- Modify: `src/App.tsx` (wrap in `ThemeProvider`)

- [ ] **Step 1: Write the failing theme tests**

`src/ui/theme.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadPref, savePref, resolve, applyTheme } from "./theme";

describe("theme preference", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to system when nothing is stored or stored value is junk", () => {
    expect(loadPref()).toBe("system");
    localStorage.setItem("ledgerly.theme", "purple");
    expect(loadPref()).toBe("system");
  });

  it("round-trips a saved preference", () => {
    savePref("dark");
    expect(loadPref()).toBe("dark");
  });

  it("resolves system from the OS preference and explicit values as-is", () => {
    expect(resolve("system", true)).toBe("dark");
    expect(resolve("system", false)).toBe("light");
    expect(resolve("light", true)).toBe("light");
    expect(resolve("dark", false)).toBe("dark");
  });

  it("applies the resolved theme to the html element", () => {
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- theme`
Expected: FAIL, module not found.

- [ ] **Step 3: Create `src/ui/theme.tsx`**

```tsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const KEY = "ledgerly.theme";

export function loadPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch { /* storage unavailable */ }
  return "system";
}

export function savePref(p: ThemePref) {
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolve(pref: ThemePref, sysDark: boolean = systemPrefersDark()): ResolvedTheme {
  return pref === "system" ? (sysDark ? "dark" : "light") : pref;
}

export function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

interface ThemeCtx { pref: ThemePref; resolved: ResolvedTheme; setPref: (p: ThemePref) => void; }
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(loadPref);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(pref));

  useEffect(() => {
    const mq = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const update = () => {
      const r = resolve(pref, mq?.matches ?? false);
      setResolved(r);
      applyTheme(r);
    };
    update();
    mq?.addEventListener?.("change", update);
    return () => mq?.removeEventListener?.("change", update);
  }, [pref]);

  const value = useMemo<ThemeCtx>(() => ({
    pref, resolved,
    setPref: (p) => { savePref(p); setPrefState(p); },
  }), [pref, resolved]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
```

- [ ] **Step 4: Run the theme tests**

Run: `npm test -- theme`
Expected: 4 pass.

- [ ] **Step 5: Replace `src/styles.css` entirely**

```css
/* ---------- Theme tokens ---------- */
:root {
  --bg: #f4f5f8;
  --surface: #ffffff;
  --surface-2: #f1f3f7;
  --ink: #0f172a;
  --ink-2: #334155;
  --mut: #64748b;
  --line: #e5e8ef;
  --line-2: #cfd5e1;
  --accent: #4f46e5;
  --accent-ink: #ffffff;
  --accent-soft: #eef0ff;
  --pos: #15803d;
  --pos-soft: #dcfce7;
  --neg: #b91c1c;
  --neg-soft: #fee2e2;
  --warn: #b45309;
  --warn-soft: #fef3c7;
  --radius: 14px;
  --radius-sm: 8px;
  --shadow: 0 1px 2px rgba(15, 23, 42, .05), 0 1px 3px rgba(15, 23, 42, .08);
  --chart-1: #4f46e5;
  --chart-2: #0ea5e9;
  --chart-3: #10b981;
  --chart-4: #f59e0b;
  --chart-5: #ec4899;
  --chart-6: #8b5cf6;
  --chart-grid: #e5e8ef;
}
:root[data-theme="dark"] {
  --bg: #0e1015;
  --surface: #161922;
  --surface-2: #1e222d;
  --ink: #e7e9ef;
  --ink-2: #c5c9d3;
  --mut: #8a90a2;
  --line: #262b37;
  --line-2: #353b4a;
  --accent: #818cf8;
  --accent-ink: #0e1015;
  --accent-soft: rgba(129, 140, 248, .16);
  --pos: #34d399;
  --pos-soft: rgba(52, 211, 153, .16);
  --neg: #f87171;
  --neg-soft: rgba(248, 113, 113, .16);
  --warn: #fbbf24;
  --warn-soft: rgba(251, 191, 36, .16);
  --shadow: 0 1px 2px rgba(0, 0, 0, .4);
  --chart-1: #818cf8;
  --chart-2: #38bdf8;
  --chart-3: #34d399;
  --chart-4: #fbbf24;
  --chart-5: #f472b6;
  --chart-6: #a78bfa;
  --chart-grid: #262b37;
}

/* ---------- Base ---------- */
* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
  color: var(--ink);
  background: var(--bg);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -.01em; }
h1 { font-size: 22px; }
h2 { font-size: 16px; }
h3 { font-size: 14px; }
a { color: var(--accent); }
p { margin: 0; }
.num, td, th, .stat-value, .hero-value { font-variant-numeric: tabular-nums; }
.muted { color: var(--mut); }
.pos { color: var(--pos); }
.neg { color: var(--neg); }

/* ---------- Layout ---------- */
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 224px; flex-shrink: 0; position: sticky; top: 0; height: 100vh;
  background: var(--surface); border-right: 1px solid var(--line);
  padding: 20px 14px; display: flex; flex-direction: column; gap: 2px;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 18px; font-weight: 700; font-size: 16px; }
.brand-mark {
  width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
  background: var(--accent); color: var(--accent-ink); font-size: 14px;
}
.navlink {
  display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 10px;
  color: var(--ink-2); text-decoration: none; font-weight: 500; transition: background .12s;
}
.navlink svg { width: 16px; height: 16px; opacity: .8; }
.navlink:hover { background: var(--surface-2); }
.navlink.active { background: var(--accent-soft); color: var(--accent); }
.navlink.active svg { opacity: 1; }
.navlink.disabled { opacity: .45; pointer-events: none; }
.nav-tag { margin-left: auto; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--mut); }
.sidebar-footer { margin-top: auto; display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
.main { flex: 1; min-width: 0; padding: 28px 32px 48px; }
.page { max-width: 1200px; margin: 0 auto; display: grid; gap: 20px; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.page-header .subtitle { color: var(--mut); margin-top: 2px; }
.page-actions { display: flex; gap: 8px; align-items: center; }

/* ---------- Cards ---------- */
.card {
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 18px 20px; box-shadow: var(--shadow);
}
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.card-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); }
.card-subtitle { color: var(--mut); font-size: 12px; margin-top: 2px; }
.grid { display: grid; gap: 12px; }
.grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid-main { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); }
@media (max-width: 960px) { .grid-4 { grid-template-columns: repeat(2, 1fr); } .grid-main, .grid-2 { grid-template-columns: 1fr; } }

.stat { display: grid; gap: 4px; }
.stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); font-weight: 600; }
.stat-value { font-size: 20px; font-weight: 650; }
.stat-hint { font-size: 12px; color: var(--mut); }

.hero { display: grid; gap: 4px; }
.hero-label { font-size: 12px; color: var(--mut); font-weight: 500; }
.hero-value { font-size: 38px; font-weight: 750; letter-spacing: -.02em; line-height: 1.1; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; width: fit-content; }
.chip.pos { background: var(--pos-soft); color: var(--pos); }
.chip.neg { background: var(--neg-soft); color: var(--neg); }
.chip.neutral { background: var(--surface-2); color: var(--ink-2); }

/* ---------- Badges ---------- */
.badge {
  display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; letter-spacing: .02em; white-space: nowrap;
}
.badge.neutral { background: var(--surface-2); color: var(--ink-2); }
.badge.accent { background: var(--accent-soft); color: var(--accent); }
.badge.pos { background: var(--pos-soft); color: var(--pos); }
.badge.neg { background: var(--neg-soft); color: var(--neg); }
.badge.warn { background: var(--warn-soft); color: var(--warn); }

/* ---------- Tables ---------- */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--surface); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--mut); font-weight: 600; }
th.left, td.left { text-align: left; }
tbody tr:hover td { background: var(--surface-2); }
tbody tr:last-child td { border-bottom: 0; }
.cell-primary { font-weight: 600; }
.cell-secondary { font-size: 12px; color: var(--mut); }
.bar { display: inline-flex; align-items: center; gap: 8px; justify-content: flex-end; }
.bar-track { width: 60px; height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.bar-fill { height: 100%; background: var(--accent); border-radius: 999px; }

/* ---------- Controls ---------- */
button, .btn {
  font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 10px; cursor: pointer;
  border: 1px solid transparent; display: inline-flex; align-items: center; gap: 8px;
  transition: background .12s, border-color .12s, opacity .12s; line-height: 1.2;
}
button:disabled, .btn:disabled { opacity: .55; cursor: default; }
.btn-primary { background: var(--accent); color: var(--accent-ink); }
.btn-primary:hover:not(:disabled) { filter: brightness(1.06); }
.btn-secondary { background: var(--surface); color: var(--ink); border-color: var(--line-2); }
.btn-secondary:hover:not(:disabled) { background: var(--surface-2); }
.btn-ghost { background: transparent; color: var(--ink-2); }
.btn-ghost:hover:not(:disabled) { background: var(--surface-2); }
.btn-danger { background: var(--neg-soft); color: var(--neg); }
.btn-sm { padding: 5px 10px; font-size: 12px; border-radius: 8px; }
.btn-block { width: 100%; justify-content: center; }
.spinner {
  width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent;
  animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

input, select, textarea {
  font: inherit; padding: 8px 10px; border: 1px solid var(--line-2); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--ink); min-width: 0;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
textarea { resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--mut); font-weight: 500; }
.field-hint { font-size: 12px; color: var(--mut); }
.field-error { font-size: 12px; color: var(--neg); }
.row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.row.center { align-items: center; }
.between { justify-content: space-between; }

.segmented { display: inline-flex; background: var(--surface-2); border-radius: 10px; padding: 3px; gap: 2px; }
.segmented button { background: transparent; color: var(--mut); padding: 5px 10px; font-size: 12px; border-radius: 8px; }
.segmented button.on { background: var(--surface); color: var(--ink); box-shadow: var(--shadow); }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.tabs button { background: transparent; color: var(--mut); border-radius: 0; padding: 8px 12px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs button.on { color: var(--accent); border-bottom-color: var(--accent); }

.popover { position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; min-width: 200px; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.12); padding: 10px; display: grid; gap: 6px; }
.popover label { flex-direction: row; align-items: center; gap: 8px; color: var(--ink); }

.empty { display: grid; gap: 6px; justify-items: center; text-align: center; padding: 28px 12px; color: var(--mut); }
.empty-title { color: var(--ink); font-weight: 600; }

.legend { display: grid; gap: 6px; font-size: 13px; }
.legend-row { display: flex; align-items: center; gap: 8px; }
.legend-swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
.legend-row .num { margin-left: auto; color: var(--ink-2); }
.legend-row .pct { width: 48px; text-align: right; color: var(--mut); }

.steps { margin: 0; padding-left: 20px; display: grid; gap: 6px; color: var(--ink-2); }
.notice { border-radius: 10px; padding: 10px 12px; font-size: 13px; }
.notice.warn { background: var(--warn-soft); color: var(--warn); }
.notice.neg { background: var(--neg-soft); color: var(--neg); }
.notice.pos { background: var(--pos-soft); color: var(--pos); }
.notice.info { background: var(--accent-soft); color: var(--accent); }

.toast-stack { position: fixed; right: 20px; bottom: 20px; display: grid; gap: 8px; z-index: 100; }
.toast { min-width: 260px; max-width: 380px; background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 12px; padding: 10px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.14); }
.toast.pos { border-left-color: var(--pos); }
.toast.neg { border-left-color: var(--neg); }
.toast-title { font-weight: 600; }
.toast-body { color: var(--mut); font-size: 12px; margin-top: 2px; }

.recharts-tooltip-wrapper { outline: none; }
.chart-tip { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; box-shadow: var(--shadow); font-size: 12px; }
```

- [ ] **Step 6: Wrap the app in `ThemeProvider`**

In `src/App.tsx`, import `ThemeProvider` from `./ui/theme` and change the return to:

```tsx
export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AutoRefresh />
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 7: Verify**

Run: `npm test` then `npx tsc --noEmit`
Expected: all pass; no type errors. (Screens still use old classes like `secondary` — they get restyled in later tasks; `button` without a variant class now renders with no background, which is expected until then.)

- [ ] **Step 8: Commit**

```bash
git add src/styles.css src/ui/theme.tsx src/ui/theme.test.ts src/App.tsx
git commit -m "feat(ui): theme tokens with light/dark and ThemeProvider"
```

---

### Task 8: Shared components

**Files:**
- Create: `src/ui/components.tsx`, `src/ui/components.test.tsx`, `src/ui/DataTable.tsx`, `src/ui/ThemeToggle.tsx`, `src/ui/toast.tsx`, `src/ui/chartColors.ts`
- Modify: `src/ui/format.ts`, `src/ui/format.test.ts` (add `timeAgo`)

- [ ] **Step 1: Write the failing tests**

`src/ui/components.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Button, Badge, StatCard, Tabs, EmptyState } from "./components";
import { DataTable } from "./DataTable";

describe("shared components", () => {
  it("Button applies variant class and shows spinner when loading", () => {
    const { container } = render(<Button variant="danger" loading>Go</Button>);
    const btn = container.querySelector("button")!;
    expect(btn.className).toContain("btn-danger");
    expect(btn.disabled).toBe(true);
    expect(container.querySelector(".spinner")).not.toBeNull();
  });

  it("Badge renders tone", () => {
    render(<Badge tone="pos">Synced</Badge>);
    expect(screen.getByText("Synced").className).toContain("pos");
  });

  it("StatCard colours by delta sign", () => {
    render(<StatCard label="Gain" value="$5" delta={-1} />);
    expect(screen.getByText("$5").className).toContain("neg");
  });

  it("Tabs calls onChange", () => {
    const onChange = vi.fn();
    render(<Tabs items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByText("B"));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("EmptyState shows title and body", () => {
    render(<EmptyState title="Nothing" body="Add something" />);
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });

  it("DataTable renders columns and rows with alignment", () => {
    render(<DataTable
      columns={[{ key: "n", label: "Name", align: "left", render: (r: { n: string; v: number }) => r.n },
                { key: "v", label: "Value", render: (r) => r.v }]}
      rows={[{ n: "VTI", v: 3 }]}
      getKey={(r) => r.n}
    />);
    expect(screen.getByText("VTI").className).toContain("left");
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
```

Add to `src/ui/format.test.ts`:

```ts
import { timeAgo } from "./format";

describe("timeAgo", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  it("formats relative times", () => {
    expect(timeAgo("2026-09-07T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-09-07T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-09-07T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-09-05T12:00:00Z", now)).toBe("2 d ago");
    expect(timeAgo(null, now)).toBe("never");
  });
});
```

(If `format.test.ts` doesn't already import `describe/it/expect` from vitest, `globals: true` makes them available.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- ui`
Expected: FAIL, modules missing.

- [ ] **Step 3: Add `timeAgo` to `src/ui/format.ts`**

```ts
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
```

- [ ] **Step 4: Create `src/ui/components.tsx`**

```tsx
import type { ReactNode, ButtonHTMLAttributes } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, style }:
  { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section className="card" style={style}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-subtitle">{subtitle}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({ label, value, delta, hint }: { label: string; value: string; delta?: number; hint?: ReactNode }) {
  const tone = delta == null ? "" : delta > 0 ? "pos" : delta < 0 ? "neg" : "";
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant; size?: "sm" | "md"; loading?: boolean; block?: boolean;
}
export function Button({ variant = "primary", size = "md", loading, block, className = "", children, disabled, ...rest }: ButtonProps) {
  const cls = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : "", block ? "btn-block" : "", className].filter(Boolean).join(" ");
  return (
    <button className={cls} disabled={disabled || loading} {...rest}>
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "pos" | "neg" | "warn"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {body && <div>{body}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ items, value, onChange }:
  { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={it.value === value}
          className={it.value === value ? "on" : ""} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ items, value, onChange }:
  { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {items.map((it) => (
        <button key={it.value} className={it.value === value ? "on" : ""} onClick={() => onChange(it.value)}>{it.label}</button>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Create `src/ui/DataTable.tsx`**

```tsx
import type { ReactNode } from "react";

export interface Column<R> {
  key: string;
  label: ReactNode;
  align?: "left" | "right";
  render: (row: R) => ReactNode;
  className?: (row: R) => string | undefined;
}

export function DataTable<R>({ columns, rows, getKey }:
  { columns: Column<R>[]; rows: R[]; getKey: (row: R) => string | number }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.align === "left" ? "left" : ""}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={getKey(r)}>
              {columns.map((c) => (
                <td key={c.key} className={[c.align === "left" ? "left" : "", c.className?.(r) ?? ""].filter(Boolean).join(" ")}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Create `src/ui/ThemeToggle.tsx`**

```tsx
import { Segmented } from "./components";
import { useTheme, type ThemePref } from "./theme";

export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  return (
    <Segmented<ThemePref>
      items={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "Auto" }]}
      value={pref} onChange={setPref} />
  );
}
```

- [ ] **Step 7: Create `src/ui/toast.tsx`**

```tsx
import { createContext, useCallback, useContext, useMemo, useState } from "react";

export interface Toast { id: number; tone: "pos" | "neg" | "neutral"; title: string; body?: string; }
interface ToastCtx { push: (t: Omit<Toast, "id">) => void; }
const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 6000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
```

- [ ] **Step 8: Create `src/ui/chartColors.ts`**

```ts
import { useMemo } from "react";
import { useTheme } from "./theme";

/** Read chart tokens from CSS so charts follow the active theme. */
export function useChartColors() {
  const { resolved } = useTheme();
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
      series: [1, 2, 3, 4, 5, 6].map((i) => read(`--chart-${i}`, "#4f46e5")),
      grid: read("--chart-grid", "#e5e8ef"),
      text: read("--mut", "#64748b"),
      accent: read("--accent", "#4f46e5"),
      pos: read("--pos", "#15803d"),
      neg: read("--neg", "#b91c1c"),
    };
    // resolved is the dependency: recompute when the theme flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);
}
```

- [ ] **Step 9: Run tests + type-check**

Run: `npm test` then `npx tsc --noEmit`
Expected: all pass (theme 4, components 6, timeAgo 1, existing 27).

- [ ] **Step 10: Commit**

```bash
git add src/ui
git commit -m "feat(ui): shared components, DataTable, ThemeToggle, toasts, chart colours"
```

---

### Task 9: App shell + sidebar

**Files:**
- Create: `src/app/icons.tsx`
- Modify: `src/app/Sidebar.tsx`, `src/app/AppShell.tsx`, `src/App.tsx` (ToastProvider)

- [ ] **Step 1: Create `src/app/icons.tsx`**

```tsx
const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const Icons = {
  dashboard: () => <svg {...base}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  holdings: () => <svg {...base}><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>,
  accounts: () => <svg {...base}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>,
  activity: () => <svg {...base}><path d="M12 8v4l3 3" /><circle cx="12" cy="12" r="9" /></svg>,
  budget: () => <svg {...base}><path d="M21 12a9 9 0 1 1-9-9" /><path d="M12 3v9h9" /></svg>,
  settings: () => <svg {...base}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  sync: () => <svg {...base}><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /></svg>,
};
```

- [ ] **Step 2: Rewrite `src/app/Sidebar.tsx`**

```tsx
import { NavLink } from "react-router-dom";
import { Icons } from "./icons";
import { ThemeToggle } from "../ui/ThemeToggle";

const links = [
  { to: "/", label: "Dashboard", end: true, icon: Icons.dashboard },
  { to: "/holdings", label: "Holdings", icon: Icons.holdings },
  { to: "/accounts", label: "Accounts", icon: Icons.accounts },
  { to: "/activity", label: "Activity", icon: Icons.activity },
];

const cls = ({ isActive }: { isActive: boolean }) => "navlink" + (isActive ? " active" : "");

export function Sidebar({ footer }: { footer?: React.ReactNode }) {
  return (
    <nav className="sidebar">
      <div className="brand"><span className="brand-mark">◆</span>Ledgerly</div>
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end} className={cls}>
          <l.icon />{l.label}
        </NavLink>
      ))}
      <span className="navlink disabled"><Icons.budget />Budget<span className="nav-tag">soon</span></span>
      <NavLink to="/settings" className={cls}><Icons.settings />Settings</NavLink>
      <div className="sidebar-footer">
        {footer}
        <ThemeToggle />
      </div>
    </nav>
  );
}
```

- [ ] **Step 3: Rewrite `src/app/AppShell.tsx`**

```tsx
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="main"><div className="page"><Outlet /></div></main>
    </div>
  );
}
```

- [ ] **Step 4: Add `ToastProvider` in `src/App.tsx`**

Import `ToastProvider` from `./ui/toast` and nest it directly inside `ThemeProvider`:

```tsx
    <ThemeProvider>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <AutoRefresh />
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>
```

- [ ] **Step 5: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app src/App.tsx
git commit -m "feat(ui): sidebar with icons, theme toggle footer, toast provider"
```

---

### Task 10: Dashboard restyle

**Files:**
- Rewrite: `src/features/dashboard/Dashboard.tsx`

- [ ] **Step 1: Rewrite the screen**

```tsx
import { PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { usePortfolio } from "../../data/usePortfolio";
import { useSnapshots } from "../../data/queries";
import { toValueSeries } from "../../domain/series";
import { money, pct } from "../../ui/format";
import { PageHeader, Card, StatCard, EmptyState } from "../../ui/components";
import { useChartColors } from "../../ui/chartColors";
import type { AllocationSlice } from "../../domain/types";

function ChartTip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tip"><div className="muted">{label}</div><strong>{money(payload[0].value)}</strong></div>;
}

function Donut({ data, colors }: { data: AllocationSlice[]; colors: string[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 16, alignItems: "center" }}>
      <ResponsiveContainer width="100%" height={150}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={48} outerRadius={70} stroke="none" paddingAngle={2}>
            {data.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Pie>
          <Tooltip content={<ChartTip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="legend">
        {data.map((s, i) => (
          <div className="legend-row" key={s.label}>
            <span className="legend-swatch" style={{ background: colors[i % colors.length] }} />
            <span>{s.label}</span>
            <span className="num">{money(s.value)}</span>
            <span className="pct num">{s.pct.toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Dashboard() {
  const { summary, allocationType, allocationAccount, isLoading } = usePortfolio();
  const { data: snapshots = [] } = useSnapshots();
  const colors = useChartColors();
  const series = toValueSeries(snapshots);
  if (isLoading) return <p className="muted">Loading…</p>;

  const dayTone = summary.dayChange > 0 ? "pos" : summary.dayChange < 0 ? "neg" : "neutral";

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Your whole portfolio at a glance" />
      <div className="hero">
        <div className="hero-label">Total portfolio value</div>
        <div className="hero-value">{money(summary.totalValue)}</div>
        <span className={`chip ${dayTone}`}>{money(summary.dayChange)} today · {pct(summary.dayChangePct)}</span>
      </div>

      <div className="grid grid-4">
        <StatCard label="Total gain" value={money(summary.unrealized)} delta={summary.unrealized} hint={`on ${money(summary.totalCostBasis)} invested`} />
        <StatCard label="Return" value={pct(summary.unrealizedPct)} delta={summary.unrealizedPct} />
        <StatCard label="Realized" value={money(summary.realized)} delta={summary.realized} />
        <StatCard label="Cash" value={money(summary.cash)} hint={`${money(summary.investedValue)} in holdings`} />
      </div>

      <div className="grid grid-main">
        <Card title="Value over time">
          {series.length < 2 ? (
            <EmptyState title="Chart is warming up" body="It builds from daily snapshots. Come back tomorrow." />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={series} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="valueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.accent} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis dataKey="date" fontSize={11} stroke={colors.text} tickLine={false} axisLine={false} />
                <YAxis fontSize={11} stroke={colors.text} tickLine={false} axisLine={false} width={64}
                  tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
                <Tooltip content={<ChartTip />} />
                <Area type="monotone" dataKey="value" stroke={colors.accent} strokeWidth={2} fill="url(#valueFill)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </Card>
        <Card title="Allocation by type">
          {allocationType.length === 0 ? <EmptyState title="No holdings yet" body="Add a position in Activity." />
            : <Donut data={allocationType} colors={colors.series} />}
        </Card>
      </div>

      <Card title="Allocation by account">
        {allocationAccount.length === 0 ? <EmptyState title="No accounts with value yet" />
          : <Donut data={allocationAccount} colors={colors.series} />}
      </Card>
    </>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/features/dashboard/Dashboard.tsx
git commit -m "feat(ui): restyle dashboard with hero, stat cards, area chart, legends"
```

---

### Task 11: Holdings restyle

**Files:**
- Rewrite: `src/features/holdings/Holdings.tsx`

- [ ] **Step 1: Rewrite the screen**

```tsx
import { useState } from "react";
import { usePortfolio } from "../../data/usePortfolio";
import { useSecurities } from "../../data/queries";
import { money, pct } from "../../ui/format";
import { PageHeader, Card, Button, EmptyState } from "../../ui/components";
import { DataTable, type Column } from "../../ui/DataTable";
import type { Holding } from "../../domain/types";

interface Row extends Holding { weight: number | null; name: string | null; }

const COLS: Column<Row>[] = [
  { key: "ticker", label: "Ticker", align: "left", render: (r) => (
      <div><div className="cell-primary">{r.ticker}</div>{r.name && <div className="cell-secondary">{r.name}</div>}</div>) },
  { key: "shares", label: "Shares", render: (r) => r.shares },
  { key: "avgCost", label: "Avg cost", render: (r) => money(r.avgCost) },
  { key: "lastPrice", label: "Last", render: (r) => (r.lastPrice ? money(r.lastPrice) : "—") },
  { key: "marketValue", label: "Market value", render: (r) => <span className="cell-primary">{money(r.marketValue)}</span> },
  { key: "unrealized", label: "Unrealized", render: (r) => money(r.unrealized), className: (r) => (r.unrealized >= 0 ? "pos" : "neg") },
  { key: "returnPct", label: "Return", render: (r) => pct(r.unrealizedPct), className: (r) => (r.unrealizedPct >= 0 ? "pos" : "neg") },
  { key: "weight", label: "Weight", render: (r) => r.weight == null ? "—" : (
      <span className="bar"><span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, r.weight)}%` }} /></span>{r.weight.toFixed(1)}%</span>) },
];

const STORAGE_KEY = "ledgerly.holdings.cols";
const TOGGLEABLE = COLS.filter((c) => c.key !== "ticker");

function loadVisible(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const known = (JSON.parse(raw) as string[]).filter((k) => TOGGLEABLE.some((c) => c.key === k));
      if (known.length) return known;
    }
  } catch { /* ignore */ }
  return TOGGLEABLE.map((c) => c.key);
}

export function Holdings() {
  const { holdings, summary, byAccount, isLoading } = usePortfolio();
  const { data: securities = [] } = useSecurities();
  const [visible, setVisible] = useState<string[]>(loadVisible);
  const [showCols, setShowCols] = useState(false);
  if (isLoading) return <p className="muted">Loading…</p>;

  const nameOf = new Map(securities.map((s) => [s.id, s.name]));
  const toRows = (hs: Holding[], denom: number): Row[] =>
    hs.map((h) => ({ ...h, name: nameOf.get(h.security_id) ?? null, weight: denom > 0 ? (h.marketValue / denom) * 100 : null }));
  const cols = COLS.filter((c) => c.key === "ticker" || visible.includes(c.key));

  function toggle(key: string) {
    setVisible((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  const accountsWithHoldings = byAccount.filter((b) => b.holdings.length > 0);

  return (
    <>
      <PageHeader title="Holdings" subtitle={`${holdings.length} securities · ${money(summary.investedValue)} invested`}
        actions={
          <div style={{ position: "relative" }}>
            <Button variant="secondary" size="sm" onClick={() => setShowCols((s) => !s)}>⚙ Columns</Button>
            {showCols && (
              <div className="popover">
                {TOGGLEABLE.map((c) => (
                  <label key={c.key}>
                    <input type="checkbox" checked={visible.includes(c.key)} onChange={() => toggle(c.key)} />{c.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        } />

      <Card title="All accounts">
        {holdings.length === 0
          ? <EmptyState title="No holdings yet" body="Add a position in Activity or connect SimpleFIN in Settings." />
          : <DataTable columns={cols} rows={toRows(holdings, summary.investedValue)} getKey={(r) => r.security_id} />}
      </Card>

      {accountsWithHoldings.length > 1 && accountsWithHoldings.map((b) => (
        <Card key={b.account.id} title={b.account.name}
          subtitle={`${money(b.holdingsValue)} in holdings${b.cash ? ` · ${money(b.cash)} cash` : ""}`}>
          <DataTable columns={cols} rows={toRows(b.holdings, b.holdingsValue)} getKey={(r) => r.security_id} />
        </Card>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/features/holdings/Holdings.tsx
git commit -m "feat(ui): restyle holdings with DataTable, weight bars, column popover"
```

---

### Task 12: Accounts restyle

**Files:**
- Rewrite: `src/features/accounts/Accounts.tsx`, `src/features/accounts/AccountForm.tsx`

- [ ] **Step 1: Rewrite `AccountForm.tsx`**

```tsx
import { useState } from "react";
import { useCreateAccount } from "../../data/queries";
import { Button, Field } from "../../ui/components";

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
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Brokerage" /></Field>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="brokerage">Brokerage</option>
          <option value="cash">Cash / Savings</option>
        </select>
      </Field>
      <Field label="Institution"><input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Fidelity" /></Field>
      <Button type="submit" loading={create.isPending}>Add account</Button>
      {create.isError && <span className="field-error">Couldn't add the account. Try again.</span>}
    </form>
  );
}
```

- [ ] **Step 2: Rewrite `Accounts.tsx`**

```tsx
import { useAccounts, useDeleteAccount } from "../../data/queries";
import { usePortfolio } from "../../data/usePortfolio";
import { AccountForm } from "./AccountForm";
import { PageHeader, Card, Button, Badge, EmptyState } from "../../ui/components";
import { DataTable, type Column } from "../../ui/DataTable";
import { money, timeAgo } from "../../ui/format";
import type { Account } from "../../domain/types";

export function Accounts() {
  const { data: accounts = [], isLoading } = useAccounts();
  const { accountValues } = usePortfolio();
  const del = useDeleteAccount();

  const columns: Column<Account>[] = [
    { key: "name", label: "Account", align: "left", render: (a) => (
        <div><div className="cell-primary">{a.name}</div><div className="cell-secondary">{a.institution ?? "—"}</div></div>) },
    { key: "type", label: "Type", align: "left", render: (a) => <Badge>{a.type === "brokerage" ? "Brokerage" : "Cash"}</Badge> },
    { key: "source", label: "Source", align: "left", render: (a) =>
        a.source === "simplefin" ? <Badge tone="accent">SimpleFIN</Badge> : <Badge>Manual</Badge> },
    { key: "synced", label: "Last synced", render: (a) => a.source === "simplefin" ? timeAgo(a.last_synced_at) : "—" },
    { key: "value", label: "Value", render: (a) => <span className="cell-primary">{money(accountValues.get(a.id) ?? 0)}</span> },
    { key: "actions", label: "", render: (a) => (
        <Button variant="ghost" size="sm" onClick={() => {
          const extra = a.source === "simplefin" ? " It will come back on the next SimpleFIN sync unless you disconnect in Settings." : "";
          if (confirm(`Delete "${a.name}"? This removes its transactions.${extra}`)) del.mutate(a.id);
        }}>Delete</Button>) },
  ];

  return (
    <>
      <PageHeader title="Accounts" subtitle="Where your money lives" />
      <Card title="Add an account"><AccountForm /></Card>
      <Card title="All accounts">
        {isLoading ? <p className="muted">Loading…</p> : accounts.length === 0
          ? <EmptyState title="No accounts yet" body="Add one above, or connect SimpleFIN in Settings to import them automatically." />
          : <DataTable columns={columns} rows={accounts} getKey={(a) => a.id} />}
      </Card>
    </>
  );
}
```

> Note: `a.source` and `a.last_synced_at` don't exist on the TS `Account` type until Task 15. To keep this task compiling on its own, add the four fields to `src/domain/types.ts` **now** (this is the only overlap with Task 15; if Task 15 already ran, skip):

```ts
export type AccountSource = "manual" | "simplefin";
export interface Account {
  id: number; name: string; type: AccountType;
  institution: string | null; currency: string; created_at: string;
  source: AccountSource; external_id: string | null;
  synced_balance: number | null; last_synced_at: string | null;
}
```

and update the two fixtures in `src/domain/allocation.test.ts` to include `source: "manual", external_id: null, synced_balance: null, last_synced_at: null`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/features/accounts src/domain/types.ts src/domain/allocation.test.ts
git commit -m "feat(ui): restyle accounts with source badges and values"
```

---

### Task 13: Activity restyle

**Files:**
- Rewrite: `src/features/activity/Activity.tsx`
- Modify: `src/features/activity/AddPositionForm.tsx`, `TransactionForm.tsx`, `CsvImportForm.tsx` — replace raw `<button>`s with `Button` (primary for submit, `variant="secondary"` where `className="secondary"` was used); wrap `<label>` fields with `Field` only where the label text is a plain string. No logic changes.

- [ ] **Step 1: Rewrite `Activity.tsx`**

```tsx
import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useTransactions, useSecurities, useAccounts, useDeleteTransaction } from "../../data/queries";
import { AddPositionForm } from "./AddPositionForm";
import { TransactionForm } from "./TransactionForm";
import { CsvImport } from "./CsvImportForm";
import { money, fmtDate } from "../../ui/format";
import { PageHeader, Card, Button, Badge, Tabs, EmptyState } from "../../ui/components";
import { DataTable, type Column } from "../../ui/DataTable";
import type { Transaction } from "../../domain/types";

type Tab = "position" | "transaction" | "csv";
const TXN_TONE: Record<string, "pos" | "neg" | "neutral" | "accent"> = {
  buy: "accent", sell: "warn" as never, dividend: "pos", interest: "pos", deposit: "pos", withdrawal: "neg", fee: "neg",
};

export function Activity() {
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();
  const { data: accounts = [] } = useAccounts();
  const del = useDeleteTransaction();
  const [tab, setTab] = useState<Tab>("position");
  const [accountId, setAccountId] = useState<number | null>(null);

  useEffect(() => {
    if (accounts.length === 0) { setAccountId(null); return; }
    if (accountId == null || !accounts.some((a) => a.id === accountId)) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const secTicker = (id: number | null) => securities.find((s) => s.id === id)?.ticker ?? "—";
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const accountTxns = accountId == null ? [] : txns.filter((t) => t.account_id === accountId);

  const columns: Column<Transaction>[] = [
    { key: "date", label: "Date", align: "left", render: (t) => fmtDate(t.date) },
    { key: "type", label: "Type", align: "left", render: (t) => <Badge tone={TXN_TONE[t.type] ?? "neutral"}>{t.type}</Badge> },
    { key: "ticker", label: "Ticker", align: "left", render: (t) => <span className="cell-primary">{secTicker(t.security_id)}</span> },
    { key: "qty", label: "Qty", render: (t) => t.quantity || "—" },
    { key: "price", label: "Price", render: (t) => (t.price ? money(t.price) : "—") },
    { key: "amount", label: "Amount", render: (t) => money(t.amount) },
    { key: "actions", label: "", render: (t) => (
        <Button variant="ghost" size="sm" onClick={() => {
          if (confirm("Delete this transaction? Holdings and balances will recompute.")) del.mutate(t.id);
        }}>Delete</Button>) },
  ];

  if (accounts.length === 0) {
    return (
      <>
        <PageHeader title="Activity" />
        <Card><EmptyState title="You need an account first"
          body={<>Create one in <Link to="/accounts">Accounts</Link>, then come back here.</>} /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Activity" subtitle="Record trades, cash moves, or import a CSV"
        actions={
          <select value={accountId ?? ""} onChange={(e) => setAccountId(Number(e.target.value))}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.source === "simplefin" ? " (synced)" : ""}</option>)}
          </select>
        } />

      {account && account.source === "simplefin" ? (
        <Card>
          <div className="notice info">
            This account is synced from SimpleFIN. Its balance and holdings update on each sync, so manual entries are turned off here.
          </div>
        </Card>
      ) : accountId != null && (
        <Card>
          <Tabs<Tab> value={tab} onChange={setTab} items={[
            { value: "position", label: "Quick add position" },
            { value: "transaction", label: "Add transaction" },
            { value: "csv", label: "Import CSV" },
          ]} />
          {tab === "position" ? <AddPositionForm accountId={accountId} />
            : tab === "transaction" ? <TransactionForm accountId={accountId} />
            : <CsvImport accountId={accountId} />}
        </Card>
      )}

      <Card title="Transactions" subtitle={account?.name}>
        {accountTxns.length === 0 ? <EmptyState title="No transactions in this account yet" />
          : <DataTable columns={columns} rows={accountTxns} getKey={(t) => t.id} />}
      </Card>
    </>
  );
}
```

Fix the `TXN_TONE` map so it type-checks cleanly — `Badge` tone accepts `"warn"`, so declare it as:

```ts
const TXN_TONE: Record<string, "pos" | "neg" | "neutral" | "accent" | "warn"> = {
  buy: "accent", sell: "warn", dividend: "pos", interest: "pos", deposit: "pos", withdrawal: "neg", fee: "neg",
};
```

- [ ] **Step 2: Update the three forms' buttons**

In each of `AddPositionForm.tsx`, `TransactionForm.tsx`, `CsvImportForm.tsx`: import `{ Button }` from `"../../ui/components"`, replace `<button type="submit" ...>` with `<Button type="submit" ...>` and `<button className="secondary" ...>` with `<Button variant="secondary" ...>`. Keep every prop (`disabled`, `onClick`) as-is.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/features/activity
git commit -m "feat(ui): restyle activity with tabs, badges, synced-account notice"
```

---

### Task 14: Settings restyle (Appearance, Prices, About)

**Files:**
- Rewrite: `src/features/settings/Settings.tsx`

- [ ] **Step 1: Rewrite the screen**

```tsx
import { useRefreshPrices } from "../../data/useRefresh";
import { PageHeader, Card, Button } from "../../ui/components";
import { ThemeToggle } from "../../ui/ThemeToggle";
import { SimplefinCard } from "./SimplefinCard";

export function Settings() {
  const refresh = useRefreshPrices();
  return (
    <>
      <PageHeader title="Settings" />

      <Card title="Appearance" subtitle="Light, dark, or follow Windows.">
        <ThemeToggle />
      </Card>

      <Card title="Prices" subtitle="Fetched from a free public source; only your tickers leave this machine.">
        <div className="row center">
          <Button onClick={() => refresh.mutate()} loading={refresh.isPending}>Refresh prices now</Button>
          {refresh.isSuccess && <span className="pos">Updated {refresh.data} securities.</span>}
          {refresh.isError && <span className="neg">Couldn't refresh prices. Check your connection and try again.</span>}
        </div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Prices also refresh automatically: every few seconds during US market hours, every 15 minutes otherwise.
        </p>
      </Card>

      <SimplefinCard />

      <Card title="About">
        <div className="grid" style={{ gap: 4, fontSize: 13 }}>
          <div><span className="muted">Version</span> · Ledgerly 0.1.0</div>
          <div><span className="muted">Data</span> · stored locally in <code>%APPDATA%\com.ledgerly.app\finance.sqlite</code></div>
          <div><span className="muted">Coming later</span> · encrypted database + app lock, budgeting</div>
        </div>
      </Card>
    </>
  );
}
```

Create a temporary `src/features/settings/SimplefinCard.tsx` so this compiles (Task 17 replaces it):

```tsx
import { Card } from "../../ui/components";
export function SimplefinCard() {
  return <Card title="SimpleFIN" subtitle="Bank and brokerage sync"><p className="muted">Coming in the next step.</p></Card>;
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/features/settings
git commit -m "feat(ui): sectioned settings with appearance, prices, about"
```

---

# Integration

### Task 15: Types, API, queries, and `derivePortfolio()` with synced data

**Files:**
- Modify: `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts`, `src/data/usePortfolio.ts`, `src/data/useRefresh.ts`
- Create: `src/domain/synced.ts`, `src/domain/synced.test.ts`, `src/domain/portfolio.ts`, `src/domain/portfolio.test.ts`

- [ ] **Step 1: Extend `src/domain/types.ts`**

Ensure `Account` has the four new fields (see Task 12 note) and append:

```ts
export interface SyncedHolding {
  id: number; account_id: number; security_id: number;
  shares: number; cost_basis: number; market_value: number; as_of: string;
}
export interface SyncReport {
  accounts_synced: number; holdings_synced: number; holdings_skipped: number; errors: string[];
}
export interface SimplefinStatus { connected: boolean; last_synced_at: string | null; }
```

- [ ] **Step 2: Write the failing domain tests**

`src/domain/synced.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { syncedPositions, mergeCash, manualOnly } from "./synced";
import type { Account, SyncedHolding, Transaction } from "./types";

const acct = (id: number, source: Account["source"], bal: number | null = null): Account => ({
  id, name: `A${id}`, type: "brokerage", institution: null, currency: "USD", created_at: "",
  source, external_id: source === "simplefin" ? `x${id}` : null, synced_balance: bal, last_synced_at: null,
});
const sh = (account_id: number, security_id: number, shares: number, cost: number, mv: number): SyncedHolding =>
  ({ id: security_id, account_id, security_id, shares, cost_basis: cost, market_value: mv, as_of: "2026-09-07" });

describe("syncedPositions", () => {
  it("uses the latest price when known, else the implied price from market value", () => {
    const rows = [sh(1, 10, 10, 2000, 2500), sh(1, 11, 2, 300, 400)];
    const latest = new Map([[10, 260]]);
    const [p1, p2] = syncedPositions(rows, latest);
    expect(p1.lastPrice).toBe(260);
    expect(p1.marketValue).toBe(2600);
    expect(p1.avgCost).toBe(200);
    expect(p1.unrealized).toBe(600);
    expect(p1.realized).toBe(0);
    expect(p2.lastPrice).toBe(200);
    expect(p2.marketValue).toBe(400);
  });
  it("drops zero-share rows", () => {
    expect(syncedPositions([sh(1, 10, 0, 0, 0)], new Map())).toEqual([]);
  });
});

describe("mergeCash", () => {
  it("overrides cash for synced accounts and keeps manual ones", () => {
    const txnCash = new Map([[1, 50], [2, 75]]);
    const out = mergeCash(txnCash, [acct(1, "manual"), acct(2, "simplefin", 999), acct(3, "simplefin", null)]);
    expect(out.get(1)).toBe(50);
    expect(out.get(2)).toBe(999);
    expect(out.get(3)).toBe(0);
  });
});

describe("manualOnly", () => {
  it("filters out transactions belonging to synced accounts", () => {
    const t = (id: number, account_id: number): Transaction =>
      ({ id, account_id, security_id: null, type: "deposit", date: "2026-01-01", quantity: 0, price: 0, amount: 1, fees: 0, note: null });
    const out = manualOnly([t(1, 1), t(2, 2)], [acct(1, "manual"), acct(2, "simplefin")]);
    expect(out.map((x) => x.id)).toEqual([1]);
  });
});
```

`src/domain/portfolio.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { derivePortfolio } from "./portfolio";
import type { Account, Security, SyncedHolding, Transaction } from "./types";

const accounts: Account[] = [
  { id: 1, name: "Manual", type: "brokerage", institution: null, currency: "USD", created_at: "", source: "manual", external_id: null, synced_balance: null, last_synced_at: null },
  { id: 2, name: "Synced", type: "brokerage", institution: "Demo", currency: "USD", created_at: "", source: "simplefin", external_id: "x", synced_balance: 100, last_synced_at: "2026-09-07T00:00:00Z" },
];
const securities: Security[] = [{ id: 10, ticker: "VTI", name: null, type: "etf", currency: "USD" }];
const txns: Transaction[] = [
  { id: 1, account_id: 1, security_id: null, type: "deposit", date: "2026-01-01", quantity: 0, price: 0, amount: 1000, fees: 0, note: null },
  { id: 2, account_id: 1, security_id: 10, type: "buy", date: "2026-01-02", quantity: 2, price: 200, amount: 400, fees: 0, note: null },
  // a stray transaction in the synced account must not affect cash or shares
  { id: 3, account_id: 2, security_id: 10, type: "buy", date: "2026-01-03", quantity: 50, price: 1, amount: 50, fees: 0, note: null },
];
const synced: SyncedHolding[] = [{ id: 1, account_id: 2, security_id: 10, shares: 3, cost_basis: 600, market_value: 750, as_of: "2026-09-07" }];

describe("derivePortfolio", () => {
  it("merges manual and synced accounts without double counting", () => {
    const p = derivePortfolio({ txns, securities, accounts, latest: [[10, 250]], previous: [[10, 240]], synced });
    expect(p.holdings).toHaveLength(1);
    expect(p.holdings[0].shares).toBe(5);           // 2 manual + 3 synced
    expect(p.holdings[0].marketValue).toBe(1250);
    expect(p.cash).toBe(600 + 100);                  // manual: 1000 - 400; synced: 100
    expect(p.summary.totalValue).toBe(1250 + 700);
    expect(p.accountValues.get(1)).toBe(600 + 500);
    expect(p.accountValues.get(2)).toBe(100 + 750);
    expect(p.byAccount.find((b) => b.account.id === 2)?.holdings[0].shares).toBe(3);
    expect(p.summary.dayChange).toBe(5 * 10);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- domain`
Expected: FAIL, modules missing.

- [ ] **Step 4: Create `src/domain/synced.ts`**

```ts
import type { Position } from "./positions";
import type { Account, SyncedHolding, Transaction } from "./types";

/** Turn SimpleFIN holdings into Positions. Uses our latest price when we have
 *  one, otherwise the price implied by SimpleFIN's market value. */
export function syncedPositions(rows: SyncedHolding[], latestPrices: Map<number, number>): Position[] {
  return rows
    .filter((r) => r.shares > 0)
    .map((r) => {
      const implied = r.market_value / r.shares;
      const lastPrice = latestPrices.get(r.security_id) ?? implied;
      const marketValue = r.shares * lastPrice;
      return {
        account_id: r.account_id, security_id: r.security_id,
        shares: r.shares, avgCost: r.cost_basis / r.shares, costBasis: r.cost_basis,
        lastPrice, marketValue, unrealized: marketValue - r.cost_basis, realized: 0,
      };
    });
}

/** Synced accounts take their cash from SimpleFIN; manual accounts from transactions. */
export function mergeCash(txnCash: Map<number, number>, accounts: Account[]): Map<number, number> {
  const out = new Map(txnCash);
  for (const a of accounts) {
    if (a.source === "simplefin") out.set(a.id, a.synced_balance ?? 0);
  }
  return out;
}

/** Transactions that belong to manual accounts only. */
export function manualOnly(txns: Transaction[], accounts: Account[]): Transaction[] {
  const synced = new Set(accounts.filter((a) => a.source === "simplefin").map((a) => a.id));
  return txns.filter((t) => !synced.has(t.account_id));
}
```

- [ ] **Step 5: Create `src/domain/portfolio.ts`**

```ts
import { buildPositions, aggregateHoldings } from "./positions";
import { buildSummary } from "./summary";
import { allocationByType, allocationByAccount } from "./allocation";
import { cashByAccount } from "./cash";
import { syncedPositions, mergeCash, manualOnly } from "./synced";
import type { Account, Holding, Security, SyncedHolding, Transaction, PortfolioSummary, AllocationSlice } from "./types";

export interface PortfolioInputs {
  txns: Transaction[]; securities: Security[]; accounts: Account[];
  latest: [number, number][]; previous: [number, number][]; synced: SyncedHolding[];
}

export interface AccountBreakdown {
  account: Account; holdings: Holding[]; holdingsValue: number; cash: number; value: number;
}

export interface Portfolio {
  holdings: Holding[]; summary: PortfolioSummary; cash: number; byAccount: AccountBreakdown[];
  allocationType: AllocationSlice[]; allocationAccount: AllocationSlice[];
  accountValues: Map<number, number>; accounts: Account[];
}

/** The single derivation point: every screen and the snapshot recorder use this. */
export function derivePortfolio(i: PortfolioInputs): Portfolio {
  const latestMap = new Map<number, number>(i.latest);
  const prevMap = new Map<number, number>(i.previous);
  const manualTxns = manualOnly(i.txns, i.accounts);

  const positions = [
    ...buildPositions(manualTxns, latestMap),
    ...syncedPositions(i.synced, latestMap),
  ];
  const holdings = aggregateHoldings(positions, i.securities);

  const cashMap = mergeCash(cashByAccount(manualTxns), i.accounts);
  const cash = [...cashMap.values()].reduce((s, v) => s + v, 0);
  const summary = buildSummary(holdings, cash, prevMap);

  const accountValues = new Map<number, number>(cashMap);
  for (const p of positions) accountValues.set(p.account_id, (accountValues.get(p.account_id) ?? 0) + p.marketValue);

  const byAccount: AccountBreakdown[] = i.accounts.map((a) => {
    const accHoldings = aggregateHoldings(positions.filter((p) => p.account_id === a.id), i.securities);
    const holdingsValue = accHoldings.reduce((s, h) => s + h.marketValue, 0);
    return { account: a, holdings: accHoldings, holdingsValue, cash: cashMap.get(a.id) ?? 0, value: accountValues.get(a.id) ?? 0 };
  });

  return {
    holdings, summary, cash, byAccount,
    allocationType: allocationByType(holdings, cash),
    allocationAccount: allocationByAccount(accountValues, i.accounts),
    accountValues, accounts: i.accounts,
  };
}
```

- [ ] **Step 6: Run the domain tests**

Run: `npm test -- domain`
Expected: synced (4) + portfolio (1) pass.

- [ ] **Step 7: Extend `src/data/api.ts`**

Add imports for `SyncedHolding, SyncReport, SimplefinStatus` from `../domain/types` and these entries to `api`:

```ts
  syncedHoldings: {
    list: () => invoke<SyncedHolding[]>("synced_holdings_list"),
  },
  simplefin: {
    status: () => invoke<SimplefinStatus>("simplefin_status"),
    connect: (setupToken: string) => invoke<SyncReport>("simplefin_connect", { setupToken }),
    sync: () => invoke<SyncReport>("simplefin_sync"),
    disconnect: (deleteAccounts: boolean) => invoke<void>("simplefin_disconnect", { deleteAccounts }),
  },
```

- [ ] **Step 8: Extend `src/data/queries.ts`**

Add keys and hooks:

```ts
export const keys = {
  accounts: ["accounts"] as const,
  securities: ["securities"] as const,
  transactions: ["transactions"] as const,
  latest: ["prices", "latest"] as const,
  previous: ["prices", "previous"] as const,
  snapshots: ["snapshots"] as const,
  synced: ["synced_holdings"] as const,
  simplefin: ["simplefin", "status"] as const,
};

export const useSyncedHoldings = () => useQuery({ queryKey: keys.synced, queryFn: api.syncedHoldings.list });
export const useSimplefinStatus = () => useQuery({ queryKey: keys.simplefin, queryFn: api.simplefin.status });

/** Everything a sync can change. */
function invalidateAfterSync(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [keys.accounts, keys.securities, keys.synced, keys.latest, keys.previous, keys.simplefin]) {
    qc.invalidateQueries({ queryKey: k });
  }
}
export function useSimplefinConnect() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (token: string) => api.simplefin.connect(token), onSettled: () => invalidateAfterSync(qc) });
}
export function useSimplefinSync() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => api.simplefin.sync(), onSettled: () => invalidateAfterSync(qc) });
}
export function useSimplefinDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deleteAccounts: boolean) => api.simplefin.disconnect(deleteAccounts),
    onSettled: () => { invalidateAfterSync(qc); qc.invalidateQueries({ queryKey: keys.transactions }); },
  });
}
```

Also make `useDeleteAccount` invalidate `keys.synced` alongside transactions.

- [ ] **Step 9: Rewrite `src/data/usePortfolio.ts`**

```ts
import { useMemo } from "react";
import { useTransactions, useSecurities, useAccounts, useLatestPrices, usePreviousPrices, useSyncedHoldings } from "./queries";
import { derivePortfolio } from "../domain/portfolio";
export type { AccountBreakdown } from "../domain/portfolio";

export function usePortfolio() {
  const { data: txns = [], isLoading: l1 } = useTransactions();
  const { data: securities = [], isLoading: l2 } = useSecurities();
  const { data: accounts = [], isLoading: l3 } = useAccounts();
  const { data: latest = [], isLoading: l4 } = useLatestPrices();
  const { data: previous = [], isLoading: l5 } = usePreviousPrices();
  const { data: synced = [], isLoading: l6 } = useSyncedHoldings();

  return useMemo(() => ({
    ...derivePortfolio({ txns, securities, accounts, latest, previous, synced }),
    isLoading: l1 || l2 || l3 || l4 || l5 || l6,
  }), [txns, securities, accounts, latest, previous, synced, l1, l2, l3, l4, l5, l6]);
}
```

- [ ] **Step 10: Rewrite `src/data/useRefresh.ts`**

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { keys } from "./queries";
import { derivePortfolio } from "../domain/portfolio";

export function useRefreshPrices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const updated = await api.prices.refresh();
      await qc.invalidateQueries({ queryKey: keys.latest });
      await qc.invalidateQueries({ queryKey: keys.previous });

      // Recompute total value with the same derivation the screens use, then
      // record today's snapshot for the chart.
      const [txns, securities, accounts, latest, previous, synced] = await Promise.all([
        api.transactions.list(), api.securities.list(), api.accounts.list(),
        api.prices.latest(), api.prices.previous(), api.syncedHoldings.list(),
      ]);
      const { summary } = derivePortfolio({ txns, securities, accounts, latest, previous, synced });
      await api.snapshots.record(new Date().toISOString().slice(0, 10), summary.totalValue);
      await qc.invalidateQueries({ queryKey: keys.snapshots });
      return updated;
    },
  });
}
```

- [ ] **Step 11: Verify**

Run: `npm test` then `npx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 12: Commit**

```bash
git add src/domain src/data
git commit -m "feat(domain): derivePortfolio merges synced holdings and balances"
```

---

### Task 16: Sidebar sync button

**Files:**
- Create: `src/app/SyncButton.tsx`
- Modify: `src/app/AppShell.tsx`

- [ ] **Step 1: Create `src/app/SyncButton.tsx`**

```tsx
import { useSimplefinStatus, useSimplefinSync } from "../data/queries";
import { Button } from "../ui/components";
import { useToast } from "../ui/toast";
import { timeAgo } from "../ui/format";
import { Icons } from "./icons";

export function SyncButton() {
  const { data: status } = useSimplefinStatus();
  const sync = useSimplefinSync();
  const toast = useToast();
  if (!status?.connected) return null;

  function run() {
    sync.mutate(undefined, {
      onSuccess: (r) => toast.push({
        tone: r.errors.length ? "neutral" : "pos",
        title: `Synced ${r.accounts_synced} account${r.accounts_synced === 1 ? "" : "s"}`,
        body: [r.holdings_synced ? `${r.holdings_synced} holdings` : "", r.errors[0] ?? ""].filter(Boolean).join(" · "),
      }),
      onError: (e) => toast.push({ tone: "neg", title: "Sync failed", body: String(e) }),
    });
  }

  return (
    <div className="grid" style={{ gap: 4 }}>
      <Button variant="secondary" size="sm" block loading={sync.isPending} onClick={run}>
        <Icons.sync /> Sync SimpleFIN
      </Button>
      <div className="muted" style={{ fontSize: 11, textAlign: "center" }}>Last synced {timeAgo(status.last_synced_at)}</div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into the shell**

`src/app/AppShell.tsx`:

```tsx
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { SyncButton } from "./SyncButton";

export function AppShell() {
  return (
    <div className="layout">
      <Sidebar footer={<SyncButton />} />
      <main className="main"><div className="page"><Outlet /></div></main>
    </div>
  );
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/app
git commit -m "feat(ui): sidebar SimpleFIN sync button with toast feedback"
```

---

### Task 17: Settings SimpleFIN card

**Files:**
- Rewrite: `src/features/settings/SimplefinCard.tsx`

- [ ] **Step 1: Rewrite the card**

```tsx
import { useState } from "react";
import { useSimplefinStatus, useSimplefinConnect, useSimplefinSync, useSimplefinDisconnect } from "../../data/queries";
import { Card, Button, Badge } from "../../ui/components";
import { timeAgo } from "../../ui/format";
import type { SyncReport } from "../../domain/types";

const DEMO_TOKEN = "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9kZW1v";

function Report({ r }: { r: SyncReport }) {
  return (
    <div className="grid" style={{ gap: 6 }}>
      <div className="notice pos">
        Synced {r.accounts_synced} account{r.accounts_synced === 1 ? "" : "s"} and {r.holdings_synced} holding{r.holdings_synced === 1 ? "" : "s"}.
        {r.holdings_skipped > 0 && ` ${r.holdings_skipped} holding${r.holdings_skipped === 1 ? "" : "s"} had no ticker symbol and were skipped.`}
      </div>
      {r.errors.map((e, i) => <div key={i} className="notice warn">{e}</div>)}
    </div>
  );
}

export function SimplefinCard() {
  const { data: status, isLoading } = useSimplefinStatus();
  const connect = useSimplefinConnect();
  const sync = useSimplefinSync();
  const disconnect = useSimplefinDisconnect();
  const [token, setToken] = useState("");
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState("");

  function doConnect() {
    setError(""); setReport(null);
    connect.mutate(token, {
      onSuccess: (r) => { setReport(r); setToken(""); },
      onError: (e) => setError(String(e)),
    });
  }
  function doSync() {
    setError(""); setReport(null);
    sync.mutate(undefined, { onSuccess: setReport, onError: (e) => setError(String(e)) });
  }
  function doDisconnect() {
    const removeAccounts = confirm("Also remove the accounts SimpleFIN created in Ledgerly?\n\nOK = remove them and their holdings.\nCancel = keep them (they just stop updating).");
    setError(""); setReport(null);
    disconnect.mutate(removeAccounts, { onError: (e) => setError(String(e)) });
  }

  if (isLoading) return <Card title="SimpleFIN"><p className="muted">Checking connection…</p></Card>;

  if (status?.connected) {
    return (
      <Card title="SimpleFIN" subtitle="Bank and brokerage sync"
        actions={<Badge tone="pos">Connected</Badge>}>
        <div className="grid" style={{ gap: 12 }}>
          <div className="muted">Last synced {timeAgo(status.last_synced_at)}. Balances and holdings update each time you sync.</div>
          <div className="row center">
            <Button onClick={doSync} loading={sync.isPending}>Sync now</Button>
            <Button variant="danger" onClick={doDisconnect} loading={disconnect.isPending}>Disconnect</Button>
          </div>
          {report && <Report r={report} />}
          {error && <div className="notice neg">{error}</div>}
        </div>
      </Card>
    );
  }

  return (
    <Card title="SimpleFIN" subtitle="Pull balances and holdings from your banks and brokerages automatically."
      actions={<Badge>Not connected</Badge>}>
      <div className="grid" style={{ gap: 14 }}>
        <ol className="steps">
          <li>Sign up at <a href="https://bridge.simplefin.org" target="_blank" rel="noreferrer">bridge.simplefin.org</a> (about $1.50/month).</li>
          <li>Connect each bank or brokerage you want in Ledgerly.</li>
          <li>Click <strong>New Setup Token</strong>, copy it, and paste it below. Tokens work once, so make a new one if this fails.</li>
        </ol>
        <label>
          Setup token
          <textarea rows={3} value={token} onChange={(e) => setToken(e.target.value)}
            placeholder="Paste your SimpleFIN setup token here" spellCheck={false} />
        </label>
        <div className="row center">
          <Button onClick={doConnect} loading={connect.isPending} disabled={!token.trim()}>Connect and sync</Button>
          <Button variant="ghost" size="sm" onClick={() => setToken(DEMO_TOKEN)}>Try the demo</Button>
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          Your access credentials are kept in Windows Credential Manager, never in the database. Only account balances and holdings are downloaded.
        </p>
        {report && <Report r={report} />}
        {error && <div className="notice neg">{error}</div>}
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` then `npm test`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/features/settings/SimplefinCard.tsx
git commit -m "feat(simplefin): settings card to connect, sync, and disconnect"
```

---

### Task 18: End-to-end check with the demo token + docs

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Full test run**

Run from repo root: `npm test`, `npx tsc --noEmit`; from `src-tauri`: `cargo test`.
Expected: all green.

- [ ] **Step 2: Live check in the app**

Run: `npm run tauri dev`. In the app:
1. Settings → Appearance: toggle Light / Dark / Auto; confirm every screen re-themes, including chart axes and tooltips.
2. Settings → SimpleFIN → **Try the demo** → **Connect and sync**. Expected: green report "Synced 3 accounts and 0 holdings."; Accounts shows three SimpleFIN-badged cash accounts with balances; Dashboard total includes them; the sidebar shows "Sync SimpleFIN · Last synced just now".
3. Click the sidebar Sync button → toast "Synced 3 accounts".
4. Activity → select a synced account → the info notice appears instead of forms.
5. Settings → Disconnect → OK (remove accounts). Expected: accounts gone, sidebar button hidden, card back to "Not connected".
6. Paste a junk token → readable error. Paste the demo token twice (second time after disconnect) — the demo token is reusable so this succeeds; a real token would show the "already used" message.

If anything fails, fix it in the task that owns that file and re-run the relevant tests before continuing.

- [ ] **Step 3: Update `docs/HANDOFF.md`**

- In "What's built", add bullets: **Theme** (light/dark/system in the sidebar and Settings, shared components in `src/ui/`), **SimpleFIN sync** (Settings card, sidebar Sync, balances + holdings, credential in Windows Credential Manager, demo token for testing).
- In "Architecture", add: `src/domain/portfolio.ts` `derivePortfolio()` is now the single derivation point (the hook and the snapshot recorder both call it); `src-tauri/src/simplefin/` and `secrets.rs`.
- In "Gotchas", add: schema is at `user_version` 2; the demo SimpleFIN feed has no holdings so holdings are covered by unit fixtures; the access URL lives in Credential Manager under service "Ledgerly" — deleting the database does **not** disconnect SimpleFIN.
- In "Remaining work", remove item 2 (SimpleFIN) and add "SimpleFIN scheduled auto-sync" and "SimpleFIN transaction import (for budgeting)".
- Update the test counts line.

- [ ] **Step 4: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: handoff updated for theme, shared UI, and SimpleFIN sync"
```
