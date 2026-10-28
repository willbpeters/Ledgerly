//! The bookkeeping that lets two computers share the owner's edits: a stable
//! `sync_key` on every row the owner edits (local ids differ between
//! computers; keys do not), the outbox the triggers fill, and what has been
//! applied from the other computer.
use rusqlite::Connection;

/// Tables whose rows carry a `sync_key` column. Budgets, rules and dismissed
/// bills need none: their natural keys (category + month; type + pattern; the
/// payee key) already agree. Splits travel as a field of their transaction.
pub const KEYED_TABLES: &[&str] = &["accounts", "categories", "bank_transactions", "transactions", "goals"];

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
CREATE INDEX IF NOT EXISTS sync_outbox_field ON sync_outbox(tbl, key, field);
CREATE TABLE IF NOT EXISTS sync_files_applied (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS sync_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, field TEXT NOT NULL,
  value TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_pending_key ON sync_pending(tbl, key);
DROP VIEW IF EXISTS sync_on;
CREATE VIEW sync_on AS SELECT
  coalesce((SELECT value FROM sync_meta WHERE name='enabled'), '0') = '1'
  AND coalesce((SELECT value FROM sync_meta WHERE name='applying'), '0') <> '1' AS yes;
";

/// Keys for rows that existed before v12. SimpleFIN accounts, their
/// transactions and categories get keys the other computer derives the same
/// way; manual rows get random ones, which reach the other computer in the
/// seed copy.
const BACKFILL: &str = "
UPDATE accounts SET sync_key = CASE
    WHEN source = 'simplefin' AND external_id IS NOT NULL THEN 'sf:' || external_id
    ELSE 'acct:' || lower(hex(randomblob(16))) END
  WHERE sync_key IS NULL;
-- A renamed category keeps its old key, so a new one reusing the name gets a
-- suffix rather than colliding with it.
UPDATE categories SET sync_key = CASE
    WHEN EXISTS (SELECT 1 FROM categories c2 WHERE c2.sync_key = 'cat:' || categories.name)
      THEN 'cat:' || name || ':' || lower(hex(randomblob(4)))
    ELSE 'cat:' || name END
  WHERE sync_key IS NULL;
UPDATE bank_transactions SET sync_key =
    (SELECT a.sync_key FROM accounts a WHERE a.id = bank_transactions.account_id) || '|' || external_id
  WHERE sync_key IS NULL;
UPDATE transactions SET sync_key = 'txn:' || lower(hex(randomblob(16))) WHERE sync_key IS NULL;
UPDATE goals SET sync_key = 'goal:' || lower(hex(randomblob(16))) WHERE sync_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_sync_key ON accounts(sync_key);
CREATE UNIQUE INDEX IF NOT EXISTS goals_sync_key ON goals(sync_key);
CREATE UNIQUE INDEX IF NOT EXISTS categories_sync_key ON categories(sync_key);
CREATE UNIQUE INDEX IF NOT EXISTS bank_transactions_sync_key ON bank_transactions(sync_key);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_sync_key ON transactions(sync_key);
";

/// Now in milliseconds since 1970, inside SQL.
const NOW: &str = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)";

const TRIGGER_NAMES: &[&str] = &[
    "accounts_sync_insert", "accounts_sync_update", "accounts_sync_delete",
    "categories_sync_insert", "categories_sync_update", "categories_sync_delete",
    "bank_transactions_sync_insert", "bank_transactions_sync_update",
    "category_rules_sync_insert", "category_rules_sync_update", "category_rules_sync_delete",
    "budgets_sync_insert", "budgets_sync_update", "budgets_sync_delete",
    "transactions_sync_insert", "transactions_sync_delete",
    "goals_sync_insert", "goals_sync_update", "goals_sync_delete",
    "splits_sync_insert", "splits_sync_update", "splits_sync_delete",
    "recurring_dismissed_sync_insert", "recurring_dismissed_sync_delete",
];

/// A transaction's whole set of split pieces, as one JSON array, for the row
/// `b`. `[]` once it is unsplit.
const SPLITS: &str = "(SELECT json_group_array(json(piece)) FROM (
    SELECT json_object('category', c.sync_key, 'amount', s.amount, 'note', s.note, 'sort', s.sort) AS piece
    FROM bank_transaction_splits s LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.txn_id = b.id ORDER BY s.sort, s.id))";

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
  -- A Copilot row SimpleFIN adopted keeps its old key while its external_id
  -- changes, so a re-import can derive a key that is already taken.
  UPDATE bank_transactions SET sync_key = CASE
      WHEN EXISTS (SELECT 1 FROM bank_transactions o WHERE o.sync_key =
          (SELECT a.sync_key FROM accounts a WHERE a.id = NEW.account_id) || '|' || NEW.external_id)
        THEN (SELECT a.sync_key FROM accounts a WHERE a.id = NEW.account_id) || '|' || NEW.external_id
          || ':' || lower(hex(randomblob(4)))
      ELSE (SELECT a.sync_key FROM accounts a WHERE a.id = NEW.account_id) || '|' || NEW.external_id END
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
    WHERE ((NEW.category_source = 'manual'
             AND (OLD.category_source <> 'manual' OR OLD.category_id IS NOT NEW.category_id))
       OR (NEW.category_source = 'auto' AND OLD.category_source = 'manual'))
      -- A category delete sets category_id NULL after the category is gone:
      -- that is a cascade, not an edit.
      AND (OLD.category_id IS NULL OR EXISTS (SELECT 1 FROM categories WHERE id = OLD.category_id));
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
WHEN (SELECT yes FROM sync_on)
  AND EXISTS (SELECT 1 FROM categories WHERE id = OLD.category_id) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    VALUES ('category_rules', OLD.match_type || ':' || OLD.pattern, '_row', NULL, {NOW});
END;

-- Budget keys need the category's key. When a category delete cascades to
-- its budgets the category row is already gone, the SELECT finds nothing and
-- nothing is recorded: the category's own deletion carries the news.
-- The key is `<category key>|<month or *>`. Category names may contain '|',
-- so the applier must split on the LAST '|'.
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
WHEN OLD.sync_key IS NOT NULL AND (SELECT yes FROM sync_on)
  AND EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at) VALUES ('transactions', OLD.sync_key, '_row', NULL, {NOW});
END;

CREATE TRIGGER goals_sync_insert AFTER INSERT ON goals BEGIN
  UPDATE goals SET sync_key = 'goal:' || lower(hex(randomblob(16)))
    WHERE id = NEW.id AND sync_key IS NULL;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'goals', g.sync_key, '_row',
      json_object('name', g.name, 'target_amount', g.target_amount, 'target_date', g.target_date,
        'account', (SELECT a.sync_key FROM accounts a WHERE a.id = g.account_id),
        'saved_amount', g.saved_amount, 'created_at', g.created_at), {NOW}
    FROM goals g WHERE g.id = NEW.id AND (SELECT yes FROM sync_on);
END;

CREATE TRIGGER goals_sync_update AFTER UPDATE OF name, target_amount, target_date, account_id, saved_amount ON goals
WHEN (SELECT yes FROM sync_on) AND NEW.sync_key IS NOT NULL BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'goals', NEW.sync_key, 'name', json_quote(NEW.name), {NOW} WHERE OLD.name IS NOT NEW.name;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'goals', NEW.sync_key, 'target_amount', json_quote(NEW.target_amount), {NOW}
    WHERE OLD.target_amount IS NOT NEW.target_amount;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'goals', NEW.sync_key, 'target_date', json_quote(NEW.target_date), {NOW}
    WHERE OLD.target_date IS NOT NEW.target_date;
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'goals', NEW.sync_key, 'saved_amount', json_quote(NEW.saved_amount), {NOW}
    WHERE OLD.saved_amount IS NOT NEW.saved_amount;
  -- An account delete sets account_id NULL after the account is gone: that
  -- is a cascade, not an edit.
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'goals', NEW.sync_key, 'account',
      json_quote((SELECT a.sync_key FROM accounts a WHERE a.id = NEW.account_id)), {NOW}
    WHERE OLD.account_id IS NOT NEW.account_id
      AND (OLD.account_id IS NULL OR EXISTS (SELECT 1 FROM accounts WHERE id = OLD.account_id));
END;

CREATE TRIGGER goals_sync_delete AFTER DELETE ON goals
WHEN OLD.sync_key IS NOT NULL AND (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at) VALUES ('goals', OLD.sync_key, '_row', NULL, {NOW});
END;

-- Splits are replaced as a set, so every piece written or removed records the
-- transaction's whole set as it now stands; the last one recorded is the
-- finished set. A transaction deleted out from under its pieces finds no
-- row here and records nothing.
CREATE TRIGGER splits_sync_insert AFTER INSERT ON bank_transaction_splits
WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', b.sync_key, 'splits', {SPLITS}, {NOW}
    FROM bank_transactions b WHERE b.id = NEW.txn_id AND b.sync_key IS NOT NULL;
END;

-- A category delete sets a piece's category NULL after the category is gone:
-- a cascade, which the category's own deletion carries.
CREATE TRIGGER splits_sync_update AFTER UPDATE OF category_id, amount, note, sort ON bank_transaction_splits
WHEN (SELECT yes FROM sync_on)
  AND (OLD.category_id IS NULL OR EXISTS (SELECT 1 FROM categories WHERE id = OLD.category_id)) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', b.sync_key, 'splits', {SPLITS}, {NOW}
    FROM bank_transactions b WHERE b.id = NEW.txn_id AND b.sync_key IS NOT NULL;
END;

CREATE TRIGGER splits_sync_delete AFTER DELETE ON bank_transaction_splits
WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    SELECT 'bank_transactions', b.sync_key, 'splits', {SPLITS}, {NOW}
    FROM bank_transactions b WHERE b.id = OLD.txn_id AND b.sync_key IS NOT NULL;
END;

CREATE TRIGGER recurring_dismissed_sync_insert AFTER INSERT ON recurring_dismissed
WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at)
    VALUES ('recurring_dismissed', NEW.payee_key, '_row', json_object('dismissed_at', NEW.dismissed_at), {NOW});
END;

CREATE TRIGGER recurring_dismissed_sync_delete AFTER DELETE ON recurring_dismissed
WHEN (SELECT yes FROM sync_on) BEGIN
  INSERT INTO sync_outbox (tbl, key, field, value, at) VALUES ('recurring_dismissed', OLD.payee_key, '_row', NULL, {NOW});
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

/// Drop every sync trigger. Triggers block `ALTER TABLE DROP COLUMN` and table
/// rebuilds, so migrations run without them and `install` puts them back.
pub(crate) fn drop_triggers(conn: &Connection) -> rusqlite::Result<()> {
    for name in TRIGGER_NAMES {
        conn.execute_batch(&format!("DROP TRIGGER IF EXISTS {name};"))?;
    }
    Ok(())
}

/// Whether every v12 object is really present, whatever the version stamp says.
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
    // Task-2 triggers read this view, so a missing one would break every insert.
    let view: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='view' AND name='sync_on'",
        [],
        |r| r.get(0),
    )?;
    if view != 1 {
        return Ok(false);
    }
    for name in TRIGGER_NAMES {
        if !trigger_exists(conn, name)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Safe to re-run: every step is conditional. One transaction, so an
/// interruption leaves v11 or the finished v12.
pub fn install(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for table in KEYED_TABLES {
        crate::db::add_column_if_missing(&tx, table, "sync_key", "sync_key TEXT")?;
    }
    tx.execute_batch(TABLES)?;
    tx.execute_batch(BACKFILL)?;
    // apply_migrations drops the triggers on every open, and this recreates
    // them from the current text, so a changed body reaches existing
    // databases. The drop here keeps install safe to call on its own.
    drop_triggers(&tx)?;
    tx.execute_batch(&TRIGGERS.replace("{SPLITS}", SPLITS).replace("{NOW}", NOW))?;
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
        crate::budget::seed::test_categories(&conn);
        assert!(is_complete(&conn).unwrap());
    }

    #[test]
    fn existing_rows_get_keys_both_computers_would_agree_on() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
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
        crate::budget::seed::test_categories(&conn);
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
        crate::budget::seed::test_categories(&conn);
        install(&conn).unwrap();
        install(&conn).unwrap();
        assert!(is_complete(&conn).unwrap());
    }

    #[test]
    fn a_reinstall_does_not_collide_with_a_renamed_category_key() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        conn.execute_batch(
            "UPDATE categories SET name='Eating out' WHERE name='Dining';
             INSERT INTO categories (name,kind) VALUES ('Dining','spending');
             UPDATE categories SET sync_key=NULL WHERE name='Dining';",
        )
        .unwrap();
        assert_eq!(text(&conn, "SELECT sync_key FROM categories WHERE name='Eating out'").as_deref(), Some("cat:Dining"));

        install(&conn).unwrap();

        let key = text(&conn, "SELECT sync_key FROM categories WHERE name='Dining'").unwrap();
        assert!(key.starts_with("cat:Dining:"), "{key}");
    }

    #[test]
    fn a_missing_sync_on_view_makes_it_incomplete() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        conn.execute_batch("DROP VIEW sync_on;").unwrap();
        assert!(!is_complete(&conn).unwrap());
        install(&conn).unwrap();
        assert!(is_complete(&conn).unwrap());
    }

    fn enabled() -> Connection {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
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
        crate::budget::seed::test_categories(&conn);
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

    fn manual_investment_txn(conn: &Connection) {
        conn.execute_batch(
            "INSERT INTO securities (ticker,name,type) VALUES ('VTI','Vanguard Total','etf');
             INSERT INTO transactions (account_id,security_id,type,date,quantity,price,amount)
               VALUES (1,1,'buy','2026-10-01',2,250,500);",
        )
        .unwrap();
    }

    #[test]
    fn deleting_a_simplefin_account_does_not_record_its_cascaded_manual_transactions() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Brokerage','brokerage','USD','2026-01-01','simplefin','ACT-2');",
        )
        .unwrap();
        manual_investment_txn(&conn);
        conn.execute_batch("DELETE FROM sync_outbox; DELETE FROM accounts WHERE id=1;").unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(outbox(&conn).is_empty(), "{:?}", outbox(&conn));
    }

    #[test]
    fn deleting_a_manual_investment_transaction_directly_is_recorded() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Brokerage','brokerage','USD','2026-01-01');",
        )
        .unwrap();
        manual_investment_txn(&conn);
        conn.execute_batch("DELETE FROM sync_outbox; DELETE FROM transactions;").unwrap();
        let rows = outbox(&conn);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert!(rows[0].1.starts_with("txn:") && rows[0].3.is_none());
    }

    #[test]
    fn deleting_a_category_records_only_the_category() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "INSERT INTO category_rules (match_type, pattern, category_id, created_at)
               VALUES ('payee', 'blue bottle', (SELECT id FROM categories WHERE name='Dining'), '2026-10-16');
             UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Dining'),
               category_source='manual' WHERE id=1;
             DELETE FROM sync_outbox;
             DELETE FROM categories WHERE name='Dining';",
        )
        .unwrap();
        let rows = outbox(&conn);
        assert_eq!(rows, vec![("categories".into(), "cat:Dining".into(), "_row".into(), None)]);
    }

    #[test]
    fn deleting_a_category_does_not_record_the_splits_it_empties() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "INSERT INTO bank_transaction_splits (txn_id, category_id, amount, sort)
               VALUES (1, (SELECT id FROM categories WHERE name='Dining'), -3, 0), (1, NULL, -2, 1);
             DELETE FROM sync_outbox;
             DELETE FROM categories WHERE name='Dining';",
        )
        .unwrap();
        assert_eq!(outbox(&conn), vec![("categories".into(), "cat:Dining".into(), "_row".into(), None)]);
    }

    #[test]
    fn a_split_is_recorded_as_the_whole_set_on_its_transaction() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "DELETE FROM sync_outbox;
             INSERT INTO bank_transaction_splits (txn_id, category_id, amount, note, sort)
               VALUES (1, (SELECT id FROM categories WHERE name='Dining'), -3, 'lunch', 0), (1, NULL, -2, NULL, 1);",
        )
        .unwrap();
        let (tbl, key, field, value) = outbox(&conn).pop().unwrap();
        assert_eq!((tbl.as_str(), key.as_str(), field.as_str()), ("bank_transactions", "sf:ACT-1|TRN-1", "splits"));
        let value: serde_json::Value = serde_json::from_str(&value.unwrap()).unwrap();
        assert_eq!(value, serde_json::json!([
            {"category": "cat:Dining", "amount": -3.0, "note": "lunch", "sort": 0},
            {"category": null, "amount": -2.0, "note": null, "sort": 1},
        ]));
    }

    #[test]
    fn deleting_an_account_records_the_account_not_its_goals() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Savings','cash','USD','2026-01-01');
             INSERT INTO goals (name,target_amount,account_id,saved_amount,created_at)
               VALUES ('Holiday',2000,1,0,'2026-10-20');
             DELETE FROM sync_outbox;
             DELETE FROM accounts;",
        )
        .unwrap();
        let rows = outbox(&conn);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].0, "accounts");
    }

    #[test]
    fn a_reimported_copilot_row_after_adoption_gets_a_suffixed_key() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'copilot:abc','2026-09-01',-3,'Tea');
             UPDATE bank_transactions SET external_id='TRN-9' WHERE external_id='copilot:abc';
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'copilot:abc','2026-09-01',-3,'Tea');",
        )
        .unwrap();
        let key = text(&conn, "SELECT sync_key FROM bank_transactions WHERE external_id='copilot:abc'").unwrap();
        assert!(key.starts_with("sf:ACT-1|copilot:abc:"), "{key}");
    }

    #[test]
    fn a_copilot_history_row_on_a_simplefin_account_is_recorded() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'copilot:abc','2026-09-01',-3,'Tea');",
        )
        .unwrap();
        let rows = outbox(&conn);
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!((rows[0].1.as_str(), rows[0].2.as_str()), ("sf:ACT-1|copilot:abc", "_row"));
    }

    #[test]
    fn approving_a_row_records_the_category_as_manual() {
        let conn = enabled();
        simplefin_txn(&conn);
        crate::budget::store::approve(&conn, &[1]).unwrap();
        let rows = outbox(&conn);
        assert!(rows.contains(&(
            "bank_transactions".into(), "sf:ACT-1|TRN-1".into(), "category".into(), Some(r#"[null,"manual"]"#.into())
        )), "{rows:?}");
    }

    #[test]
    fn undoing_to_automatic_records_the_category_as_auto() {
        use crate::budget::store::{restore_rows, RowState};
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Dining'),
               category_source='manual', reviewed=1 WHERE id=1; DELETE FROM sync_outbox;",
        )
        .unwrap();
        restore_rows(&conn, &[RowState { id: 1, category_id: None, category_source: "auto".into(), reviewed: false, removed: false }])
            .unwrap();
        let rows = outbox(&conn);
        assert!(rows.contains(&(
            "bank_transactions".into(), "sf:ACT-1|TRN-1".into(), "category".into(), Some(r#"[null,"auto"]"#.into())
        )), "{rows:?}");
    }

    #[test]
    fn changing_a_rules_category_by_upsert_is_recorded() {
        let conn = enabled();
        conn.execute_batch(
            "INSERT INTO category_rules (match_type, pattern, category_id, created_at)
               VALUES ('payee', 'blue bottle', (SELECT id FROM categories WHERE name='Dining'), '2026-10-16');
             DELETE FROM sync_outbox;
             INSERT INTO category_rules (match_type, pattern, category_id, created_at)
               VALUES ('payee', 'blue bottle', (SELECT id FROM categories WHERE name='Groceries'), '2026-10-17')
               ON CONFLICT(match_type, pattern) DO UPDATE SET category_id=excluded.category_id;",
        )
        .unwrap();
        assert_eq!(
            outbox(&conn),
            vec![("category_rules".into(), "payee:blue bottle".into(), "category".into(), Some(r#""cat:Groceries""#.into()))]
        );
    }

    #[test]
    fn making_a_rule_records_the_row_and_the_rule_but_not_the_fanned_out_rows() {
        let conn = enabled();
        simplefin_txn(&conn);
        conn.execute_batch(
            "UPDATE bank_transactions SET payee='Blue Bottle' WHERE id=1;
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee)
               VALUES (1,'TRN-2','2026-10-02',-6,'Coffee','Blue Bottle');
             DELETE FROM sync_outbox;",
        )
        .unwrap();
        let dining: i64 = conn.query_row("SELECT id FROM categories WHERE name='Dining'", [], |r| r.get(0)).unwrap();
        crate::budget::store::set_category(&conn, 1, Some(dining), true).unwrap();

        let rows = outbox(&conn);
        assert!(rows.iter().all(|r| r.1 != "sf:ACT-1|TRN-2"), "{rows:?}");
        assert!(rows.iter().any(|r| r.1 == "sf:ACT-1|TRN-1" && r.2 == "category"), "{rows:?}");
        assert!(rows.iter().any(|r| r.0 == "category_rules" && r.1 == "payee:blue bottle"), "{rows:?}");
        let fanned: i64 = conn.query_row("SELECT category_id FROM bank_transactions WHERE id=2", [], |r| r.get(0)).unwrap();
        assert_eq!(fanned, dining);
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
}
