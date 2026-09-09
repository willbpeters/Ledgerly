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
#[cfg(test)]
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    apply_migrations(&conn)?;
    Ok(conn)
}

/// Version-gated migrations. v1 is the whole base schema; v2 adds SimpleFIN
/// sync columns and the synced_holdings table; v3 adds budgeting and the
/// `credit` account type; v4 adds the `hidden` flag on accounts. To add a
/// change later: bump TARGET_VERSION, add another `if current < N` block, and
/// give it a completeness check so a mis-stamped database can still repair
/// itself.
const TARGET_VERSION: i64 = 4;

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

/// v3, part one: `accounts.type` must accept 'credit', and SQLite cannot
/// alter a CHECK constraint, so the table is rebuilt. Foreign keys are
/// suspended around the rebuild because transactions and synced_holdings
/// reference it. The leading DROP lets a rebuild that died half-way be retried.
const MIGRATION_3_ACCOUNTS: &str = "
DROP TABLE IF EXISTS accounts_v3;
CREATE TABLE accounts_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('brokerage','cash','credit')),
  institution TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','simplefin')),
  external_id TEXT,
  synced_balance REAL,
  last_synced_at TEXT
);
INSERT INTO accounts_v3 (id,name,type,institution,currency,created_at,source,external_id,synced_balance,last_synced_at)
  SELECT id,name,type,institution,currency,created_at,source,external_id,synced_balance,last_synced_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_v3 RENAME TO accounts;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_external_id
  ON accounts(external_id) WHERE external_id IS NOT NULL;
";

/// v3, part two: the budgeting tables. Every statement is IF NOT EXISTS, so this
/// is safe to re-run against a database that already has some of them.
const MIGRATION_3_BUDGET: &str = "
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('spending','income','transfer')),
  colour TEXT NOT NULL DEFAULT 'chart-1',
  sort INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  posted TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT NOT NULL,
  payee TEXT,
  memo TEXT,
  mcc TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT NOT NULL DEFAULT 'auto' CHECK (category_source IN ('auto','manual')),
  UNIQUE (account_id, external_id)
);
CREATE INDEX IF NOT EXISTS bank_transactions_posted ON bank_transactions(posted);

CREATE TABLE IF NOT EXISTS category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type TEXT NOT NULL CHECK (match_type IN ('payee','description','mcc')),
  pattern TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (match_type, pattern)
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT,
  limit_amount REAL NOT NULL,
  UNIQUE (category_id, month)
);
";

/// v4: accounts can be hidden. A hidden account is left out of every total,
/// chart and list; only the Accounts screen still shows it.
const MIGRATION_4: &str = "ALTER TABLE accounts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;";

/// The tables v3 is responsible for, used by the completeness check below.
const V3_TABLES: &[&str] = &["categories", "bank_transactions", "category_rules", "budgets"];

fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

fn set_user_version(conn: &Connection, version: i64) -> rusqlite::Result<()> {
    // PRAGMA will not take a bound parameter, hence the format.
    conn.execute_batch(&format!("PRAGMA user_version = {};", version))
}

fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM pragma_table_info(?1) WHERE name=?2",
        [table, column],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Whether accounts has already been rebuilt with the widened CHECK. Read from
/// the stored DDL, which is the only place a CHECK constraint lives.
fn accounts_accepts_credit(conn: &Connection) -> rusqlite::Result<bool> {
    let sql: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='accounts'",
        [],
        |r| r.get(0),
    )?;
    Ok(sql.contains("'credit'"))
}

/// Whether every v3 object is actually present, whatever the version stamp says.
fn v3_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    for table in V3_TABLES {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    accounts_accepts_credit(conn)
}

/// Whether v4 is really in place, whatever the version stamp says.
fn v4_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    column_exists(conn, "accounts", "hidden")
}

/// Apply v3. Each half is skipped when already in place, so this is safe to run
/// against a partially-migrated database.
fn apply_v3(conn: &Connection) -> rusqlite::Result<()> {
    if !accounts_accepts_credit(conn)? {
        // The accounts rebuild must not cascade-delete rows in referencing tables.
        conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
        let result = conn.execute_batch(MIGRATION_3_ACCOUNTS);
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        result?;
    }
    conn.execute_batch(MIGRATION_3_BUDGET)?;
    crate::budget::seed::insert_builtin_categories(conn)?;
    Ok(())
}

fn apply_migrations(conn: &Connection) -> rusqlite::Result<()> {
    let current = user_version(conn)?;
    if current < 1 {
        conn.execute_batch(SCHEMA)?;
        set_user_version(conn, 1)?;
    }
    if current < 2 {
        conn.execute_batch(MIGRATION_2)?;
        set_user_version(conn, 2)?;
    }
    // v3 runs whenever its objects are missing, not merely when the version says
    // so. A database can carry a v3 stamp without the v3 schema -- an interrupted
    // migration, or a mid-development build that stamped the version before the
    // migration existed -- and trusting the number alone strands it there for
    // good, failing every budget query with "no such table: category_rules".
    if current < 3 || !v3_is_complete(conn)? {
        apply_v3(conn)?;
        set_user_version(conn, 3)?;
    }
    // v4 must be checked after v3, not before: the v3 accounts rebuild recreates
    // the table without this column, so a v3 repair on a v4 database would drop
    // it again. Running the check here puts it straight back.
    if current < 4 || !v4_is_complete(conn)? {
        conn.execute_batch(MIGRATION_4)?;
    }
    set_user_version(conn, TARGET_VERSION)?;
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

    /// A v1 database with one account and one transaction in it.
    fn v1_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch("PRAGMA user_version = 1;").unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,institution,currency,created_at)
             VALUES ('Old','brokerage',NULL,'USD','2026-01-01')",
            [],
        ).unwrap();
        conn.execute(
            "INSERT INTO transactions (account_id,type,date,amount) VALUES (1,'deposit','2026-01-02',500)",
            [],
        ).unwrap();
        conn
    }

    #[test]
    fn migrates_a_v1_database_all_the_way_forward() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TARGET_VERSION);
        // v2: existing rows default to manual
        let source: String = conn
            .query_row("SELECT source FROM accounts WHERE name='Old'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(source, "manual");
        for table in ["synced_holdings", "categories", "bank_transactions", "category_rules", "budgets"] {
            let has: i64 = conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table], |r| r.get(0),
            ).unwrap();
            assert_eq!(has, 1, "{table} should exist");
        }
    }

    #[test]
    fn the_v3_rebuild_keeps_rows_and_accepts_credit_accounts() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();

        // The accounts rebuild must not lose the row, nor cascade away its transaction.
        let accounts: i64 = conn.query_row("SELECT count(*) FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(accounts, 1);
        let txns: i64 = conn.query_row("SELECT count(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(txns, 1, "the rebuild must not cascade-delete transactions");

        // The widened CHECK now allows a credit card.
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Card','credit','USD','2026-01-01')",
            [],
        ).unwrap();
        // And still rejects nonsense.
        assert!(conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('X','nonsense','USD','2026-01-01')",
            [],
        ).is_err());
    }

    #[test]
    fn v3_seeds_the_builtin_categories_once() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM categories WHERE is_builtin=1", [], |r| r.get(0)).unwrap();
        assert_eq!(n as usize, crate::budget::seed::BUILTIN.len());

        // Running migrations again must not duplicate them.
        apply_migrations(&conn).unwrap();
        let again: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(again, n);
    }

    /// Exactly the state found on the owner's machine: a v2 schema carrying a
    /// v3 stamp. The version gate then skips MIGRATION_3 forever, so every
    /// budget query fails with "no such table: category_rules".
    fn v2_schema_mis_stamped_as_v3() -> Connection {
        let conn = v1_database();
        conn.execute_batch(MIGRATION_2).unwrap();
        conn.execute_batch("PRAGMA user_version = 3;").unwrap();
        conn
    }

    #[test]
    fn repairs_a_database_stamped_v3_that_never_got_the_v3_tables() {
        let conn = v2_schema_mis_stamped_as_v3();
        apply_migrations(&conn).unwrap();
        for table in ["categories", "bank_transactions", "category_rules", "budgets"] {
            let has: i64 = conn.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table], |r| r.get(0),
            ).unwrap();
            assert_eq!(has, 1, "{table} should have been repaired into place");
        }
    }

    #[test]
    fn the_repair_widens_the_accounts_check_to_accept_credit() {
        let conn = v2_schema_mis_stamped_as_v3();
        apply_migrations(&conn).unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Card','credit','USD','2026-01-01')",
            [],
        ).unwrap();
    }

    #[test]
    fn the_repair_keeps_existing_rows() {
        let conn = v2_schema_mis_stamped_as_v3();
        apply_migrations(&conn).unwrap();
        let accounts: i64 = conn.query_row("SELECT count(*) FROM accounts", [], |r| r.get(0)).unwrap();
        let txns: i64 = conn.query_row("SELECT count(*) FROM transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(accounts, 1, "repair must not lose accounts");
        assert_eq!(txns, 1, "repair must not cascade-delete transactions");
    }

    #[test]
    fn the_repair_seeds_the_builtin_categories() {
        let conn = v2_schema_mis_stamped_as_v3();
        apply_migrations(&conn).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(n as usize, crate::budget::seed::BUILTIN.len());
    }

    #[test]
    fn a_healthy_database_is_left_untouched_by_the_repair_check() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO categories (name,kind,colour,sort,is_builtin) VALUES ('Mine','spending','chart-1',999,0)",
            [],
        ).unwrap();
        let before: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();

        apply_migrations(&conn).unwrap();

        let after: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(before, after, "re-running migrations must not disturb a good database");
    }
    fn hidden_of(conn: &Connection, name: &str) -> i64 {
        conn.query_row("SELECT hidden FROM accounts WHERE name=?1", [name], |r| r.get(0)).unwrap()
    }

    #[test]
    fn v4_adds_the_hidden_column_and_existing_accounts_start_visible() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        assert_eq!(hidden_of(&conn, "Old"), 0, "an existing account must start visible");
    }

    #[test]
    fn v4_lets_an_account_be_hidden_and_shown_again() {
        let conn = open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('A','cash','USD','2026-01-01')",
            [],
        ).unwrap();
        conn.execute("UPDATE accounts SET hidden=1 WHERE name='A'", []).unwrap();
        assert_eq!(hidden_of(&conn, "A"), 1);
        conn.execute("UPDATE accounts SET hidden=0 WHERE name='A'", []).unwrap();
        assert_eq!(hidden_of(&conn, "A"), 0);
    }

    #[test]
    fn repairs_a_database_stamped_v4_that_is_missing_the_hidden_column() {
        // The same failure mode as the v3 mis-stamp: a version that ran ahead of
        // the schema. The completeness check must catch this one too.
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch("ALTER TABLE accounts DROP COLUMN hidden;").unwrap();
        conn.execute_batch("PRAGMA user_version = 4;").unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(hidden_of(&conn, "Old"), 0, "the hidden column must be restored");
    }

    #[test]
    fn a_v1_database_migrated_forward_ends_at_the_target_version() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 4);
        assert_eq!(version, TARGET_VERSION);
    }
    #[test]
    fn foreign_keys_are_back_on_after_the_rebuild() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        let on: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(on, 1);
    }
}
