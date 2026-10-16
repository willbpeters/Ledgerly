# Device Sync (PC ⇄ Laptop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner's edits (budgets, categories, rules, a transaction's category, note, reviewed and removed flags, account type and hidden, manual accounts and investment transactions) made on one computer show up on the other, through a Google Drive folder both computers can see.

**Architecture:** Each computer keeps its own SQLite database and keeps syncing SimpleFIN itself, so bank data already agrees on both. SQLite triggers record every *owner* edit into a local `sync_outbox` table, keyed by a stable `sync_key` instead of the local integer id (ids differ between computers). Each round, a computer writes its outbox to an immutable JSON file in `<folder>/changes/<its device id>/` and applies the other computer's new files, last writer wins per field. The second computer joins by restoring a copy of the first one's database (`<folder>/seed.sqlite`), using the existing backup/restore machinery.

**Tech Stack:** Rust (rusqlite 0.32, serde_json, chrono), SQLite triggers and JSON functions, Tauri v2 commands, React 19 + TanStack Query, Vitest.

---

## Design

### Why an edit log, not a shared database file

Putting `finance.sqlite` itself in Google Drive breaks. Google Drive uploads whole files, SQLite writes pages in place, and with both computers open you get conflict copies or a corrupt database. In this design **every file in the shared folder has exactly one writer, and nobody changes a file after it is written** (written as `.tmp`, then renamed). Google Drive never has to merge anything.

### What syncs and what does not

| Syncs (owner edits) | Does not sync (each computer derives or fetches it) |
|---|---|
| Categories: create, rename, colour, order, delete | Bank transactions SimpleFIN delivers: each computer fetches them |
| Budget limits | Automatic categories: each computer re-sorts with the same rules |
| Payee rules | Prices, snapshots, Markets cache |
| A bank transaction's manual category, note, reviewed, removed | Theme, column picker, "ask before removing" (localStorage, per computer) |
| Rows the Copilot import adds (history) | SimpleFIN credentials: in each computer's Windows credential store |
| Account type and hidden (all accounts); name, institution, currency, create, delete (manual accounts) | Manual price overrides (`prices_set_manual`): rare. Left out. |
| Manual investment transactions: create, delete | Backups |

### Keys

Local ids differ between computers, so every change names its row by a key both computers agree on:

| Table | Key | Where it comes from |
|---|---|---|
| accounts (SimpleFIN) | `sf:<SimpleFIN account id>` | Both computers derive it on their own |
| accounts (manual) | `acct:<random>` | Created once, then copied (seed or change file) |
| categories | `cat:<name at creation>`; a `:<random>` suffix if that key is taken | Built-ins agree; a rename keeps the key |
| bank_transactions | `<account key>\|<external_id at insert>` | SimpleFIN rows agree. A Copilot row keeps its `copilot:` key after a sync adopts it. |
| transactions | `txn:<random>` | Created once, then copied |
| category_rules | `<match_type>:<pattern>` | Natural key; no column |
| budgets | `<category key>\|<month or *>` | Natural key; no column |

### Change records

The outbox has one row per changed field: `(tbl, key, field, value JSON, at ms)`. Field `_row` means the whole row: a JSON object creates it, `null` deletes it. Foreign keys travel as keys: a category travels as `cat:Dining`, not `4`. A bank transaction's category travels as `[category key, "manual"|"auto"]`, so the category and its source always arrive together.

### Conflicts

Last writer wins, **per field**. `sync_clock(tbl, key, field) → (at, device)` stores the newest change seen. A change older than that is dropped. Ties go to the larger device id. So if you set a category on the PC and write a note on the laptop at the same time, you keep both.

### Changes that arrive early

A PC edit to a transaction the laptop's SimpleFIN sync hasn't fetched yet goes to `sync_pending` and is retried every round. A waiting change is dropped once a newer whole-row change for the same key arrives, or after 60 days.

### Triggers stay quiet when they should

Triggers record only when `sync_meta.enabled = '1'` and `sync_meta.applying <> '1'` (view `sync_on`). Applying the other computer's changes sets `applying` inside the same transaction, so applied changes are never echoed back. Automatic re-sorting writes `category_source='auto'` rows, which the triggers ignore.

### Pairing

1. **PC, Settings → Sync between computers → "Start with this computer"**, then pick e.g. `G:\My Drive\Ledgerly Sync`. This gives the PC a device id, turns recording on and writes `seed.sqlite` (a `VACUUM INTO` copy) into the folder.
2. **Laptop, same card → "Join"**, then pick the same folder. The laptop backs up its own data, stages `seed.sqlite` as a restore and restarts. On the restart, `meta::adopt` sees that the database's device id is not this computer's, empties the inherited outbox and takes the laptop's own id. From then on the laptop applies every PC change file the seed did not already contain. The seed's `sync_files_applied` lists the PC's own files, so nothing is applied twice.
3. The laptop keeps its own SimpleFIN connection. Its accounts already match by `sf:` key.

Joining **replaces the laptop's Ledgerly data with the PC's**. The confirmation says so, and the backup taken first makes it undoable.

### When a round runs

At launch, every 30 seconds while the window is visible, on hiding the window, after a SimpleFIN sync, and on "Sync now". The database lock is held only for the quick parts. Reading and writing the folder happens without it, because Google Drive may download a file before it can be read. (This is the rule from commit 2fc0f46.)

### Version skew

Each file records the writer's schema version (`db::TARGET_VERSION`). A file from a newer Ledgerly is left unapplied and counted. The card then says "Update Ledgerly on this computer (git pull)", and the file applies after updating.

### Folder layout

```
<folder>/
  seed.sqlite                         # the first computer's database at pairing time
  changes/<device id>/<ms>-<seq>.json # one immutable file per round with edits
  devices/<device id>.json            # {"id","name","last_sync"} for the card
```

### Tests baseline

296 TypeScript + 284 Rust tests pass as of 2026-10-15 (`docs/HANDOFF.md`). Every task below must leave `cargo test` (run in `src-tauri/`) and `npm test` passing.

---

## File structure

**Create (Rust, `src-tauri/src/devicesync/`):**
- `mod.rs`: module list and `DeviceSyncState`
- `schema.rs`: v9 columns, tables, backfill and triggers (`install`, `is_complete`)
- `meta.rs`: `sync_meta` get/set, enable/disable, `adopt` at launch, new device id
- `settings.rs`: `device-sync.json` beside the database (folder, device id)
- `clock.rs`: last-writer-wins bookkeeping in `sync_clock`
- `files.rs`: folder layout, change file format, atomic writes, listing, device files
- `outbox.rs`: take the outbox for writing, commit it once written
- `apply.rs`: apply one change to the database
- `pull.rs`: fetch the other computer's files, apply them in one transaction
- `pair.rs`: start as the first computer, join, stop
- `run.rs`: one sync round across lock and no-lock phases

**Create (Rust):** `src-tauri/src/commands/devicesync.rs`

**Modify (Rust):** `src-tauri/src/db.rs` (v9 hook, `pub(crate)` helpers), `src-tauri/src/lib.rs` (module, state, adopt at launch, commands), `src-tauri/src/commands/mod.rs`

**Create (TypeScript):**
- `src/data/deviceSyncSchedule.ts` + `.test.ts`: pure cadence decision
- `src/data/useDeviceSyncLoop.ts`: the background loop
- `src/features/settings/DeviceSyncPanel.tsx` + `.test.tsx`: card markup, props only
- `src/features/settings/DeviceSyncCard.tsx`: wires the panel to Tauri

**Modify (TypeScript):** `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts`, `src/features/settings/Settings.tsx`, `src/App.tsx`

**Modify (docs):** `docs/HANDOFF.md`

---

### Task 1: v9 migration: sync keys and bookkeeping tables

**Files:**
- Create: `src-tauri/src/devicesync/mod.rs`
- Create: `src-tauri/src/devicesync/schema.rs`
- Modify: `src-tauri/src/db.rs` (lines 27-35 doc and `TARGET_VERSION`, helpers at 270-297, `apply_migrations` ~401, `migration_pending` ~412)
- Modify: `src-tauri/src/lib.rs` (module list)

- [ ] **Step 1: Create the module skeleton**

`src-tauri/src/devicesync/mod.rs`:

```rust
//! Keeping two computers' Ledgerly in step through a shared folder (Google
//! Drive). Each computer keeps its own database and syncs SimpleFIN itself;
//! only the owner's edits travel, as immutable change files.
//! Design: docs/superpowers/plans/2026-10-16-device-sync.md
pub mod schema;
```

Add `mod devicesync;` to `src-tauri/src/lib.rs` after `mod backup;`.

- [ ] **Step 2: Write the failing tests**

`src-tauri/src/devicesync/schema.rs`:

```rust
//! The bookkeeping that lets two computers share the owner's edits: a stable
//! `sync_key` on every row the owner edits (local ids differ between
//! computers; keys do not), the outbox the triggers fill, and what has been
//! applied from the other computer.
use rusqlite::Connection;

pub fn is_complete(_conn: &Connection) -> rusqlite::Result<bool> {
    Ok(false)
}

pub fn install(_conn: &Connection) -> rusqlite::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn text(conn: &Connection, sql: &str) -> Option<String> {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_fresh_database_has_the_sync_tables_and_columns() {
        let conn = db::open_in_memory().unwrap();
        assert!(is_complete(&conn).unwrap());
    }

    #[test]
    fn existing_rows_get_keys_both_computers_would_agree_on() {
        let conn = db::open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'TRN-1','2026-10-01',-5,'Coffee');
             UPDATE accounts SET sync_key=NULL;
             UPDATE bank_transactions SET sync_key=NULL;
             UPDATE categories SET sync_key=NULL;",
        )
        .unwrap();

        install(&conn).unwrap();

        assert_eq!(text(&conn, "SELECT sync_key FROM accounts WHERE id=1").as_deref(), Some("sf:ACT-1"));
        assert_eq!(
            text(&conn, "SELECT sync_key FROM bank_transactions WHERE id=1").as_deref(),
            Some("sf:ACT-1|TRN-1")
        );
        assert_eq!(
            text(&conn, "SELECT sync_key FROM categories WHERE name='Groceries'").as_deref(),
            Some("cat:Groceries")
        );
    }

    #[test]
    fn a_manual_account_gets_a_random_key() {
        let conn = db::open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Cash jar','cash','USD','2026-01-01');
             UPDATE accounts SET sync_key=NULL;",
        )
        .unwrap();
        install(&conn).unwrap();
        let key = text(&conn, "SELECT sync_key FROM accounts WHERE id=1").unwrap();
        assert!(key.starts_with("acct:") && key.len() == 5 + 32, "{key}");
    }

    #[test]
    fn installing_twice_is_harmless() {
        let conn = db::open_in_memory().unwrap();
        install(&conn).unwrap();
        install(&conn).unwrap();
        assert!(is_complete(&conn).unwrap());
    }
}
```

Add `pub mod schema;` is already in `mod.rs` (Step 1).

- [ ] **Step 3: Run the tests to verify they fail**

Run (in `src-tauri/`): `cargo test devicesync::schema`
Expected: FAIL. `a_fresh_database_has_the_sync_tables_and_columns` asserts false, and the others fail with "no such column: sync_key".

- [ ] **Step 4: Implement `schema.rs`**

Replace the two stub functions in `src-tauri/src/devicesync/schema.rs` with:

```rust
/// Tables whose rows carry a `sync_key` column. Budgets and rules need none:
/// their natural keys (category + month; type + pattern) already agree.
pub const KEYED_TABLES: &[&str] = &["accounts", "categories", "bank_transactions", "transactions"];

const SYNC_TABLES: &[&str] = &["sync_meta", "sync_outbox", "sync_clock", "sync_files_applied", "sync_pending"];

const TABLES: &str = "
CREATE TABLE IF NOT EXISTS sync_meta (name TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sync_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL,
  value TEXT, at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_clock (
  tbl TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL,
  at INTEGER NOT NULL, device TEXT NOT NULL,
  PRIMARY KEY (tbl, key, field)
);
CREATE TABLE IF NOT EXISTS sync_files_applied (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sync_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL,
  value TEXT, at INTEGER NOT NULL
);
DROP VIEW IF EXISTS sync_on;
CREATE VIEW sync_on AS SELECT
  coalesce((SELECT value FROM sync_meta WHERE name='enabled'), '0') = '1'
  AND coalesce((SELECT value FROM sync_meta WHERE name='applying'), '0') <> '1' AS yes;
";

/// Keys for rows that existed before v9. SimpleFIN accounts, their
/// transactions and categories get keys the other computer derives the same
/// way; manual rows get random ones, which reach the other computer in the
/// seed copy.
const BACKFILL: &str = "
UPDATE accounts SET sync_key = CASE
    WHEN source = 'simplefin' AND external_id IS NOT NULL THEN 'sf:' || external_id
    ELSE 'acct:' || lower(hex(randomblob(16))) END
  WHERE sync_key IS NULL;
UPDATE categories SET sync_key = 'cat:' || name WHERE sync_key IS NULL;
UPDATE bank_transactions SET sync_key =
    (SELECT a.sync_key FROM accounts a WHERE a.id = bank_transactions.account_id) || '|' || external_id
  WHERE sync_key IS NULL;
UPDATE transactions SET sync_key = 'txn:' || lower(hex(randomblob(16))) WHERE sync_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_sync_key ON accounts(sync_key);
CREATE UNIQUE INDEX IF NOT EXISTS categories_sync_key ON categories(sync_key);
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_sync_key ON bank_transactions(sync_key);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_sync_key ON transactions(sync_key);
";

/// Whether every v9 object is really present, whatever the version stamp says.
pub fn is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    for table in KEYED_TABLES {
        if !crate::db::column_exists(conn, table, "sync_key")? {
            return Ok(false);
        }
    }
    for table in SYNC_TABLES {
        if !crate::db::table_exists(conn, table)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Safe to re-run: every step is conditional. One transaction, so an
/// interruption leaves v8 or the finished v9.
pub fn install(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for table in KEYED_TABLES {
        crate::db::add_column_if_missing(&tx, table, "sync_key", "sync_key TEXT")?;
    }
    tx.execute_batch(TABLES)?;
    tx.execute_batch(BACKFILL)?;
    tx.commit()
}
```

- [ ] **Step 5: Hook v9 into `db.rs`**

In `src-tauri/src/db.rs`:

1. Change `const TARGET_VERSION: i64 = 8;` to `pub(crate) const TARGET_VERSION: i64 = 9;`, and add to the end of the doc comment above it: `v9 adds device sync (sync keys, the outbox and its triggers).`
2. Change `fn table_exists`, `fn column_exists` and `fn add_column_if_missing` to `pub(crate) fn`.
3. In `apply_migrations`, after the `v8` block, add:

```rust
    if !crate::devicesync::schema::is_complete(conn)? {
        crate::devicesync::schema::install(conn)?;
    }
```

4. In `migration_pending`, add `|| !crate::devicesync::schema::is_complete(conn)?` after the v8 check.

- [ ] **Step 6: Run the tests**

Run: `cargo test devicesync::schema`
Expected: PASS (4 tests).

Run: `cargo test`
Expected: all pass. If a test in `db.rs` asserts a literal version `8`, change it to `TARGET_VERSION`.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/devicesync src-tauri/src/db.rs src-tauri/src/lib.rs
git commit -m "feat(db): v9 gives edited rows a sync key and adds the sync tables"
```

---

### Task 2: Triggers that record the owner's edits

**Files:**
- Modify: `src-tauri/src/devicesync/schema.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `schema.rs`:

```rust
    fn enabled() -> Connection {
        let conn = db::open_in_memory().unwrap();
        conn.execute_batch("INSERT OR REPLACE INTO sync_meta VALUES ('enabled','1');").unwrap();
        conn
    }

    /// (tbl, key, field, value) for everything recorded, oldest first.
    fn outbox(conn: &Connection) -> Vec<(String, String, String, Option<String>)> {
        let mut stmt = conn.prepare("SELECT tbl, key, field, value FROM sync_outbox ORDER BY seq").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    fn simplefin_txn(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'TRN-1','2026-10-01',-5,'Coffee');",
        )
        .unwrap();
    }

    #[test]
    fn new_rows_get_their_key_from_the_insert_trigger() {
        let conn = enabled();
        simplefin_txn(&conn);
        assert_eq!(text(&conn, "SELECT sync_key FROM accounts WHERE id=1").as_deref(), Some("sf:ACT-1"));
        assert_eq!(text(&conn, "SELECT sync_key FROM bank_transactions WHERE id=1").as_deref(), Some("sf:ACT-1|TRN-1"));
    }

    #[test]
    fn what_simplefin_delivers_is_not_recorded() {
        let conn = enabled();
        simplefin_txn(&conn);
        assert!(outbox(&conn).is_empty(), "{:?}", outbox(&conn));
    }

    #[test]
    fn choosing_a_category_is_recorded_with_the_category_key() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Dining'),
               category_source='manual', reviewed=1 WHERE id=1;",
        )
        .unwrap();
        let rows = outbox(&conn);
        assert!(rows.contains(&(
            "bank_transactions".into(), "sf:ACT-1|TRN-1".into(), "category".into(),
            Some(r#"["cat:Dining","manual"]"#.into())
        )), "{rows:?}");
        assert!(rows.contains(&(
            "bank_transactions".into(), "sf:ACT-1|TRN-1".into(), "reviewed".into(), Some("1".into())
        )), "{rows:?}");
    }

    #[test]
    fn automatic_sorting_is_not_recorded() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Dining') WHERE id=1;",
        )
        .unwrap();
        assert!(outbox(&conn).is_empty());
    }

    #[test]
    fn nothing_is_recorded_while_sync_is_off_or_while_applying() {
        let conn = db::open_in_memory().unwrap();
        simplefin_txn(&conn);
        conn.execute_batch("UPDATE bank_transactions SET note='lunch' WHERE id=1;").unwrap();
        assert!(outbox(&conn).is_empty(), "off");

        conn.execute_batch(
            "INSERT OR REPLACE INTO sync_meta VALUES ('enabled','1');
             INSERT OR REPLACE INTO sync_meta VALUES ('applying','1');
             UPDATE bank_transactions SET note='dinner' WHERE id=1;",
        )
        .unwrap();
        assert!(outbox(&conn).is_empty(), "applying");
    }

    #[test]
    fn a_manual_account_is_recorded_as_a_whole_row_and_its_deletion_as_null() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Cash jar','cash','USD','2026-01-01');",
        )
        .unwrap();
        let key = text(&conn, "SELECT sync_key FROM accounts WHERE id=1").unwrap();
        conn.execute_batch("DELETE FROM accounts WHERE id=1;").unwrap();

        let rows = outbox(&conn);
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str(), rows[0].2.as_str()), ("accounts", key.as_str(), "_row"));
        let row: serde_json::Value = serde_json::from_str(rows[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(row["name"], "Cash jar");
        assert_eq!(rows[1].3, None);
    }

    #[test]
    fn hiding_a_simplefin_account_is_recorded_but_its_renaming_is_not() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch("UPDATE accounts SET hidden=1, name='Visa' WHERE id=1;").unwrap();
        assert_eq!(outbox(&conn), vec![("accounts".into(), "sf:ACT-1".into(), "hidden".into(), Some("1".into()))]);
    }

    #[test]
    fn a_budget_is_recorded_under_its_category_and_month() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO budgets (category_id, month, limit_amount)
               VALUES ((SELECT id FROM categories WHERE name='Groceries'), NULL, 400);
             UPDATE budgets SET limit_amount=450;",
        )
        .unwrap();
        let rows = outbox(&conn);
        assert_eq!(rows[0].1, "cat:Groceries|*");
        assert_eq!(rows[1], ("budgets".into(), "cat:Groceries|*".into(), "limit_amount".into(), Some("450.0".into())));
    }

    #[test]
    fn deleting_a_category_that_has_a_budget_still_works() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO budgets (category_id, month, limit_amount)
               VALUES ((SELECT id FROM categories WHERE name='Groceries'), '2026-10', 400);
             DELETE FROM categories WHERE name='Groceries';",
        )
        .unwrap();
        assert!(outbox(&conn).iter().any(|r| r.0 == "categories" && r.1 == "cat:Groceries" && r.3.is_none()));
    }

    #[test]
    fn a_rule_is_recorded_by_type_and_pattern() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO category_rules (match_type, pattern, category_id, created_at)
               VALUES ('payee', 'blue bottle', (SELECT id FROM categories WHERE name='Dining'), '2026-10-16');",
        )
        .unwrap();
        let rows = outbox(&conn);
        assert_eq!(rows[0].1, "payee:blue bottle");
        let row: serde_json::Value = serde_json::from_str(rows[0].3.as_deref().unwrap()).unwrap();
        assert_eq!(row["category"], "cat:Dining");
    }

    #[test]
    fn a_manual_investment_transaction_carries_its_security() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Brokerage','brokerage','USD','2026-01-01');
             INSERT INTO securities (ticker,name,type) VALUES ('VTI','Vanguard Total','etf');
             INSERT INTO transactions (account_id,security_id,type,date,quantity,price,amount)
               VALUES (1,1,'buy','2026-10-01',2,250,500);",
        )
        .unwrap();
        let rows = outbox(&conn);
        let txn = rows.iter().find(|r| r.0 == "transactions").unwrap();
        assert!(txn.1.starts_with("txn:"));
        let row: serde_json::Value = serde_json::from_str(txn.3.as_deref().unwrap()).unwrap();
        assert_eq!(row["security"]["ticker"], "VTI");
        assert_eq!(row["quantity"], 2.0);
    }

    #[test]
    fn renaming_a_category_then_reusing_its_old_name_keeps_keys_unique() {
        let conn = enabled();
        conn.execute_batch(
            "UPDATE categories SET name='Eating out' WHERE name='Dining';
             INSERT INTO categories (name,kind,colour,sort) VALUES ('Dining','spending','chart-1',5);",
        )
        .unwrap();
        let fresh = text(&conn, "SELECT sync_key FROM categories WHERE name='Dining'").unwrap();
        assert!(fresh.starts_with("cat:Dining:"), "{fresh}");
        assert_eq!(text(&conn, "SELECT sync_key FROM categories WHERE name='Eating out'").as_deref(), Some("cat:Dining"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test devicesync::schema`
Expected: FAIL. Keys are NULL on new rows, and the outbox is empty.

- [ ] **Step 3: Add the triggers**

In `schema.rs`, add above `is_complete`:

```rust
/// Now in milliseconds since 1970, inside SQL.
const NOW: &str = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)";

const TRIGGER_NAMES: &[&str] = &[
    "accounts_sync_insert", "accounts_sync_update", "accounts_sync_delete",
    "categories_sync_insert", "categories_sync_update", "categories_sync_delete",
    "bank_transactions_sync_insert", "bank_transactions_sync_update",
    "category_rules_sync_insert", "category_rules_sync_update", "category_rules_sync_delete",
    "budgets_sync_insert", "budgets_sync_update", "budgets_sync_delete",
    "transactions_sync_insert", "transactions_sync_delete",
];

/// Every insert trigger first gives the new row its key (always, so keys
/// exist before sync is ever turned on), then records it if it is the
/// owner's. Update triggers are `UPDATE OF` the owner's columns only, so the
/// key-filling UPDATE and SimpleFIN's balance updates never fire them.
/// `{NOW}` is replaced with the millisecond clock at install.
const TRIGGERS: &str = "
CREATE TRIGGER accounts_sync_insert AFTER INSERT ON accounts BEGIN
  UPDATE accounts SET sync_key = CASE
      WHEN NEW.source = 'simplefin' AND NEW.external_id IS NOT NULL THEN 'sf:' || NEW.external_id
      ELSE 'acct:' || lower(hex(randomblob(16))) END
    WHERE id = NEW.id AND sync_key IS NULL;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'accounts', a.sync_key, '_row',
      json_object('name', a.name, 'type', a.type, 'institution', a.institution,
                  'currency', a.currency, 'created_at', a.created_at, 'hidden', a.hidden), {NOW}
    FROM accounts a WHERE a.id = NEW.id AND a.source = 'manual' AND (SELECT yes FROM sync_on);
END;

CREATE TRIGGER accounts_sync_update AFTER UPDATE OF type, hidden, name, institution, currency ON accounts
WHEN (SELECT yes FROM sync_on) AND NEW.sync_key IS NOT NULL BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'accounts', NEW.sync_key, 'type', json_quote(NEW.type), {NOW} WHERE OLD.type IS NOT NEW.type;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'accounts', NEW.sync_key, 'hidden', json_quote(NEW.hidden), {NOW} WHERE OLD.hidden IS NOT NEW.hidden;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'accounts', NEW.sync_key, 'name', json_quote(NEW.name), {NOW}
    WHERE NEW.source = 'manual' AND OLD.name IS NOT NEW.name;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'accounts', NEW.sync_key, 'institution', json_quote(NEW.institution), {NOW}
    WHERE NEW.source = 'manual' AND OLD.institution IS NOT NEW.institution;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'accounts', NEW.sync_key, 'currency', json_quote(NEW.currency), {NOW}
    WHERE NEW.source = 'manual' AND OLD.currency IS NOT NEW.currency;
END;

CREATE TRIGGER accounts_sync_delete AFTER DELETE ON accounts
WHEN OLD.source = 'manual' AND OLD.sync_key IS NOT NULL AND (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at) VALUES ('accounts', OLD.sync_key, '_row', NULL, {NOW});
END;

CREATE TRIGGER categories_sync_insert AFTER INSERT ON categories BEGIN
  UPDATE categories SET sync_key = CASE
      WHEN EXISTS (SELECT 1 FROM categories WHERE sync_key = 'cat:' || NEW.name)
        THEN 'cat:' || NEW.name || ':' || lower(hex(randomblob(4)))
      ELSE 'cat:' || NEW.name END
    WHERE id = NEW.id AND sync_key IS NULL;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'categories', c.sync_key, '_row',
      json_object('name', c.name, 'kind', c.kind, 'colour', c.colour, 'sort', c.sort,
                  'is_builtin', c.is_builtin), {NOW}
    FROM categories c WHERE c.id = NEW.id AND (SELECT yes FROM sync_on);
END;

CREATE TRIGGER categories_sync_update AFTER UPDATE OF name, colour, sort ON categories
WHEN (SELECT yes FROM sync_on) AND NEW.sync_key IS NOT NULL BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'categories', NEW.sync_key, 'name', json_quote(NEW.name), {NOW} WHERE OLD.name IS NOT NEW.name;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'categories', NEW.sync_key, 'colour', json_quote(NEW.colour), {NOW} WHERE OLD.colour IS NOT NEW.colour;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'categories', NEW.sync_key, 'sort', json_quote(NEW.sort), {NOW} WHERE OLD.sort IS NOT NEW.sort;
END;

CREATE TRIGGER categories_sync_delete AFTER DELETE ON categories
WHEN OLD.sync_key IS NOT NULL AND (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at) VALUES ('categories', OLD.sync_key, '_row', NULL, {NOW});
END;

CREATE TRIGGER bank_transactions_sync_insert AFTER INSERT ON bank_transactions BEGIN
  UPDATE bank_transactions SET sync_key =
      (SELECT a.sync_key FROM accounts a WHERE a.id = NEW.account_id) || '|' || NEW.external_id
    WHERE id = NEW.id AND sync_key IS NULL;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', b.sync_key, '_row',
      json_object('account', a.sync_key, 'external_id', b.external_id, 'posted', b.posted,
        'amount', b.amount, 'description', b.description, 'payee', b.payee, 'memo', b.memo,
        'category', (SELECT c.sync_key FROM categories c WHERE c.id = b.category_id),
        'category_source', b.category_source, 'reviewed', b.reviewed, 'note', b.note,
        'removed', b.removed), {NOW}
    FROM bank_transactions b JOIN accounts a ON a.id = b.account_id
    WHERE b.id = NEW.id AND (a.source = 'manual' OR b.external_id LIKE 'copilot:%')
      AND (SELECT yes FROM sync_on);
END;

CREATE TRIGGER bank_transactions_sync_update
AFTER UPDATE OF category_id, category_source, note, reviewed, removed ON bank_transactions
WHEN (SELECT yes FROM sync_on) AND NEW.sync_key IS NOT NULL BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', NEW.sync_key, 'category',
      json_array((SELECT c.sync_key FROM categories c WHERE c.id = NEW.category_id), NEW.category_source), {NOW}
    WHERE (NEW.category_source = 'manual'
             AND (OLD.category_source <> 'manual' OR OLD.category_id IS NOT NEW.category_id))
       OR (NEW.category_source = 'auto' AND OLD.category_source = 'manual');
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', NEW.sync_key, 'note', json_quote(NEW.note), {NOW} WHERE OLD.note IS NOT NEW.note;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', NEW.sync_key, 'reviewed', json_quote(NEW.reviewed), {NOW}
    WHERE OLD.reviewed IS NOT NEW.reviewed;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', NEW.sync_key, 'removed', json_quote(NEW.removed), {NOW}
    WHERE OLD.removed IS NOT NEW.removed;
END;

CREATE TRIGGER category_rules_sync_insert AFTER INSERT ON category_rules
WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    VALUES ('category_rules', NEW.match_type || ':' || NEW.pattern, '_row',
      json_object('match_type', NEW.match_type, 'pattern', NEW.pattern,
        'category', (SELECT sync_key FROM categories WHERE id = NEW.category_id),
        'created_at', NEW.created_at), {NOW});
END;

CREATE TRIGGER category_rules_sync_update AFTER UPDATE OF category_id ON category_rules
WHEN (SELECT yes FROM sync_on) AND OLD.category_id IS NOT NEW.category_id BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    VALUES ('category_rules', NEW.match_type || ':' || NEW.pattern, 'category',
      json_quote((SELECT sync_key FROM categories WHERE id = NEW.category_id)), {NOW});
END;

CREATE TRIGGER category_rules_sync_delete AFTER DELETE ON category_rules
WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    VALUES ('category_rules', OLD.match_type || ':' || OLD.pattern, '_row', NULL, {NOW});
END;

-- Budget keys need the category's key. When a category delete cascades to
-- its budgets the category row is already gone, the SELECT finds nothing and
-- nothing is recorded: the category's own deletion carries the news.
CREATE TRIGGER budgets_sync_insert AFTER INSERT ON budgets WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'budgets', c.sync_key || '|' || coalesce(NEW.month, '*'), '_row',
      json_object('limit_amount', NEW.limit_amount), {NOW}
    FROM categories c WHERE c.id = NEW.category_id AND c.sync_key IS NOT NULL;
END;

CREATE TRIGGER budgets_sync_update AFTER UPDATE OF limit_amount ON budgets
WHEN (SELECT yes FROM sync_on) AND OLD.limit_amount IS NOT NEW.limit_amount BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'budgets', c.sync_key || '|' || coalesce(NEW.month, '*'), 'limit_amount',
      json_quote(NEW.limit_amount), {NOW}
    FROM categories c WHERE c.id = NEW.category_id AND c.sync_key IS NOT NULL;
END;

CREATE TRIGGER budgets_sync_delete AFTER DELETE ON budgets WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'budgets', c.sync_key || '|' || coalesce(OLD.month, '*'), '_row', NULL, {NOW}
    FROM categories c WHERE c.id = OLD.category_id AND c.sync_key IS NOT NULL;
END;

CREATE TRIGGER transactions_sync_insert AFTER INSERT ON transactions BEGIN
  UPDATE transactions SET sync_key = 'txn:' || lower(hex(randomblob(16)))
    WHERE id = NEW.id AND sync_key IS NULL;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'transactions', t.sync_key, '_row',
      json_object('account', a.sync_key,
        'security', json(CASE WHEN s.id IS NULL THEN 'null'
          ELSE json_object('ticker', s.ticker, 'name', s.name, 'type', s.type, 'currency', s.currency) END),
        'type', t.type, 'date', t.date, 'quantity', t.quantity, 'price', t.price,
        'amount', t.amount, 'fees', t.fees, 'note', t.note), {NOW}
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    LEFT JOIN securities s ON s.id = t.security_id
    WHERE t.id = NEW.id AND (SELECT yes FROM sync_on);
END;

CREATE TRIGGER transactions_sync_delete AFTER DELETE ON transactions
WHEN OLD.sync_key IS NOT NULL AND (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at) VALUES ('transactions', OLD.sync_key, '_row', NULL, {NOW});
END;
";

fn trigger_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name=?1",
        [name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}
```

Then change `is_complete` to also require the triggers. Add before `Ok(true)`:

```rust
    for name in TRIGGER_NAMES {
        if !trigger_exists(conn, name)? {
            return Ok(false);
        }
    }
```

And in `install`, after `tx.execute_batch(BACKFILL)?;`:

```rust
    // Dropped and recreated rather than IF NOT EXISTS, so a later build that
    // changes a trigger body can simply re-run this.
    for name in TRIGGER_NAMES {
        tx.execute_batch(&format!("DROP TRIGGER IF EXISTS {name};"))?;
    }
    tx.execute_batch(&TRIGGERS.replace("{NOW}", NOW))?;
```

- [ ] **Step 4: Run the tests**

Run: `cargo test devicesync::schema`
Expected: PASS (15 tests).

Run: `cargo test`
Expected: all pass. The triggers record nothing while `enabled` is unset, so existing tests are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/devicesync/schema.rs
git commit -m "feat(devicesync): triggers record the owner's edits into an outbox"
```

---

### Task 3: Settings file and sync_meta

**Files:**
- Create: `src-tauri/src/devicesync/settings.rs`
- Create: `src-tauri/src/devicesync/meta.rs`
- Modify: `src-tauri/src/devicesync/mod.rs`

- [ ] **Step 1: Write `settings.rs` with its tests**

```rust
//! `device-sync.json` beside the database: which shared folder, and this
//! computer's device id. Beside rather than inside the database, because
//! joining replaces the database with the other computer's copy, and that copy
//! must not decide who this computer is.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceSyncSettings {
    pub folder: Option<String>,
    pub device_id: Option<String>,
}

pub fn path(app_dir: &Path) -> PathBuf {
    app_dir.join("device-sync.json")
}

/// Missing or unreadable means "not syncing": it must never stop the app opening.
pub fn load(path: &Path) -> DeviceSyncSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &DeviceSyncSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Couldn't save the sync settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_means_not_syncing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&path(dir.path())), DeviceSyncSettings::default());
    }

    #[test]
    fn settings_survive_a_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let s = DeviceSyncSettings { folder: Some(r"G:\My Drive\Ledgerly Sync".into()), device_id: Some("ab12".into()) };
        save(&path(dir.path()), &s).unwrap();
        assert_eq!(load(&path(dir.path())), s);
    }
}
```

- [ ] **Step 2: Write the failing `meta.rs` tests**

```rust
//! The `sync_meta` table: this computer's device id as the triggers see it,
//! and the `enabled` / `applying` switches the `sync_on` view reads.
use super::settings::DeviceSyncSettings;
use rusqlite::{Connection, OptionalExtension};

pub fn get(conn: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_meta WHERE name=?1", [name], |r| r.get(0)).optional()
}

pub fn set(conn: &Connection, name: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO sync_meta (name, value) VALUES (?1, ?2)", [name, value])?;
    Ok(())
}

pub fn new_device_id(_conn: &Connection) -> rusqlite::Result<String> {
    unimplemented!()
}

pub fn enable(_conn: &Connection, _device_id: &str) -> rusqlite::Result<()> {
    unimplemented!()
}

pub fn disable(_conn: &Connection) -> rusqlite::Result<()> {
    unimplemented!()
}

pub fn adopt(_conn: &Connection, _settings: &DeviceSyncSettings) -> rusqlite::Result<()> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn outbox_len(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get(0)).unwrap()
    }

    fn syncing(id: &str) -> DeviceSyncSettings {
        DeviceSyncSettings { folder: Some("G:\\Sync".into()), device_id: Some(id.into()) }
    }

    #[test]
    fn device_ids_are_sixteen_hex_characters_and_differ() {
        let conn = db::open_in_memory().unwrap();
        let a = new_device_id(&conn).unwrap();
        let b = new_device_id(&conn).unwrap();
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn adopting_turns_recording_on_with_this_computers_id() {
        let conn = db::open_in_memory().unwrap();
        adopt(&conn, &syncing("laptop")).unwrap();
        assert_eq!(get(&conn, "device").unwrap().as_deref(), Some("laptop"));
        assert_eq!(get(&conn, "enabled").unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn a_copy_from_the_other_computer_forgets_that_computers_unsent_edits() {
        let conn = db::open_in_memory().unwrap();
        enable(&conn, "pc").unwrap();
        conn.execute_batch("UPDATE categories SET colour='chart-9' WHERE name='Dining';").unwrap();
        assert_eq!(outbox_len(&conn), 1);

        adopt(&conn, &syncing("laptop")).unwrap();

        assert_eq!(outbox_len(&conn), 0, "the PC sends its own edits; the laptop must not resend them");
        assert_eq!(get(&conn, "device").unwrap().as_deref(), Some("laptop"));
    }

    #[test]
    fn this_computers_own_unsent_edits_survive_a_restart() {
        let conn = db::open_in_memory().unwrap();
        adopt(&conn, &syncing("pc")).unwrap();
        conn.execute_batch("UPDATE categories SET colour='chart-9' WHERE name='Dining';").unwrap();
        adopt(&conn, &syncing("pc")).unwrap();
        assert_eq!(outbox_len(&conn), 1);
    }

    #[test]
    fn no_folder_means_recording_is_off() {
        let conn = db::open_in_memory().unwrap();
        enable(&conn, "pc").unwrap();
        adopt(&conn, &DeviceSyncSettings::default()).unwrap();
        assert_eq!(get(&conn, "enabled").unwrap().as_deref(), Some("0"));
    }
}
```

Update `src-tauri/src/devicesync/mod.rs`:

```rust
pub mod meta;
pub mod schema;
pub mod settings;
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test devicesync::meta`
Expected: FAIL, panics at "not implemented".

- [ ] **Step 4: Implement**

Replace the four `unimplemented!()` functions in `meta.rs`:

```rust
/// 16 hex characters. SQLite's randomblob, so no extra crate.
pub fn new_device_id(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT lower(hex(randomblob(8)))", [], |r| r.get(0))
}

pub fn enable(conn: &Connection, device_id: &str) -> rusqlite::Result<()> {
    set(conn, "device", device_id)?;
    set(conn, "enabled", "1")
}

pub fn disable(conn: &Connection) -> rusqlite::Result<()> {
    set(conn, "enabled", "0")
}

/// Run at every launch, after the database opens. The settings file, not the
/// database, says who this computer is. A database whose device id differs
/// is a copy from the other computer (just joined), so its outbox holds the
/// other computer's edits, which that computer sends itself, and is emptied.
pub fn adopt(conn: &Connection, settings: &DeviceSyncSettings) -> rusqlite::Result<()> {
    match (&settings.folder, &settings.device_id) {
        (Some(_), Some(id)) => {
            if get(conn, "device")?.as_deref() != Some(id.as_str()) {
                conn.execute("DELETE FROM sync_outbox", [])?;
            }
            set(conn, "applying", "0")?;
            enable(conn, id)
        }
        _ => disable(conn),
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test devicesync::`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/devicesync
git commit -m "feat(devicesync): settings file, device id and adopting a copied database"
```

---

### Task 4: Change files, the clock, and flushing the outbox

**Files:**
- Create: `src-tauri/src/devicesync/files.rs`
- Create: `src-tauri/src/devicesync/clock.rs`
- Create: `src-tauri/src/devicesync/outbox.rs`
- Modify: `src-tauri/src/devicesync/mod.rs`

- [ ] **Step 1: Write `files.rs` with its tests**

```rust
//! The shared folder's layout and the change file format. Every file has one
//! writer and is never changed after it is written, so Google Drive never has
//! to merge two computers' edits to one file.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Bumped only if the file layout itself changes. Schema changes are carried
/// by `ChangeFile::schema` instead.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub tbl: String,
    pub key: String,
    pub field: String,
    /// `null` on `_row` means deleted.
    pub value: serde_json::Value,
    /// Milliseconds since 1970 when the edit was made.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeFile {
    pub format: u32,
    /// The writer's `db::TARGET_VERSION`.
    pub schema: i64,
    pub device: String,
    pub changes: Vec<Change>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    /// Local time, `2026-10-16T09:30:12`.
    pub last_sync: String,
}

pub fn seed_path(folder: &Path) -> PathBuf {
    folder.join("seed.sqlite")
}

fn changes_dir(folder: &Path) -> PathBuf {
    folder.join("changes")
}

fn devices_dir(folder: &Path) -> PathBuf {
    folder.join("devices")
}

/// Write beside `path` under a `.tmp` name, then rename, so no reader (this
/// computer, the other one, or Google Drive's uploader) ever sees half a file.
pub fn write_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    // Windows will not rename onto an existing file.
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).map_err(|e| format!("Couldn't finish writing {}: {e}", path.display()))
}

/// `<device>/<written at, ms>-<last outbox seq>.json`: the path below
/// `changes/`, and the name a file is recorded under once applied.
pub fn file_name(device: &str, written_at: i64, last_seq: i64) -> String {
    format!("{device}/{written_at:013}-{last_seq}.json")
}

pub fn write_change_file(folder: &Path, name: &str, file: &ChangeFile) -> Result<(), String> {
    let json = serde_json::to_vec(file).map_err(|e| e.to_string())?;
    write_atomically(&changes_dir(folder).join(name), &json)
}

/// Every change file written by a computer other than `me`, by recorded
/// name, oldest first. Half-written `.tmp` files are skipped.
pub fn list_others(folder: &Path, me: &str) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(devices) = fs::read_dir(changes_dir(folder)) else { return names };
    for device in devices.filter_map(|d| d.ok()) {
        let Ok(device_name) = device.file_name().into_string() else { continue };
        if device_name == me || !device.path().is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(device.path()) else { continue };
        for f in files.filter_map(|f| f.ok()) {
            if let Ok(n) = f.file_name().into_string() {
                if n.ends_with(".json") {
                    names.push(format!("{device_name}/{n}"));
                }
            }
        }
    }
    names.sort();
    names
}

pub fn read(folder: &Path, name: &str) -> Result<ChangeFile, String> {
    let bytes = fs::read(changes_dir(folder).join(name)).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn write_device(folder: &Path, info: &DeviceInfo) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(info).map_err(|e| e.to_string())?;
    write_atomically(&devices_dir(folder).join(format!("{}.json", info.id)), &json)
}

/// The other computers that have synced through `folder`.
pub fn list_devices(folder: &Path, me: &str) -> Vec<DeviceInfo> {
    let Ok(rd) = fs::read_dir(devices_dir(folder)) else { return vec![] };
    let mut found: Vec<DeviceInfo> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|e| fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice::<DeviceInfo>(&b).ok())
        .filter(|d| d.id != me)
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(device: &str) -> ChangeFile {
        ChangeFile {
            format: FORMAT,
            schema: 9,
            device: device.into(),
            changes: vec![Change {
                tbl: "bank_transactions".into(), key: "sf:A|T".into(), field: "note".into(),
                value: serde_json::json!("lunch"), at: 1_760_000_000_000,
            }],
        }
    }

    #[test]
    fn a_change_file_reads_back_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let name = file_name("pc", 1_760_000_000_000, 7);
        write_change_file(dir.path(), &name, &sample("pc")).unwrap();
        assert_eq!(read(dir.path(), &name).unwrap(), sample("pc"));
    }

    #[test]
    fn listing_skips_this_computers_files_and_half_written_ones() {
        let dir = tempfile::tempdir().unwrap();
        write_change_file(dir.path(), &file_name("pc", 2, 1), &sample("pc")).unwrap();
        write_change_file(dir.path(), &file_name("pc", 1, 1), &sample("pc")).unwrap();
        write_change_file(dir.path(), &file_name("laptop", 1, 1), &sample("laptop")).unwrap();
        fs::write(dir.path().join("changes/pc/0000000000003-1.tmp"), "{").unwrap();

        assert_eq!(
            list_others(dir.path(), "laptop"),
            vec!["pc/0000000000001-1.json".to_string(), "pc/0000000000002-1.json".to_string()]
        );
    }

    #[test]
    fn writing_atomically_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b.json");
        write_atomically(&path, b"{}").unwrap();
        write_atomically(&path, b"{\"x\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"x\":1}");
        assert!(!dir.path().join("a/b.tmp").exists());
    }

    #[test]
    fn the_other_computers_are_listed_but_not_this_one() {
        let dir = tempfile::tempdir().unwrap();
        let pc = DeviceInfo { id: "pc".into(), name: "WILL-PC".into(), last_sync: "2026-10-16T09:00:00".into() };
        let me = DeviceInfo { id: "laptop".into(), name: "WILL-LAPTOP".into(), last_sync: "2026-10-16T09:01:00".into() };
        write_device(dir.path(), &pc).unwrap();
        write_device(dir.path(), &me).unwrap();
        assert_eq!(list_devices(dir.path(), "laptop"), vec![pc]);
    }
}
```

- [ ] **Step 2: Write `clock.rs` with its tests**

```rust
//! Last writer wins, per field. `sync_clock` holds the newest change seen for
//! each (table, key, field), whichever computer made it.
use rusqlite::{params, Connection, OptionalExtension};

/// Is a change made at `at` by `device` newer than anything recorded? Ties
/// go to the larger device id, so both computers reach the same answer.
pub fn is_newer(conn: &Connection, tbl: &str, key: &str, field: &str, at: i64, device: &str) -> rusqlite::Result<bool> {
    let seen: Option<(i64, String)> = conn
        .query_row(
            "SELECT at, device FROM sync_clock WHERE tbl=?1 AND key=?2 AND field=?3",
            params![tbl, key, field],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(match seen {
        None => true,
        Some((seen_at, seen_device)) => (at, device) > (seen_at, seen_device.as_str()),
    })
}

/// Remember a change, unless something newer is already recorded.
pub fn record(conn: &Connection, tbl: &str, key: &str, field: &str, at: i64, device: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_clock (tbl, key, field, at, device) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(tbl, key, field) DO UPDATE SET at=excluded.at, device=excluded.device
         WHERE excluded.at > sync_clock.at
            OR (excluded.at = sync_clock.at AND excluded.device > sync_clock.device)",
        params![tbl, key, field, at, device],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn anything_is_newer_than_nothing() {
        let conn = db::open_in_memory().unwrap();
        assert!(is_newer(&conn, "budgets", "cat:Dining|*", "_row", 5, "pc").unwrap());
    }

    #[test]
    fn an_older_change_is_not_newer_and_does_not_rewind_the_clock() {
        let conn = db::open_in_memory().unwrap();
        record(&conn, "budgets", "k", "_row", 10, "pc").unwrap();
        assert!(!is_newer(&conn, "budgets", "k", "_row", 9, "laptop").unwrap());
        record(&conn, "budgets", "k", "_row", 9, "laptop").unwrap();
        assert!(is_newer(&conn, "budgets", "k", "_row", 11, "laptop").unwrap());
        assert!(!is_newer(&conn, "budgets", "k", "_row", 10, "pc").unwrap());
    }

    #[test]
    fn a_tie_goes_to_the_larger_device_id() {
        let conn = db::open_in_memory().unwrap();
        record(&conn, "budgets", "k", "_row", 10, "aaa").unwrap();
        assert!(is_newer(&conn, "budgets", "k", "_row", 10, "bbb").unwrap());
        assert!(!is_newer(&conn, "budgets", "k", "_row", 10, "000").unwrap());
    }
}
```

- [ ] **Step 3: Write the failing `outbox.rs` tests**

```rust
//! Sending this computer's edits: take the outbox (under the database lock),
//! write it to the shared folder (without the lock), then commit (under the
//! lock again).
use super::clock;
use super::files::Change;
use rusqlite::Connection;

pub struct Taken {
    pub last_seq: i64,
    pub changes: Vec<Change>,
}

pub fn take(_conn: &Connection) -> rusqlite::Result<Option<Taken>> {
    unimplemented!()
}

pub fn commit(_conn: &Connection, _device: &str, _file_name: &str, _taken: &Taken) -> rusqlite::Result<()> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::devicesync::meta;

    fn recording() -> Connection {
        let conn = db::open_in_memory().unwrap();
        meta::enable(&conn, "pc").unwrap();
        conn
    }

    #[test]
    fn an_empty_outbox_takes_nothing() {
        assert!(take(&recording()).unwrap().is_none());
    }

    #[test]
    fn edits_are_taken_oldest_first_with_their_json_values() {
        let conn = recording();
        conn.execute_batch(
            "UPDATE categories SET colour='chart-9' WHERE name='Dining';
             UPDATE categories SET sort=1 WHERE name='Dining';",
        )
        .unwrap();
        let taken = take(&conn).unwrap().unwrap();
        assert_eq!(taken.changes.len(), 2);
        assert_eq!(taken.changes[0].field, "colour");
        assert_eq!(taken.changes[0].value, serde_json::json!("chart-9"));
        assert_eq!(taken.changes[1].value, serde_json::json!(1));
    }

    #[test]
    fn committing_empties_only_what_was_taken_and_records_the_clock_and_file() {
        let conn = recording();
        conn.execute_batch("UPDATE categories SET colour='chart-9' WHERE name='Dining';").unwrap();
        let taken = take(&conn).unwrap().unwrap();
        // An edit made while the file was being written.
        conn.execute_batch("UPDATE categories SET sort=1 WHERE name='Dining';").unwrap();

        commit(&conn, "pc", "pc/0000000000001-1.json", &taken).unwrap();

        let left: i64 = conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1);
        let applied: i64 = conn
            .query_row("SELECT count(*) FROM sync_files_applied WHERE name='pc/0000000000001-1.json'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(applied, 1);
        let c = &taken.changes[0];
        assert!(!clock::is_newer(&conn, &c.tbl, &c.key, &c.field, c.at, "pc").unwrap());
    }
}
```

Update `src-tauri/src/devicesync/mod.rs`:

```rust
pub mod clock;
pub mod files;
pub mod meta;
pub mod outbox;
pub mod schema;
pub mod settings;
```

- [ ] **Step 4: Run the tests to verify the outbox ones fail**

Run: `cargo test devicesync::`
Expected: `files` and `clock` tests PASS. The `outbox` tests panic at "not implemented".

- [ ] **Step 5: Implement `take` and `commit`**

```rust
/// Everything waiting to be sent, oldest first. `None` when there is nothing.
pub fn take(conn: &Connection) -> rusqlite::Result<Option<Taken>> {
    let mut stmt = conn.prepare("SELECT seq, tbl, key, field, value, at FROM sync_outbox ORDER BY seq")?;
    let rows = stmt.query_map([], |r| {
        let value: Option<String> = r.get(4)?;
        Ok((
            r.get::<_, i64>(0)?,
            Change {
                tbl: r.get(1)?,
                key: r.get(2)?,
                field: r.get(3)?,
                value: value
                    .and_then(|v| serde_json::from_str(&v).ok())
                    .unwrap_or(serde_json::Value::Null),
                at: r.get(5)?,
            },
        ))
    })?;
    let mut last_seq = 0;
    let mut changes = Vec::new();
    for row in rows {
        let (seq, change) = row?;
        last_seq = seq;
        changes.push(change);
    }
    Ok(if changes.is_empty() { None } else { Some(Taken { last_seq, changes }) })
}

/// The file is safely written: remember these edits in the clock (so an older
/// edit from the other computer cannot overwrite them), record the file as
/// applied (so a copy of this database, the seed, knows it already has
/// them), and drop what was sent. Rows added since `take` stay for next time.
pub fn commit(conn: &Connection, device: &str, file_name: &str, taken: &Taken) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for c in &taken.changes {
        clock::record(&tx, &c.tbl, &c.key, &c.field, c.at, device)?;
    }
    tx.execute("INSERT OR IGNORE INTO sync_files_applied (name) VALUES (?1)", [file_name])?;
    tx.execute("DELETE FROM sync_outbox WHERE seq <= ?1", [taken.last_seq])?;
    tx.commit()
}
```

- [ ] **Step 6: Run the tests**

Run: `cargo test devicesync::`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/devicesync
git commit -m "feat(devicesync): change files, last-writer-wins clock and sending the outbox"
```

---

### Task 5: Applying one change

**Files:**
- Create: `src-tauri/src/devicesync/apply.rs`
- Modify: `src-tauri/src/devicesync/mod.rs` (add `pub mod apply;`)

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/devicesync/apply.rs`:

```rust
//! Applying one change from the other computer. Rows are found by key, never
//! by local id. Runs inside `pull::apply_all`, which silences the triggers.
use super::clock;
use super::files::Change;
use rusqlite::types::Value as Sql;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    /// Something newer for this field is already here.
    Stale,
    /// The row it is about is not on this computer yet, usually a bank
    /// transaction this computer's SimpleFIN sync has not fetched. Kept and
    /// retried.
    Waiting,
}

pub fn apply(_conn: &Connection, _device: &str, _c: &Change) -> rusqlite::Result<Outcome> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::devicesync::meta;
    use serde_json::json;

    /// A database as `pull` leaves it while applying: recording on, but silenced.
    fn applying() -> Connection {
        let conn = db::open_in_memory().unwrap();
        meta::enable(&conn, "laptop").unwrap();
        meta::set(&conn, "applying", "1").unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'TRN-1','2026-10-01',-5,'Coffee');",
        )
        .unwrap();
        conn
    }

    fn change(tbl: &str, key: &str, field: &str, value: Value, at: i64) -> Change {
        Change { tbl: tbl.into(), key: key.into(), field: field.into(), value, at }
    }

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_category_chosen_on_the_other_computer_lands_on_the_same_bank_row() {
        let conn = applying();
        let c = change("bank_transactions", "sf:ACT-1|TRN-1", "category", json!(["cat:Dining", "manual"]), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        let (name, source): (String, String) = conn
            .query_row(
                "SELECT c.name, b.category_source FROM bank_transactions b JOIN categories c ON c.id=b.category_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((name.as_str(), source.as_str()), ("Dining", "manual"));
        assert_eq!(conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get::<_, i64>(0)).unwrap(), 0,
            "applied changes are not echoed back");
    }

    #[test]
    fn an_older_change_does_not_overwrite_a_newer_one() {
        let conn = applying();
        apply(&conn, "pc", &change("bank_transactions", "sf:ACT-1|TRN-1", "note", json!("new"), 20)).unwrap();
        let older = change("bank_transactions", "sf:ACT-1|TRN-1", "note", json!("old"), 10);
        assert_eq!(apply(&conn, "pc", &older).unwrap(), Outcome::Stale);
        assert_eq!(one::<String>(&conn, "SELECT note FROM bank_transactions"), "new");
    }

    #[test]
    fn a_change_for_a_transaction_not_fetched_here_yet_waits() {
        let conn = applying();
        let c = change("bank_transactions", "sf:ACT-1|TRN-2", "reviewed", json!(1), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Waiting);
    }

    #[test]
    fn a_manual_account_is_created_with_its_key_then_deleted() {
        let conn = applying();
        let row = json!({"name":"Cash jar","type":"cash","institution":null,"currency":"USD","created_at":"2026-01-01","hidden":0});
        apply(&conn, "pc", &change("accounts", "acct:abc", "_row", row, 10)).unwrap();
        assert_eq!(one::<String>(&conn, "SELECT name FROM accounts WHERE sync_key='acct:abc'"), "Cash jar");
        apply(&conn, "pc", &change("accounts", "acct:abc", "_row", Value::Null, 11)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM accounts WHERE sync_key='acct:abc'"), 0);
    }

    #[test]
    fn hiding_an_account_reaches_the_same_simplefin_account() {
        let conn = applying();
        apply(&conn, "pc", &change("accounts", "sf:ACT-1", "hidden", json!(1), 10)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT hidden FROM accounts WHERE id=1"), 1);
    }

    #[test]
    fn a_budget_is_set_changed_and_cleared() {
        let conn = applying();
        apply(&conn, "pc", &change("budgets", "cat:Groceries|2026-10", "_row", json!({"limit_amount": 400.0}), 10)).unwrap();
        apply(&conn, "pc", &change("budgets", "cat:Groceries|2026-10", "limit_amount", json!(450.0), 11)).unwrap();
        assert_eq!(one::<f64>(&conn, "SELECT limit_amount FROM budgets WHERE month='2026-10'"), 450.0);
        apply(&conn, "pc", &change("budgets", "cat:Groceries|2026-10", "_row", Value::Null, 12)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM budgets"), 0);
    }

    #[test]
    fn an_every_month_budget_is_stored_with_no_month() {
        let conn = applying();
        apply(&conn, "pc", &change("budgets", "cat:Groceries|*", "_row", json!({"limit_amount": 400.0}), 10)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM budgets WHERE month IS NULL"), 1);
    }

    #[test]
    fn a_rule_is_created_against_the_right_category() {
        let conn = applying();
        let row = json!({"match_type":"payee","pattern":"blue bottle","category":"cat:Dining","created_at":"2026-10-16"});
        apply(&conn, "pc", &change("category_rules", "payee:blue bottle", "_row", row, 10)).unwrap();
        assert_eq!(
            one::<String>(&conn, "SELECT c.name FROM category_rules r JOIN categories c ON c.id=r.category_id"),
            "Dining"
        );
    }

    #[test]
    fn a_new_category_is_created_and_a_namesake_here_is_merged_not_duplicated() {
        let conn = applying();
        let golf = json!({"name":"Golf","kind":"spending","colour":"chart-3","sort":200,"is_builtin":0});
        apply(&conn, "pc", &change("categories", "cat:Golf", "_row", golf, 10)).unwrap();
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM categories WHERE name='Golf'"), "cat:Golf");

        // Both computers once created "Dining" on their own, under different keys.
        let dining = json!({"name":"Dining","kind":"spending","colour":"chart-2","sort":20,"is_builtin":1});
        apply(&conn, "pc", &change("categories", "cat:Dining:ab12cd34", "_row", dining, 11)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM categories WHERE name='Dining'"), 1);
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM categories WHERE name='Dining'"), "cat:Dining:ab12cd34");
    }

    #[test]
    fn a_copilot_history_row_takes_over_the_bank_copy_already_here() {
        let conn = applying();
        // TRN-1 is -5 on 2026-10-01. The PC holds it as an imported Copilot row.
        let row = json!({"account":"sf:ACT-1","external_id":"copilot:00ff","posted":"2026-10-02","amount":-5.0,
            "description":"Coffee","payee":"Coffee","memo":null,"category":"cat:Dining","category_source":"manual",
            "reviewed":1,"note":"with Sam","removed":0});
        apply(&conn, "pc", &change("bank_transactions", "sf:ACT-1|copilot:00ff", "_row", row, 10)).unwrap();

        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 1, "no duplicate");
        let (key, note): (String, String) = conn
            .query_row("SELECT sync_key, note FROM bank_transactions", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((key.as_str(), note.as_str()), ("sf:ACT-1|copilot:00ff", "with Sam"));
    }

    #[test]
    fn a_copilot_history_row_with_no_twin_is_added() {
        let conn = applying();
        let row = json!({"account":"sf:ACT-1","external_id":"copilot:0aaa","posted":"2023-01-02","amount":-80.0,
            "description":"Golf","payee":"Golf","memo":null,"category":null,"category_source":"manual",
            "reviewed":1,"note":null,"removed":0});
        apply(&conn, "pc", &change("bank_transactions", "sf:ACT-1|copilot:0aaa", "_row", row, 10)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 2);
    }

    #[test]
    fn an_investment_transaction_brings_its_security_along() {
        let conn = applying();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,sync_key) VALUES ('Brokerage','brokerage','USD','2026-01-01','acct:b');",
        )
        .unwrap();
        let row = json!({"account":"acct:b","security":{"ticker":"VTI","name":"Vanguard Total","type":"etf","currency":"USD"},
            "type":"buy","date":"2026-10-01","quantity":2.0,"price":250.0,"amount":500.0,"fees":0.0,"note":null});
        apply(&conn, "pc", &change("transactions", "txn:1", "_row", row, 10)).unwrap();
        assert_eq!(
            one::<String>(&conn, "SELECT s.ticker FROM transactions t JOIN securities s ON s.id=t.security_id"),
            "VTI"
        );
    }
}
```

Add `pub mod apply;` to `mod.rs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test devicesync::apply`
Expected: FAIL, panics at "not implemented".

- [ ] **Step 3: Implement**

Replace the `apply` stub with:

```rust
pub fn apply(conn: &Connection, device: &str, c: &Change) -> rusqlite::Result<Outcome> {
    if !clock::is_newer(conn, &c.tbl, &c.key, &c.field, c.at, device)? {
        return Ok(Outcome::Stale);
    }
    let landed = match c.tbl.as_str() {
        "accounts" => accounts(conn, c)?,
        "categories" => categories(conn, c)?,
        "bank_transactions" => bank_transactions(conn, c)?,
        "category_rules" => rules(conn, c)?,
        "budgets" => budgets(conn, c)?,
        "transactions" => transactions(conn, c)?,
        // A table this build does not know. Files from a newer schema are set
        // aside before reaching here, so this is only ever a retired table.
        _ => true,
    };
    if !landed {
        return Ok(Outcome::Waiting);
    }
    clock::record(conn, &c.tbl, &c.key, &c.field, c.at, device)?;
    Ok(Outcome::Applied)
}

/// A JSON scalar as an SQL value.
fn sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => Sql::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn field(v: &Value, name: &str) -> Sql {
    sql(v.get(name).unwrap_or(&Value::Null))
}

fn id_by_key(conn: &Connection, table: &str, key: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(&format!("SELECT id FROM {table} WHERE sync_key=?1"), [key], |r| r.get(0))
        .optional()
}

/// A category reference: `Ok(Some(None))` for none, `Ok(None)` when the
/// category has not reached this computer yet.
fn category_ref(conn: &Connection, v: Option<&Value>) -> rusqlite::Result<Option<Option<i64>>> {
    match v.and_then(Value::as_str) {
        None => Ok(Some(None)),
        Some(key) => Ok(id_by_key(conn, "categories", key)?.map(Some)),
    }
}

fn accounts(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            conn.execute("DELETE FROM accounts WHERE sync_key=?1 AND source='manual'", [&c.key])?;
            Ok(true)
        }
        "_row" => {
            if id_by_key(conn, "accounts", &c.key)?.is_none() {
                let v = &c.value;
                conn.execute(
                    "INSERT INTO accounts (name, type, institution, currency, created_at, hidden, source, sync_key)
                     VALUES (?1, ?2, ?3, coalesce(?4, 'USD'), ?5, coalesce(?6, 0), 'manual', ?7)",
                    params![field(v, "name"), field(v, "type"), field(v, "institution"), field(v, "currency"),
                            field(v, "created_at"), field(v, "hidden"), c.key],
                )?;
            }
            Ok(true)
        }
        name @ ("type" | "hidden" | "name" | "institution" | "currency") => {
            let n = conn.execute(&format!("UPDATE accounts SET {name}=?1 WHERE sync_key=?2"), params![sql(&c.value), c.key])?;
            Ok(n > 0)
        }
        _ => Ok(true),
    }
}

fn categories(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            conn.execute("DELETE FROM categories WHERE sync_key=?1", [&c.key])?;
            Ok(true)
        }
        "_row" => {
            if id_by_key(conn, "categories", &c.key)?.is_some() {
                return Ok(true);
            }
            let v = &c.value;
            // Both computers made a category with this name before sync: one
            // category, under the key the other computer uses.
            let merged = conn.execute("UPDATE categories SET sync_key=?1 WHERE name=?2", params![c.key, field(v, "name")])?;
            if merged == 0 {
                conn.execute(
                    "INSERT INTO categories (name, kind, colour, sort, is_builtin, sync_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![field(v, "name"), field(v, "kind"), field(v, "colour"), field(v, "sort"),
                            field(v, "is_builtin"), c.key],
                )?;
            }
            Ok(true)
        }
        name @ ("name" | "colour" | "sort") => {
            let n = conn.execute(&format!("UPDATE categories SET {name}=?1 WHERE sync_key=?2"), params![sql(&c.value), c.key])?;
            Ok(n > 0)
        }
        _ => Ok(true),
    }
}

fn bank_transactions(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            conn.execute("DELETE FROM bank_transactions WHERE sync_key=?1", [&c.key])?;
            Ok(true)
        }
        "_row" => insert_bank_row(conn, c),
        "category" => {
            let pair = c.value.as_array();
            let source = pair.and_then(|p| p.get(1)).and_then(Value::as_str).unwrap_or("manual");
            if source == "auto" {
                // Back to automatic: this computer's own re-sort, which runs at
                // the end of the pull, picks the category.
                let n = conn.execute("UPDATE bank_transactions SET category_source='auto' WHERE sync_key=?1", [&c.key])?;
                return Ok(n > 0);
            }
            let Some(category) = category_ref(conn, pair.and_then(|p| p.first()))? else { return Ok(false) };
            let n = conn.execute(
                "UPDATE bank_transactions SET category_id=?1, category_source='manual' WHERE sync_key=?2",
                params![category, c.key],
            )?;
            Ok(n > 0)
        }
        name @ ("note" | "reviewed" | "removed") => {
            let n = conn.execute(
                &format!("UPDATE bank_transactions SET {name}=?1 WHERE sync_key=?2"),
                params![sql(&c.value), c.key],
            )?;
            Ok(n > 0)
        }
        _ => Ok(true),
    }
}

/// A row SimpleFIN cannot supply here: a manual account's, or Copilot history.
fn insert_bank_row(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    if id_by_key(conn, "bank_transactions", &c.key)?.is_some() {
        return Ok(true);
    }
    let v = &c.value;
    let Some(account_id) = v.get("account").and_then(Value::as_str).map(|k| id_by_key(conn, "accounts", k)).transpose()?.flatten()
    else { return Ok(false) };
    let Some(category) = category_ref(conn, v.get("category"))? else { return Ok(false) };
    let external_id = v.get("external_id").and_then(Value::as_str).unwrap_or_default();

    if external_id.starts_with("copilot:") {
        // This computer may already hold the bank's own copy of the purchase:
        // its sync had nothing to adopt because the Copilot row had not
        // arrived yet. Take that row over rather than adding a duplicate, with
        // the same match the sync uses to adopt.
        let twin: Option<i64> = conn
            .query_row(
                "SELECT id FROM bank_transactions
                 WHERE account_id=?1 AND external_id NOT LIKE 'copilot:%'
                   AND sync_key NOT LIKE '%|copilot:%'
                   AND CAST(ROUND(amount*100) AS INTEGER) = CAST(ROUND(?2*100) AS INTEGER)
                   AND ABS(julianday(posted) - julianday(?3)) <= 3
                 ORDER BY ABS(julianday(posted) - julianday(?3)) LIMIT 1",
                params![account_id, field(v, "amount"), field(v, "posted")],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = twin {
            conn.execute(
                "UPDATE bank_transactions SET sync_key=?1, category_id=?2, category_source=?3,
                   reviewed=?4, note=?5, removed=?6 WHERE id=?7",
                params![c.key, category, field(v, "category_source"), field(v, "reviewed"),
                        field(v, "note"), field(v, "removed"), id],
            )?;
            return Ok(true);
        }
    }
    conn.execute(
        "INSERT INTO bank_transactions
           (account_id, external_id, posted, amount, description, payee, memo,
            category_id, category_source, reviewed, note, removed, sync_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, coalesce(?9, 'manual'), coalesce(?10, 0), ?11, coalesce(?12, 0), ?13)",
        params![account_id, external_id, field(v, "posted"), field(v, "amount"), field(v, "description"),
                field(v, "payee"), field(v, "memo"), category, field(v, "category_source"),
                field(v, "reviewed"), field(v, "note"), field(v, "removed"), c.key],
    )?;
    Ok(true)
}

fn rules(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    let Some((match_type, pattern)) = c.key.split_once(':') else { return Ok(true) };
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            conn.execute("DELETE FROM category_rules WHERE match_type=?1 AND pattern=?2", params![match_type, pattern])?;
            Ok(true)
        }
        "_row" | "category" => {
            let reference = if c.field == "_row" { c.value.get("category") } else { Some(&c.value) };
            let Some(category) = category_ref(conn, reference)? else { return Ok(false) };
            let Some(category_id) = category else { return Ok(true) }; // a rule needs a category
            let created_at = c.value.get("created_at").and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            conn.execute(
                "INSERT INTO category_rules (match_type, pattern, category_id, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(match_type, pattern) DO UPDATE SET category_id=excluded.category_id",
                params![match_type, pattern, category_id, created_at],
            )?;
            Ok(true)
        }
        _ => Ok(true),
    }
}

fn budgets(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    let Some((category_key, month)) = c.key.rsplit_once('|') else { return Ok(true) };
    let month = if month == "*" { None } else { Some(month) };
    let Some(category_id) = id_by_key(conn, "categories", category_key)? else { return Ok(false) };
    if c.field == "_row" && c.value.is_null() {
        conn.execute("DELETE FROM budgets WHERE category_id=?1 AND month IS ?2", params![category_id, month])?;
        return Ok(true);
    }
    let amount = if c.field == "_row" { c.value.get("limit_amount") } else { Some(&c.value) };
    let Some(amount) = amount.and_then(Value::as_f64) else { return Ok(true) };
    // NULL months are distinct to a UNIQUE index, so no ON CONFLICT: update,
    // else insert, as `budget_set` does.
    let n = conn.execute(
        "UPDATE budgets SET limit_amount=?1 WHERE category_id=?2 AND month IS ?3",
        params![amount, category_id, month],
    )?;
    if n == 0 {
        conn.execute(
            "INSERT INTO budgets (category_id, month, limit_amount) VALUES (?1, ?2, ?3)",
            params![category_id, month, amount],
        )?;
    }
    Ok(true)
}

fn transactions(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    if c.field != "_row" {
        return Ok(true);
    }
    if c.value.is_null() {
        conn.execute("DELETE FROM transactions WHERE sync_key=?1", [&c.key])?;
        return Ok(true);
    }
    if id_by_key(conn, "transactions", &c.key)?.is_some() {
        return Ok(true);
    }
    let v = &c.value;
    let Some(account_id) = v.get("account").and_then(Value::as_str).map(|k| id_by_key(conn, "accounts", k)).transpose()?.flatten()
    else { return Ok(false) };
    let security_id: Option<i64> = match v.get("security").filter(|s| !s.is_null()) {
        None => None,
        Some(s) => {
            conn.execute(
                "INSERT INTO securities (ticker, name, type, currency) VALUES (?1, ?2, ?3, coalesce(?4, 'USD'))
                 ON CONFLICT(ticker) DO NOTHING",
                params![field(s, "ticker"), field(s, "name"), field(s, "type"), field(s, "currency")],
            )?;
            Some(conn.query_row("SELECT id FROM securities WHERE ticker=?1", [field(s, "ticker")], |r| r.get(0))?)
        }
    };
    conn.execute(
        "INSERT INTO transactions (account_id, security_id, type, date, quantity, price, amount, fees, note, sync_key)
         VALUES (?1, ?2, ?3, ?4, coalesce(?5, 0), coalesce(?6, 0), coalesce(?7, 0), coalesce(?8, 0), ?9, ?10)",
        params![account_id, security_id, field(v, "type"), field(v, "date"), field(v, "quantity"),
                field(v, "price"), field(v, "amount"), field(v, "fees"), field(v, "note"), c.key],
    )?;
    Ok(true)
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test devicesync::apply`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/devicesync
git commit -m "feat(devicesync): apply the other computer's changes by key, newest wins"
```

---

### Task 6: Pulling: fetch files, apply them, retry what waits

**Files:**
- Create: `src-tauri/src/devicesync/pull.rs`
- Modify: `src-tauri/src/devicesync/mod.rs` (add `pub mod pull;`)

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/devicesync/pull.rs`:

```rust
//! Taking the other computer's edits: note which files are applied (lock),
//! read the new ones (no lock: Google Drive may download them first), then
//! apply them in one transaction (lock).
use super::apply::{self, Outcome};
use super::files::{self, Change, ChangeFile, FORMAT};
use super::meta;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// A waiting change older than this is dropped: its row will not come.
pub const PENDING_DAYS: i64 = 60;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PullReport {
    pub applied: usize,
    /// Changes still waiting for their row, after this pull.
    pub waiting: usize,
    /// Changes that would not apply (a constraint failed).
    pub skipped: usize,
    /// Files from a newer Ledgerly, left for after an update.
    pub newer_files: usize,
}

pub struct Fetched {
    pub name: String,
    pub file: ChangeFile,
}

pub fn applied_names(_conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    unimplemented!()
}

pub fn fetch(_folder: &Path, _me: &str, _applied: &HashSet<String>) -> Vec<Fetched> {
    unimplemented!()
}

pub fn apply_all(_conn: &Connection, _fetched: &[Fetched], _schema: i64, _now_ms: i64) -> rusqlite::Result<PullReport> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use serde_json::json;

    const DAY: i64 = 86_400_000;

    fn laptop() -> Connection {
        let conn = db::open_in_memory().unwrap();
        meta::enable(&conn, "laptop").unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee)
               VALUES (1,'TRN-1','2026-10-01',-5,'BLUE BOTTLE #12','Blue Bottle');",
        )
        .unwrap();
        conn
    }

    fn file(name: &str, schema: i64, changes: Vec<Change>) -> Fetched {
        Fetched { name: name.into(), file: ChangeFile { format: FORMAT, schema, device: "pc".into(), changes } }
    }

    fn note(key: &str, text: &str, at: i64) -> Change {
        Change { tbl: "bank_transactions".into(), key: key.into(), field: "note".into(), value: json!(text), at }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_file_is_applied_once_and_remembered() {
        let conn = laptop();
        let f = file("pc/1-1.json", 9, vec![note("sf:ACT-1|TRN-1", "lunch", 10)]);
        let report = apply_all(&conn, std::slice::from_ref(&f), 9, 100).unwrap();
        assert_eq!(report.applied, 1);
        assert!(applied_names(&conn).unwrap().contains("pc/1-1.json"));
        assert_eq!(count(&conn, "SELECT count(*) FROM sync_outbox"), 0, "nothing echoed back");
        assert_eq!(meta::get(&conn, "applying").unwrap().as_deref(), Some("0"));
    }

    #[test]
    fn a_change_waits_for_its_transaction_and_lands_once_simplefin_brings_it() {
        let conn = laptop();
        let f = file("pc/1-1.json", 9, vec![note("sf:ACT-1|TRN-2", "dinner", 10)]);
        let report = apply_all(&conn, &[f], 9, 100).unwrap();
        assert_eq!(report.waiting, 1);

        // This computer's next SimpleFIN sync fetches TRN-2.
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description) VALUES (1,'TRN-2','2026-10-02',-30,'Dinner');",
        )
        .unwrap();
        let report = apply_all(&conn, &[], 9, 200).unwrap();
        assert_eq!((report.applied, report.waiting), (1, 0));
        assert_eq!(
            conn.query_row("SELECT note FROM bank_transactions WHERE external_id='TRN-2'", [], |r| r.get::<_, String>(0)).unwrap(),
            "dinner"
        );
    }

    #[test]
    fn a_change_that_never_finds_its_row_is_dropped_after_sixty_days() {
        let conn = laptop();
        apply_all(&conn, &[file("pc/1-1.json", 9, vec![note("sf:GONE|X", "x", 10)])], 9, 100).unwrap();
        let report = apply_all(&conn, &[], 9, 10 + (PENDING_DAYS + 1) * DAY).unwrap();
        assert_eq!(report.waiting, 0);
    }

    #[test]
    fn a_file_from_a_newer_ledgerly_is_left_for_later() {
        let conn = laptop();
        let report = apply_all(&conn, &[file("pc/1-1.json", 99, vec![note("sf:ACT-1|TRN-1", "x", 10)])], 9, 100).unwrap();
        assert_eq!((report.applied, report.newer_files), (0, 1));
        assert!(!applied_names(&conn).unwrap().contains("pc/1-1.json"));
    }

    #[test]
    fn a_new_rule_re_sorts_automatic_rows() {
        let conn = laptop();
        let rule = Change {
            tbl: "category_rules".into(), key: "payee:blue bottle".into(), field: "_row".into(),
            value: json!({"match_type":"payee","pattern":"blue bottle","category":"cat:Fees","created_at":"2026-10-16"}),
            at: 10,
        };
        apply_all(&conn, &[file("pc/1-1.json", 9, vec![rule])], 9, 100).unwrap();
        let name: String = conn
            .query_row("SELECT c.name FROM bank_transactions b JOIN categories c ON c.id=b.category_id", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Fees");
    }

    #[test]
    fn fetching_reads_new_files_and_skips_applied_and_unreadable_ones() {
        let dir = tempfile::tempdir().unwrap();
        let cf = ChangeFile { format: FORMAT, schema: 9, device: "pc".into(), changes: vec![] };
        files::write_change_file(dir.path(), "pc/0000000000001-1.json", &cf).unwrap();
        files::write_change_file(dir.path(), "pc/0000000000002-2.json", &cf).unwrap();
        std::fs::write(dir.path().join("changes/pc/0000000000003-3.json"), "{\"format\":").unwrap();

        let applied: HashSet<String> = ["pc/0000000000001-1.json".to_string()].into();
        let got = fetch(dir.path(), "laptop", &applied);
        assert_eq!(got.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["pc/0000000000002-2.json"]);
    }
}
```

> The rule test relies on payee rules (rung 2 of `categorize::decide`) beating the built-in merchant list. They do.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test devicesync::pull`
Expected: FAIL, panics at "not implemented".

- [ ] **Step 3: Implement**

Replace the three stubs:

```rust
pub fn applied_names(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT name FROM sync_files_applied")?;
    let names = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(names)
}

/// The other computer's files not yet applied. A file that does not parse is
/// most likely still arriving through Google Drive. It is left for the next round.
pub fn fetch(folder: &Path, me: &str, applied: &HashSet<String>) -> Vec<Fetched> {
    files::list_others(folder, me)
        .into_iter()
        .filter(|name| !applied.contains(name))
        .filter_map(|name| files::read(folder, &name).ok().map(|file| Fetched { name, file }))
        .collect()
}

/// Does applying this change call for re-sorting automatic rows?
fn affects_sorting(c: &Change) -> bool {
    matches!(c.tbl.as_str(), "category_rules" | "categories") || (c.tbl == "bank_transactions" && c.field == "category")
}

fn read_pending(conn: &Connection) -> rusqlite::Result<Vec<(i64, String, Change)>> {
    let mut stmt = conn.prepare("SELECT id, device, tbl, key, field, value, at FROM sync_pending ORDER BY at, id")?;
    let rows = stmt.query_map([], |r| {
        let value: Option<String> = r.get(5)?;
        Ok((
            r.get(0)?,
            r.get(1)?,
            Change {
                tbl: r.get(2)?,
                key: r.get(3)?,
                field: r.get(4)?,
                value: value.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(serde_json::Value::Null),
                at: r.get(6)?,
            },
        ))
    })?;
    rows.collect()
}

/// One transaction, with the triggers silenced: retry waiting changes, apply
/// the new files' changes oldest first, record the files, and re-sort
/// automatic rows if a rule or category changed.
pub fn apply_all(conn: &Connection, fetched: &[Fetched], schema: i64, now_ms: i64) -> rusqlite::Result<PullReport> {
    let tx = conn.unchecked_transaction()?;
    meta::set(&tx, "applying", "1")?;
    let mut report = PullReport::default();
    let mut resort = false;

    for (id, device, c) in read_pending(&tx)? {
        let expired = now_ms - c.at > PENDING_DAYS * 86_400_000;
        match apply::apply(&tx, &device, &c) {
            Ok(Outcome::Waiting) if !expired => continue,
            Ok(Outcome::Applied) => {
                report.applied += 1;
                resort |= affects_sorting(&c);
            }
            Ok(_) => {}
            Err(_) => report.skipped += 1,
        }
        tx.execute("DELETE FROM sync_pending WHERE id=?1", [id])?;
    }

    let mut usable: Vec<&Fetched> = Vec::new();
    for f in fetched {
        if f.file.schema > schema || f.file.format > FORMAT {
            report.newer_files += 1;
        } else {
            usable.push(f);
        }
    }
    let mut changes: Vec<(&str, &Change)> = usable
        .iter()
        .flat_map(|f| f.file.changes.iter().map(move |c| (f.file.device.as_str(), c)))
        .collect();
    changes.sort_by(|a, b| (a.1.at, a.0).cmp(&(b.1.at, b.0)));

    for (device, c) in changes {
        match apply::apply(&tx, device, c) {
            Ok(Outcome::Applied) => {
                report.applied += 1;
                resort |= affects_sorting(c);
            }
            Ok(Outcome::Waiting) => {
                tx.execute(
                    "INSERT INTO sync_pending (device, tbl, key, field, value, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![device, c.tbl, c.key, c.field, c.value.to_string(), c.at],
                )?;
            }
            Ok(Outcome::Stale) => {}
            Err(_) => report.skipped += 1,
        }
    }
    for f in &usable {
        tx.execute("INSERT OR IGNORE INTO sync_files_applied (name) VALUES (?1)", [&f.name])?;
    }
    if resort {
        crate::budget::store::recategorise_all(&tx)?;
    }
    report.waiting = tx.query_row("SELECT count(*) FROM sync_pending", [], |r| r.get::<_, i64>(0))? as usize;
    meta::set(&tx, "applying", "0")?;
    tx.commit()?;
    Ok(report)
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test devicesync::pull`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/devicesync
git commit -m "feat(devicesync): pull the other computer's files and retry waiting changes"
```

---

### Task 7: Pairing: start with this computer, join, stop

**Files:**
- Create: `src-tauri/src/devicesync/pair.rs`
- Modify: `src-tauri/src/devicesync/mod.rs` (add `pub mod pair;`)

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/devicesync/pair.rs`:

```rust
//! Pairing two computers. The first writes a copy of its database to the
//! folder; the second joins by restoring that copy, through the backup
//! module's restore (so its own data is backed up first and the swap happens
//! at the restart, when Windows lets go of the file).
use super::settings::{self, DeviceSyncSettings};
use super::{files, meta};
use crate::backup::{restore, Attempt, Paths};
use chrono::NaiveDateTime;
use rusqlite::Connection;
use std::path::Path;

pub fn start_first(_conn: &Connection, _app_dir: &Path, _folder: &Path) -> Result<DeviceSyncSettings, String> {
    unimplemented!()
}

pub fn join(_conn: &Connection, _paths: &Paths, _folder: &Path, _at: NaiveDateTime) -> Result<Attempt, String> {
    unimplemented!()
}

pub fn stop(_conn: &Connection, _app_dir: &Path) -> Result<(), String> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{self, test_at};
    use crate::db;

    struct Computer {
        _dir: tempfile::TempDir,
        paths: Paths,
        conn: Connection,
    }

    fn computer() -> Computer {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        let conn = db::open(&paths.db()).unwrap();
        Computer { _dir: dir, paths, conn }
    }

    #[test]
    fn the_first_computer_leaves_a_copy_in_the_folder_and_starts_recording() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        let s = start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();

        assert!(files::seed_path(drive.path()).exists());
        assert!(restore::validate(&files::seed_path(drive.path())).is_ok());
        assert_eq!(meta::get(&pc.conn, "enabled").unwrap().as_deref(), Some("1"));
        assert_eq!(settings::load(&settings::path(&pc.paths.app_dir)), s);
    }

    #[test]
    fn a_folder_another_computer_started_is_not_started_again() {
        let pc = computer();
        let laptop = computer();
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        let err = start_first(&laptop.conn, &laptop.paths.app_dir, drive.path()).unwrap_err();
        assert!(err.contains("Join"), "{err}");
    }

    #[test]
    fn joining_an_empty_folder_explains_what_to_do_first() {
        let laptop = computer();
        let drive = tempfile::tempdir().unwrap();
        let err = join(&laptop.conn, &laptop.paths, drive.path(), test_at("2026-10-16 09:00:00")).unwrap_err();
        assert!(err.contains("other computer first"), "{err}");
    }

    #[test]
    fn after_joining_and_restarting_the_laptop_has_the_pcs_data_under_its_own_id() {
        let pc = computer();
        pc.conn.execute_batch("INSERT INTO accounts (name,type,currency,created_at) VALUES ('Cash jar','cash','USD','2026-01-01');").unwrap();
        let drive = tempfile::tempdir().unwrap();
        let pc_settings = start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();

        let laptop = computer();
        join(&laptop.conn, &laptop.paths, drive.path(), test_at("2026-10-16 09:00:00")).unwrap();
        let Computer { _dir, paths, conn } = laptop;
        drop(conn); // the restart lets go of the file
        backup::startup::run(&paths, test_at("2026-10-16 09:00:05"));
        let conn = db::open(&paths.db()).unwrap();
        let laptop_settings = settings::load(&settings::path(&paths.app_dir));
        meta::adopt(&conn, &laptop_settings).unwrap();

        let jar: i64 = conn.query_row("SELECT count(*) FROM accounts WHERE name='Cash jar'", [], |r| r.get(0)).unwrap();
        assert_eq!(jar, 1);
        assert_ne!(laptop_settings.device_id, pc_settings.device_id);
        assert_eq!(meta::get(&conn, "device").unwrap(), laptop_settings.device_id);
    }

    #[test]
    fn stopping_turns_recording_off_and_forgets_the_folder() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        stop(&pc.conn, &pc.paths.app_dir).unwrap();
        assert_eq!(meta::get(&pc.conn, "enabled").unwrap().as_deref(), Some("0"));
        assert_eq!(settings::load(&settings::path(&pc.paths.app_dir)).folder, None);
        assert!(files::seed_path(drive.path()).exists(), "the shared folder is left alone");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test devicesync::pair`
Expected: FAIL, panics at "not implemented".

- [ ] **Step 3: Implement**

```rust
/// Make this computer the first: start recording, put a copy of this database
/// in `folder` for the other computer to join from, and remember the folder.
/// Writing the copy holds the database lock: it is a one-off, and Google
/// Drive for desktop writes to a local cache.
pub fn start_first(conn: &Connection, app_dir: &Path, folder: &Path) -> Result<DeviceSyncSettings, String> {
    let seed = files::seed_path(folder);
    if seed.exists() {
        return Err("That folder already has Ledgerly data from another computer. Choose Join on this computer instead.".into());
    }
    let id = meta::new_device_id(conn).map_err(|e| e.to_string())?;
    meta::enable(conn, &id).map_err(|e| e.to_string())?;
    if let Err(e) = write_seed(conn, &seed) {
        let _ = meta::disable(conn);
        return Err(e);
    }
    let s = DeviceSyncSettings { folder: Some(folder.to_string_lossy().into_owned()), device_id: Some(id) };
    settings::save(&settings::path(app_dir), &s)?;
    Ok(s)
}

/// `VACUUM INTO` a temporary name beside `seed`, then rename, so the other
/// computer never joins from half a file.
fn write_seed(conn: &Connection, seed: &Path) -> Result<(), String> {
    let dir = seed.parent().ok_or("No folder for the copy")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let tmp = seed.with_extension("sqlite.tmp");
    let _ = std::fs::remove_file(&tmp);
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().into_owned()])
        .map_err(|e| format!("Couldn't copy your data to the folder: {e}"))?;
    std::fs::rename(&tmp, seed).map_err(|e| format!("Couldn't finish copying your data to the folder: {e}"))
}

/// Join a folder the other computer started: stage its copy as a restore
/// (backing this computer's data up first) and remember the folder with a
/// fresh device id. The copy replaces this database at the restart. Returns
/// the safety backup.
pub fn join(conn: &Connection, paths: &Paths, folder: &Path, at: NaiveDateTime) -> Result<Attempt, String> {
    let seed = files::seed_path(folder);
    if !seed.exists() {
        return Err("There's no Ledgerly data in that folder yet. Turn on sync on your other computer first, choosing this same folder.".into());
    }
    let id = meta::new_device_id(conn).map_err(|e| e.to_string())?;
    let safety = restore::stage(conn, paths, &seed, at)?;
    settings::save(
        &settings::path(&paths.app_dir),
        &DeviceSyncSettings { folder: Some(folder.to_string_lossy().into_owned()), device_id: Some(id) },
    )?;
    Ok(safety)
}

/// Stop recording and forget the folder. The folder's files are left alone,
/// so the other computer keeps working and this one can join again.
pub fn stop(conn: &Connection, app_dir: &Path) -> Result<(), String> {
    meta::disable(conn).map_err(|e| e.to_string())?;
    settings::save(&settings::path(app_dir), &DeviceSyncSettings::default())
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test devicesync::pair`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/devicesync
git commit -m "feat(devicesync): start with this computer, join from its copy, stop"
```

---

### Task 8: A sync round, the commands, and launch wiring

**Files:**
- Create: `src-tauri/src/devicesync/run.rs`
- Modify: `src-tauri/src/devicesync/mod.rs`
- Create: `src-tauri/src/commands/devicesync.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing two-computer test**

`src-tauri/src/devicesync/run.rs`:

```rust
//! One sync round. The database lock is held only for the quick parts;
//! reading and writing the shared folder happens without it, because Google
//! Drive may download a file before it can be read (the rule from commit
//! 2fc0f46: never hold the database lock across a download).
use super::files::{self, ChangeFile, DeviceInfo, FORMAT};
use super::{outbox, pull};
use crate::db::{Db, TARGET_VERSION};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RunReport {
    pub at: String,
    pub pushed: usize,
    pub applied: usize,
    pub waiting: usize,
    pub skipped: usize,
    pub newer_files: usize,
}

pub fn round(_db: &Db, _folder: &Path, _device: &str, _device_name: &str) -> Result<RunReport, String> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{self, test_at, Paths};
    use crate::db;
    use crate::devicesync::{meta, pair, settings};
    use std::sync::Mutex;

    struct Computer {
        _dir: tempfile::TempDir,
        db: Db,
        id: String,
    }

    /// The PC, with one SimpleFIN card and one coffee on it, started as the
    /// first computer; and the laptop, joined and restarted.
    fn pair_up(drive: &Path) -> (Computer, Computer) {
        let pc_dir = tempfile::tempdir().unwrap();
        let pc_paths = Paths::new(pc_dir.path());
        let pc = db::open(&pc_paths.db()).unwrap();
        pc.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'TRN-1','2026-10-01',-5,'Coffee');",
        )
        .unwrap();
        let pc_id = pair::start_first(&pc, &pc_paths.app_dir, drive).unwrap().device_id.unwrap();

        let laptop_dir = tempfile::tempdir().unwrap();
        let laptop_paths = Paths::new(laptop_dir.path());
        let laptop = db::open(&laptop_paths.db()).unwrap();
        pair::join(&laptop, &laptop_paths, drive, test_at("2026-10-16 09:00:00")).unwrap();
        drop(laptop);
        backup::startup::run(&laptop_paths, test_at("2026-10-16 09:00:05"));
        let laptop = db::open(&laptop_paths.db()).unwrap();
        let s = settings::load(&settings::path(&laptop_paths.app_dir));
        meta::adopt(&laptop, &s).unwrap();

        (
            Computer { _dir: pc_dir, db: Db(Mutex::new(pc)), id: pc_id },
            Computer { _dir: laptop_dir, db: Db(Mutex::new(laptop)), id: s.device_id.unwrap() },
        )
    }

    fn exec(c: &Computer, sql: &str) {
        c.db.0.lock().unwrap().execute_batch(sql).unwrap();
    }

    fn text(c: &Computer, sql: &str) -> Option<String> {
        c.db.0.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn an_edit_on_either_computer_reaches_the_other() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, laptop) = pair_up(drive.path());

        exec(&pc, "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Dining'),
                     category_source='manual' WHERE external_id='TRN-1';");
        assert_eq!(round(&pc.db, drive.path(), &pc.id, "PC").unwrap().pushed, 1);
        assert_eq!(round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap().applied, 1);
        assert_eq!(
            text(&laptop, "SELECT c.name FROM bank_transactions b JOIN categories c ON c.id=b.category_id").as_deref(),
            Some("Dining")
        );

        exec(&laptop, "UPDATE bank_transactions SET note='with Sam' WHERE external_id='TRN-1';");
        round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap();
        round(&pc.db, drive.path(), &pc.id, "PC").unwrap();
        assert_eq!(text(&pc, "SELECT note FROM bank_transactions").as_deref(), Some("with Sam"));
    }

    #[test]
    fn an_edit_to_a_transaction_the_laptop_has_not_fetched_lands_after_its_bank_sync() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, laptop) = pair_up(drive.path());
        let new_row = "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
                         VALUES ((SELECT id FROM accounts WHERE external_id='ACT-1'),'TRN-2','2026-10-02',-30,'Dinner');";

        exec(&pc, new_row);
        exec(&pc, "UPDATE bank_transactions SET removed=1 WHERE external_id='TRN-2';");
        round(&pc.db, drive.path(), &pc.id, "PC").unwrap();
        assert_eq!(round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap().waiting, 1);

        exec(&laptop, new_row); // the laptop's SimpleFIN sync
        let report = round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap();
        assert_eq!((report.applied, report.waiting), (1, 0));
        assert_eq!(text(&laptop, "SELECT CAST(removed AS TEXT) FROM bank_transactions WHERE external_id='TRN-2'").as_deref(), Some("1"));
    }

    #[test]
    fn each_computer_sees_the_other_in_the_folder() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, laptop) = pair_up(drive.path());
        round(&pc.db, drive.path(), &pc.id, "PC").unwrap();
        let others = files::list_devices(drive.path(), &laptop.id);
        assert_eq!(others.len(), 1);
        assert_eq!(others[0].name, "PC");
    }
}
```

Update `src-tauri/src/devicesync/mod.rs` to its final form:

```rust
//! Keeping two computers' Ledgerly in step through a shared folder (Google
//! Drive). Each computer keeps its own database and syncs SimpleFIN itself;
//! only the owner's edits travel, as immutable change files.
//! Design: docs/superpowers/plans/2026-10-16-device-sync.md
pub mod apply;
pub mod clock;
pub mod files;
pub mod meta;
pub mod outbox;
pub mod pair;
pub mod pull;
pub mod run;
pub mod schema;
pub mod settings;

use std::path::PathBuf;
use std::sync::Mutex;

/// What this session knows beyond the files: the last round's result, and a
/// guard so the timer and the "Sync now" button never run two rounds at once.
pub struct DeviceSyncState {
    pub app_dir: PathBuf,
    pub last: Mutex<Option<run::RunReport>>,
    pub last_error: Mutex<Option<String>>,
    pub running: Mutex<()>,
}

impl DeviceSyncState {
    pub fn new(app_dir: PathBuf) -> Self {
        DeviceSyncState { app_dir, last: Mutex::new(None), last_error: Mutex::new(None), running: Mutex::new(()) }
    }
}

/// This computer's name as Windows knows it, for the other computer's card.
pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "This computer".into())
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test devicesync::run`
Expected: FAIL, panics at "not implemented".

- [ ] **Step 3: Implement `round`**

```rust
/// Send this computer's edits, then take the other computer's.
pub fn round(db: &Db, folder: &Path, device: &str, device_name: &str) -> Result<RunReport, String> {
    let lock = || db.0.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().timestamp_millis();

    let (taken, applied) = {
        let conn = lock();
        (
            outbox::take(&conn).map_err(|e| e.to_string())?,
            pull::applied_names(&conn).map_err(|e| e.to_string())?,
        )
    };

    let mut report = RunReport { at: crate::backup::stamp(crate::backup::now()), ..Default::default() };
    if let Some(taken) = taken {
        let name = files::file_name(device, now, taken.last_seq);
        let file = ChangeFile { format: FORMAT, schema: TARGET_VERSION, device: device.into(), changes: taken.changes.clone() };
        files::write_change_file(folder, &name, &file)?;
        outbox::commit(&lock(), device, &name, &taken).map_err(|e| e.to_string())?;
        report.pushed = taken.changes.len();
    }

    let fetched = pull::fetch(folder, device, &applied);
    let pulled = pull::apply_all(&lock(), &fetched, TARGET_VERSION, now).map_err(|e| e.to_string())?;
    report.applied = pulled.applied;
    report.waiting = pulled.waiting;
    report.skipped = pulled.skipped;
    report.newer_files = pulled.newer_files;

    // Only for the other computer's card. A failure here is not a failed sync.
    let _ = files::write_device(folder, &DeviceInfo { id: device.into(), name: device_name.into(), last_sync: report.at.clone() });
    Ok(report)
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test devicesync::run`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the commands**

`src-tauri/src/commands/devicesync.rs`:

```rust
//! Commands for the "Sync between computers" card. Everything that touches
//! the shared folder runs off the main thread.
use crate::backup::{self, BackupState};
use crate::db::Db;
use crate::devicesync::{self, files, pair, run::RunReport, settings, DeviceSyncState};
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize)]
pub struct DeviceSyncStatus {
    enabled: bool,
    folder: Option<String>,
    this_computer: String,
    others: Vec<files::DeviceInfo>,
    waiting: i64,
    unsent: i64,
    last: Option<RunReport>,
    last_error: Option<String>,
}

fn count(conn: &rusqlite::Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap_or(0)
}

#[tauri::command]
pub async fn device_sync_status(app: tauri::AppHandle) -> Result<DeviceSyncStatus, String> {
    super::off_main_thread(move || {
        let state = app.state::<DeviceSyncState>();
        let s = settings::load(&settings::path(&state.app_dir));
        let (waiting, unsent) = {
            let db = app.state::<Db>();
            let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
            (count(&conn, "sync_pending"), count(&conn, "sync_outbox"))
        };
        let others = match (&s.folder, &s.device_id) {
            (Some(f), Some(id)) => files::list_devices(&PathBuf::from(f), id),
            _ => vec![],
        };
        Ok(DeviceSyncStatus {
            enabled: s.folder.is_some() && s.device_id.is_some(),
            folder: s.folder,
            this_computer: devicesync::computer_name(),
            others,
            waiting,
            unsent,
            last: state.last.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            last_error: state.last_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        })
    })
    .await
}

#[tauri::command]
pub async fn device_sync_start_first(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    super::off_main_thread(move || {
        let state = app.state::<DeviceSyncState>();
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        pair::start_first(&conn, &state.app_dir, &PathBuf::from(folder)).map(|_| ())
    })
    .await
}

/// Stage the other computer's copy, then restart so it is swapped in.
/// Does not return on success.
#[tauri::command]
pub async fn device_sync_join(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    let worker = app.clone();
    super::off_main_thread(move || {
        let backups = worker.state::<BackupState>();
        let db = worker.state::<Db>();
        let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let safety = pair::join(&conn, &backups.paths, &PathBuf::from(folder), backup::now())?;
        backups.record(&safety);
        // Let go of finance.sqlite so the restarted app can replace it.
        *conn = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await?;
    app.restart();
}

/// One round now. If a round is already running, report the last one.
#[tauri::command]
pub async fn device_sync_now(app: tauri::AppHandle) -> Result<Option<RunReport>, String> {
    super::off_main_thread(move || {
        let state = app.state::<DeviceSyncState>();
        let s = settings::load(&settings::path(&state.app_dir));
        let (Some(folder), Some(id)) = (s.folder, s.device_id) else { return Ok(None) };
        let Ok(_guard) = state.running.try_lock() else {
            return Ok(state.last.lock().unwrap_or_else(|e| e.into_inner()).clone());
        };
        let result = devicesync::run::round(&app.state::<Db>(), &PathBuf::from(folder), &id, &devicesync::computer_name());
        match &result {
            Ok(r) => {
                *state.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(r.clone());
                *state.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            Err(e) => *state.last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone()),
        }
        result.map(Some)
    })
    .await
}

#[tauri::command]
pub fn device_sync_stop(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<DeviceSyncState>();
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    pair::stop(&conn, &state.app_dir)
}
```

Add `pub mod devicesync;` to `src-tauri/src/commands/mod.rs`.

- [ ] **Step 6: Wire up launch and the handlers in `lib.rs`**

In `setup`, replace:

```rust
            let conn = db::open(&paths.db()).expect("open db");
            app.manage(db::Db(std::sync::Mutex::new(conn)));
```

with:

```rust
            let conn = db::open(&paths.db()).expect("open db");
            // After open, so a just-joined copy of the other computer's
            // database takes this computer's identity before anything is recorded.
            let sync_settings = devicesync::settings::load(&devicesync::settings::path(&dir));
            if let Err(e) = devicesync::meta::adopt(&conn, &sync_settings) {
                eprintln!("device sync: {e}");
            }
            app.manage(db::Db(std::sync::Mutex::new(conn)));
            app.manage(devicesync::DeviceSyncState::new(dir.clone()));
```

Add to `generate_handler!` after `commands::copilot::copilot_import,`:

```rust
            commands::devicesync::device_sync_status,
            commands::devicesync::device_sync_start_first,
            commands::devicesync::device_sync_join,
            commands::devicesync::device_sync_now,
            commands::devicesync::device_sync_stop,
```

- [ ] **Step 7: Build and run every Rust test**

Run: `cargo test`
Expected: all pass (284 + about 50 new).

Run: `cargo clippy --all-targets`
Expected: no new warnings from `devicesync`.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src
git commit -m "feat(devicesync): sync rounds, commands, and adopting the device id at launch"
```

---

### Task 9: Frontend types, API and query hooks

**Files:**
- Modify: `src/domain/types.ts` (after `BackupStatus`, ~line 161)
- Modify: `src/data/api.ts` (imports at line 2-9; new block after `backup:`)
- Modify: `src/data/queries.ts` (keys at line 6-25; hooks after `useExportCsv`)

- [ ] **Step 1: Add the types**

In `src/domain/types.ts`, after `BackupStatus`:

```ts
/** One device-sync round, as `device_sync_now` reports it. */
export interface DeviceSyncReport {
  at: string;
  pushed: number;
  applied: number;
  waiting: number;
  skipped: number;
  newer_files: number;
}

export interface PairedComputer {
  id: string;
  name: string;
  /** Local time, `2026-10-16T09:30:12`. */
  last_sync: string;
}

export interface DeviceSyncStatus {
  enabled: boolean;
  folder: string | null;
  this_computer: string;
  others: PairedComputer[];
  /** Edits from the other computer waiting for their transaction to arrive here. */
  waiting: number;
  /** Edits made here not yet written to the folder. */
  unsent: number;
  last: DeviceSyncReport | null;
  last_error: string | null;
}
```

- [ ] **Step 2: Add the API calls**

In `src/data/api.ts`, add `DeviceSyncReport, DeviceSyncStatus,` to the type import list, and after the `backup: { ... },` block:

```ts
  deviceSync: {
    status: () => invoke<DeviceSyncStatus>("device_sync_status"),
    startFirst: (folder: string) => invoke<void>("device_sync_start_first", { folder }),
    /** Restarts the app on success, so the promise only ever settles with an error. */
    join: (folder: string) => invoke<void>("device_sync_join", { folder }),
    /** `null` when sync is off. */
    now: () => invoke<DeviceSyncReport | null>("device_sync_now"),
    stop: () => invoke<void>("device_sync_stop"),
  },
```

- [ ] **Step 3: Add the hooks**

In `src/data/queries.ts`, add to `keys`: `deviceSync: ["deviceSync"] as const,`. Then after `useExportCsv`:

```ts
export const useDeviceSyncStatus = () => useQuery({ queryKey: keys.deviceSync, queryFn: api.deviceSync.status });

/** A round that applied the other computer's edits can change any screen, so
 *  everything is refetched; otherwise only the card's status. */
export function useDeviceSyncNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deviceSync.now(),
    onSettled: (report) => {
      if (report && report.applied > 0) qc.invalidateQueries();
      else qc.invalidateQueries({ queryKey: keys.deviceSync });
    },
  });
}

export function useStartDeviceSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (folder: string) => api.deviceSync.startFirst(folder),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.deviceSync }),
  });
}

export function useJoinDeviceSync() {
  return useMutation({ mutationFn: (folder: string) => api.deviceSync.join(folder) });
}

export function useStopDeviceSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deviceSync.stop(),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.deviceSync }),
  });
}
```

- [ ] **Step 4: Type-check**

Run (repo root): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/data/api.ts src/data/queries.ts
git commit -m "feat(devicesync): frontend types, calls and hooks"
```

---

### Task 10: The "Sync between computers" card

**Files:**
- Create: `src/features/settings/DeviceSyncPanel.tsx`
- Create: `src/features/settings/DeviceSyncPanel.test.tsx`
- Create: `src/features/settings/DeviceSyncCard.tsx`
- Modify: `src/features/settings/Settings.tsx` (import, and place after `<BackupCard />` at line 45)

- [ ] **Step 1: Write the failing tests**

`src/features/settings/DeviceSyncPanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { DeviceSyncPanel, type DeviceSyncPanelProps } from "./DeviceSyncPanel";
import type { DeviceSyncStatus } from "../../domain/types";

const off: DeviceSyncStatus = {
  enabled: false, folder: null, this_computer: "WILL-LAPTOP", others: [],
  waiting: 0, unsent: 0, last: null, last_error: null,
};

const on: DeviceSyncStatus = {
  ...off,
  enabled: true,
  folder: "G:\\My Drive\\Ledgerly Sync",
  others: [{ id: "pc", name: "WILL-PC", last_sync: "2026-10-16T09:30:12" }],
  last: { at: "2026-10-16T09:31:00", pushed: 2, applied: 3, waiting: 0, skipped: 0, newer_files: 0 },
};

function props(over: Partial<DeviceSyncPanelProps> = {}): DeviceSyncPanelProps {
  return {
    status: off, today: "2026-10-16", busy: false,
    onStartFirst: vi.fn(), onJoin: vi.fn(), onSyncNow: vi.fn(), onStop: vi.fn(),
    ...over,
  };
}

describe("DeviceSyncPanel", () => {
  it("offers both ways to begin when sync is off", () => {
    const onStartFirst = vi.fn();
    const onJoin = vi.fn();
    render(<DeviceSyncPanel {...props({ onStartFirst, onJoin })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start with this computer…" }));
    fireEvent.click(screen.getByRole("button", { name: "Join…" }));
    expect(onStartFirst).toHaveBeenCalled();
    expect(onJoin).toHaveBeenCalled();
  });

  it("names the folder and the other computer with when it last synced", () => {
    render(<DeviceSyncPanel {...props({ status: on })} />);
    expect(screen.getByText("G:\\My Drive\\Ledgerly Sync")).toBeInTheDocument();
    expect(screen.getByText(/WILL-PC — last synced Today, 09:30/)).toBeInTheDocument();
  });

  it("says when the other computer has not synced yet", () => {
    render(<DeviceSyncPanel {...props({ status: { ...on, others: [] } })} />);
    expect(screen.getByText(/hasn't synced yet/)).toBeInTheDocument();
  });

  it("explains edits waiting for a bank sync", () => {
    render(<DeviceSyncPanel {...props({ status: { ...on, waiting: 2 } })} />);
    expect(screen.getByText(/2 edits from your other computer are waiting/)).toBeInTheDocument();
  });

  it("asks for an update when the other computer runs a newer Ledgerly", () => {
    const status = { ...on, last: { ...on.last!, newer_files: 1 } };
    render(<DeviceSyncPanel {...props({ status })} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/newer version of Ledgerly/);
  });

  it("shows the last error", () => {
    render(<DeviceSyncPanel {...props({ status: { ...on, last_error: "Couldn't write G:\\x" } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't write G:\\x");
  });

  it("syncs now and stops", () => {
    const onSyncNow = vi.fn();
    const onStop = vi.fn();
    render(<DeviceSyncPanel {...props({ status: on, onSyncNow, onStop })} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop syncing" }));
    expect(onSyncNow).toHaveBeenCalled();
    expect(onStop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/settings/DeviceSyncPanel.test.tsx`
Expected: FAIL. Cannot find module `./DeviceSyncPanel`.

- [ ] **Step 3: Write the panel**

`src/features/settings/DeviceSyncPanel.tsx`:

```tsx
import { Card, Button } from "../../ui/components";
import { whenLabel } from "../../domain/backup";
import type { DeviceSyncStatus } from "../../domain/types";

export interface DeviceSyncPanelProps {
  status: DeviceSyncStatus;
  /** Local ISO date, for "Today" and "Yesterday". */
  today: string;
  busy: boolean;
  onStartFirst: () => void;
  onJoin: () => void;
  onSyncNow: () => void;
  onStop: () => void;
}

function lastSynced(stamp: string, today: string): string {
  const [date, time] = stamp.split("T");
  return whenLabel(date, time ?? "00:00:00", today);
}

/** The card's markup. Takes everything as props so it can be tested without
 *  Tauri; `DeviceSyncCard` wires it to the real calls. */
export function DeviceSyncPanel(p: DeviceSyncPanelProps) {
  const { status, today, busy } = p;

  if (!status.enabled) {
    return (
      <Card title="Sync between computers" subtitle="Keep your budgets, categories and edits the same on your PC and laptop.">
        <p className="muted">
          Both computers need the same shared folder, such as one in Google Drive. Start on the computer
          whose data you want to keep, then Join on the other. Joining replaces that computer's Ledgerly
          data with a copy (backed up first).
        </p>
        <div className="row center" style={{ gap: 8, marginTop: 12 }}>
          <Button onClick={p.onStartFirst} loading={busy}>Start with this computer…</Button>
          <Button variant="secondary" onClick={p.onJoin} disabled={busy}>Join…</Button>
        </div>
      </Card>
    );
  }

  const newer = status.last?.newer_files ?? 0;
  return (
    <Card title="Sync between computers" subtitle={`This computer: ${status.this_computer}`}>
      {status.last_error && <p className="neg" role="alert">Last sync failed: {status.last_error}</p>}
      {newer > 0 && (
        <p className="neg" role="alert">
          Your other computer runs a newer version of Ledgerly. Update this one (git pull) to take its latest edits.
        </p>
      )}

      <div className="row center" style={{ gap: 8 }}>
        <span className="muted">Folder</span>
        <code>{status.folder}</code>
      </div>

      <ul style={{ marginTop: 12 }}>
        {status.others.length === 0 ? (
          <li className="muted">Your other computer hasn't synced yet. Choose Join there with this same folder.</li>
        ) : (
          status.others.map((o) => (
            <li key={o.id}>{o.name} — last synced {lastSynced(o.last_sync, today)}</li>
          ))
        )}
      </ul>

      {status.waiting > 0 && (
        <p className="muted">
          {status.waiting} edits from your other computer are waiting for their transactions to arrive here. They
          land after this computer's next bank sync.
        </p>
      )}

      <div className="row center" style={{ gap: 8, marginTop: 12 }}>
        <Button onClick={p.onSyncNow} loading={busy}>Sync now</Button>
        {status.last && <span className="muted">Last: {lastSynced(status.last.at, today)}</span>}
        <Button variant="ghost" size="sm" onClick={p.onStop}>Stop syncing</Button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Syncs every 30 seconds while Ledgerly is open. Until encryption arrives, the shared folder holds your
        edits unencrypted.
      </p>
    </Card>
  );
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/features/settings/DeviceSyncPanel.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the card and place it**

`src/features/settings/DeviceSyncCard.tsx`:

```tsx
import { open } from "@tauri-apps/plugin-dialog";
import {
  useDeviceSyncStatus, useDeviceSyncNow, useStartDeviceSync, useJoinDeviceSync, useStopDeviceSync,
} from "../../data/queries";
import { localIsoDate } from "../../domain/dates";
import { useToast } from "../../ui/toast";
import { askToConfirm } from "../../ui/confirm";
import { DeviceSyncPanel } from "./DeviceSyncPanel";

export function DeviceSyncCard() {
  const status = useDeviceSyncStatus();
  const now = useDeviceSyncNow();
  const start = useStartDeviceSync();
  const join = useJoinDeviceSync();
  const stop = useStopDeviceSync();
  const toast = useToast();

  if (!status.data) return null;
  const failed = (title: string) => (e: unknown) => toast.push({ tone: "neg", title, body: String(e) });
  const chooseFolder = (title: string) => open({ directory: true, title });

  return (
    <DeviceSyncPanel
      status={status.data}
      today={localIsoDate()}
      busy={now.isPending || start.isPending || join.isPending}
      onStartFirst={async () => {
        const folder = await chooseFolder("Choose a shared folder, e.g. in Google Drive");
        if (typeof folder !== "string") return;
        start.mutate(folder, {
          onSuccess: () => toast.push({ tone: "pos", title: "Sync is on", body: "Now choose Join on your other computer." }),
          onError: failed("Couldn't start syncing"),
        });
      }}
      onJoin={async () => {
        const folder = await chooseFolder("Choose the folder your other computer is syncing to");
        if (typeof folder !== "string") return;
        const ok = await askToConfirm(
          "Replace this computer's Ledgerly data with the copy from your other computer?\n\nThis computer's data is backed up first, so this can be undone from Backups. Ledgerly restarts to finish.",
          { okLabel: "Join", cancelLabel: "Cancel" },
        );
        if (ok) join.mutate(folder, { onError: failed("Couldn't join") });
      }}
      onSyncNow={() => now.mutate(undefined, { onError: failed("Sync failed") })}
      onStop={async () => {
        const ok = await askToConfirm(
          "Stop syncing on this computer? Your data stays here; edits stop travelling between the computers.",
          { okLabel: "Stop syncing", cancelLabel: "Cancel" },
        );
        if (ok) stop.mutate(undefined, { onError: failed("Couldn't stop syncing") });
      }}
    />
  );
}
```

In `src/features/settings/Settings.tsx`, add `import { DeviceSyncCard } from "./DeviceSyncCard";` with the other card imports, and put `<DeviceSyncCard />` directly after `<BackupCard />`.

- [ ] **Step 6: Run all TypeScript tests and the type-check**

Run: `npm test`
Expected: all pass (296 + 7).

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/features/settings
git commit -m "feat(settings): the Sync between computers card"
```

---

### Task 11: Sync in the background

**Files:**
- Create: `src/data/deviceSyncSchedule.ts`
- Create: `src/data/deviceSyncSchedule.test.ts`
- Create: `src/data/useDeviceSyncLoop.ts`
- Modify: `src/App.tsx` (beside `usePriceAutoRefresh();` at line 35)
- Modify: `src/data/queries.ts` (the SimpleFIN sync mutation's `onSuccess`)

- [ ] **Step 1: Write the failing schedule tests**

`src/data/deviceSyncSchedule.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planDeviceSync, DEVICE_SYNC_EVERY_MS } from "./deviceSyncSchedule";

describe("planDeviceSync", () => {
  it("does nothing while sync is off, checking again later", () => {
    expect(planDeviceSync({ enabled: false, visible: true, reason: "timer" })).toEqual({ sync: false, delayMs: DEVICE_SYNC_EVERY_MS });
  });

  it("syncs on the timer while the window is visible", () => {
    expect(planDeviceSync({ enabled: true, visible: true, reason: "timer" })).toEqual({ sync: true, delayMs: DEVICE_SYNC_EVERY_MS });
  });

  it("skips timer ticks while hidden", () => {
    expect(planDeviceSync({ enabled: true, visible: false, reason: "timer" }).sync).toBe(false);
  });

  it("syncs as the window hides, so edits leave before the laptop lid closes", () => {
    expect(planDeviceSync({ enabled: true, visible: false, reason: "hidden" }).sync).toBe(true);
  });

  it("syncs straight away on showing the window again", () => {
    expect(planDeviceSync({ enabled: true, visible: true, reason: "shown" }).sync).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/data/deviceSyncSchedule.test.ts`
Expected: FAIL. Cannot find module.

- [ ] **Step 3: Implement the schedule**

`src/data/deviceSyncSchedule.ts`:

```ts
/** How often a visible window syncs with the other computer. */
export const DEVICE_SYNC_EVERY_MS = 30_000;

export interface DeviceSyncMoment {
  enabled: boolean;
  visible: boolean;
  /** What woke the loop: its timer, or the window being hidden or shown. */
  reason: "timer" | "hidden" | "shown";
}

/** Whether to sync now, and when to look again. Pure, so it is tested. */
export function planDeviceSync(m: DeviceSyncMoment): { sync: boolean; delayMs: number } {
  if (!m.enabled) return { sync: false, delayMs: DEVICE_SYNC_EVERY_MS };
  const sync = m.reason === "timer" ? m.visible : true;
  return { sync, delayMs: DEVICE_SYNC_EVERY_MS };
}
```

- [ ] **Step 4: Run them**

Run: `npx vitest run src/data/deviceSyncSchedule.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the loop**

`src/data/useDeviceSyncLoop.ts`:

```ts
import { useEffect, useRef } from "react";
import { api } from "./api";
import { useDeviceSyncNow } from "./queries";
import { planDeviceSync, type DeviceSyncMoment } from "./deviceSyncSchedule";

function windowIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/**
 * Sync with the other computer at launch, every 30 seconds while the window
 * is visible, as it hides and as it shows again. See `deviceSyncSchedule.ts`.
 * The next tick is scheduled only after a round settles, so rounds never overlap.
 */
export function useDeviceSyncLoop() {
  const syncNow = useDeviceSyncNow();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function wake(reason: DeviceSyncMoment["reason"]) {
      if (cancelled) return;
      let enabled = false;
      try {
        enabled = (await api.deviceSync.status()).enabled;
      } catch {
        // Status unreadable: treat as off and look again later.
      }
      const plan = planDeviceSync({ enabled, visible: windowIsVisible(), reason });
      if (plan.sync) {
        try {
          await syncNow.mutateAsync();
        } catch {
          // Offline or the folder is unavailable: the card shows the error; keep going.
        }
      }
      if (cancelled) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => wake("timer"), plan.delayMs);
    }

    function onVisibilityChange() {
      wake(windowIsVisible() ? "shown" : "hidden");
    }

    timer.current = setTimeout(() => wake("timer"), 2_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // syncNow.mutateAsync is stable for the component's lifetime; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
```

In `src/App.tsx`, import `useDeviceSyncLoop` from `./data/useDeviceSyncLoop` and call `useDeviceSyncLoop();` on the line after `usePriceAutoRefresh();`.

- [ ] **Step 6: Sync right after a SimpleFIN sync**

Edits waiting for a transaction land as soon as the bank sync brings it. In `src/data/queries.ts`, add above `useSimplefinSync` (line ~55):

```ts
/** Edits from the other computer may have been waiting for the transactions a
 *  bank sync just brought, so run a device-sync round straight after one. */
function deviceSyncAfterBankSync(qc: ReturnType<typeof useQueryClient>) {
  api.deviceSync.now()
    .then((r) => { if (r && r.applied > 0) qc.invalidateQueries(); })
    .catch(() => {});
}
```

Then, in both `useSimplefinSync` and `useSimplefinBackfill`, change `onSuccess: writeLastSync,` to:

```ts
    onSuccess: (report) => { writeLastSync(report); deviceSyncAfterBankSync(qc); },
```

- [ ] **Step 7: Run all TypeScript tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/data src/App.tsx
git commit -m "feat(devicesync): sync in the background, on hide and after a bank sync"
```

---

### Task 12: Docs and a real two-computer check

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Document it**

In `docs/HANDOFF.md`, under "What's built", after the **Backups** bullet, add:

```markdown
- **Sync between computers** (`src-tauri/src/devicesync/`, Settings card): the
  owner's edits travel between the PC and the laptop through a shared folder
  (Google Drive). Each computer keeps its own database and syncs SimpleFIN
  itself. SQLite triggers record owner edits (categories, budgets, rules, a
  transaction's category/note/reviewed/removed, account type and hidden,
  manual accounts and investment transactions) into `sync_outbox`, keyed by a
  `sync_key` that both computers agree on; each round writes them to an
  immutable file in `changes/<device id>/` and applies the other computer's
  files, last writer wins per field. Edits for a transaction not fetched here
  yet wait in `sync_pending` until the next bank sync. The second computer
  joins by restoring the first one's `seed.sqlite`. `device-sync.json` beside
  the database says which folder and which device this is. Rounds run at
  launch, every 30 s while visible, on hiding the window, after a SimpleFIN
  sync and on "Sync now". Plan and design:
  `docs/superpowers/plans/2026-10-16-device-sync.md`
```

Update the **Tests** line's counts to what `cargo test` and `npm test` now report, and the **Last updated** date.

- [ ] **Step 2: Run everything**

Run (in `src-tauri/`): `cargo test`
Run (repo root): `npm test`
Expected: both pass. Record the counts in HANDOFF.

- [ ] **Step 3: Commit and push, so the laptop can pull the same build**

```bash
git add docs/HANDOFF.md
git commit -m "docs: record syncing between computers"
git push
```

- [ ] **Step 4: Pair the real computers (manual)**

1. **PC:** `git pull`. Open Ledgerly with the "Ledgerly (test)" shortcut. Go to Settings → Sync between computers → **Start with this computer…** and choose (or create) `G:\My Drive\Ledgerly Sync`. Expected: a "Sync is on" toast, and `seed.sqlite` appears in the folder.
2. Wait for Google Drive to finish uploading `seed.sqlite` (Drive icon in the system tray).
3. **Laptop:** `git pull`, then `npm install`. Open Ledgerly with its shortcut. Choose **Join…**, pick the same folder and confirm. Expected: the app restarts showing the PC's categories, budgets and accounts, and the card lists the PC.
4. **PC:** change a transaction's category in Spending. Within about a minute (30 s rounds plus Drive upload time), the laptop shows it.
5. **Laptop:** set a budget limit. The PC shows it within about a minute.
6. **Both:** run a SimpleFIN sync. Expected: no duplicate transactions, and manual categories are kept.

Report what happened at each step, including anything that took longer than 2 minutes.
