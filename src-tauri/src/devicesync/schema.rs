//! The bookkeeping that lets two computers share the owner's edits: a stable
//! `sync_key` on every row the owner edits (local ids differ between
//! computers; keys do not), the outbox the triggers fill, and what has been
//! applied from the other computer.
use rusqlite::Connection;

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
