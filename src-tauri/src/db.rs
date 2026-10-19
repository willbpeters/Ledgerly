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
/// `credit` account type; v4 adds the `hidden` flag on accounts; v5 adds the
/// Markets tables; v6 adds `reviewed` to bank transactions and re-sorts them
/// once; v7 adds a `note` and v8 a `removed` flag to bank transactions. To add a change later: bump
/// TARGET_VERSION, add another `if current < N` block, and give it a
/// completeness check so a mis-stamped database can still repair itself. Add
/// the new completeness check to `migration_pending` too. v9 adds device sync
/// (sync keys, the outbox and its triggers).
pub(crate) const TARGET_VERSION: i64 = 9;

/// v2's added columns, as (name, definition). Added one at a time and only
/// when missing: SQLite has no ALTER TABLE ADD COLUMN IF NOT EXISTS, and
/// re-adding an existing column is a hard error.
const V2_COLUMNS: &[(&str, &str)] = &[
    ("source", "source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','simplefin'))"),
    ("external_id", "external_id TEXT"),
    ("synced_balance", "synced_balance REAL"),
    ("last_synced_at", "last_synced_at TEXT"),
];

const MIGRATION_2: &str = "
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
const V4_COLUMN: (&str, &str) = ("hidden", "hidden INTEGER NOT NULL DEFAULT 0");

/// v5: the Markets module — cached headlines, earnings events, per-security
/// profile (which routes a holding into "companies" or "funds"), and index
/// levels. Index levels live in their own table rather than in `securities`,
/// so the S&P never appears in Holdings or the allocation chart as though it
/// were owned.
const V5_TABLES: &[&str] = &["news_items", "earnings_events", "security_profile", "index_quotes"];

const MIGRATION_5: &str = "
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  publisher TEXT,
  published TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (security_id, guid)
);
CREATE INDEX IF NOT EXISTS news_items_published ON news_items(published);

CREATE TABLE IF NOT EXISTS earnings_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  fiscal_period TEXT,
  report_date TEXT NOT NULL,
  eps_actual REAL,
  eps_estimate REAL,
  estimate_count INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (security_id, report_date)
);

CREATE TABLE IF NOT EXISTS security_profile (
  security_id INTEGER PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
  long_name TEXT,
  sector TEXT,
  quote_type TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_quotes (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);
";

/// Whether every v5 object is really present, whatever the version stamp says.
fn v5_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    for table in V5_TABLES {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Every statement is IF NOT EXISTS, so this is safe to re-run.
fn apply_v5(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_5)
}

/// v6: bank transactions can be reviewed, as in Copilot.
const V6_COLUMN: (&str, &str) = ("reviewed", "reviewed INTEGER NOT NULL DEFAULT 0");

fn v6_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    column_exists(conn, "bank_transactions", V6_COLUMN.0)
}

/// Adds the column, re-sorts every automatic row with the new rules, then
/// marks reviewed exactly the rows that ended up with a category — the owner
/// chose to review only what is still uncategorised. One transaction, so an
/// interruption leaves the old schema or the finished one, never a column with
/// nothing marked (which would bury every transaction in the review list).
fn apply_v6(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    add_column_if_missing(&tx, "bank_transactions", V6_COLUMN.0, V6_COLUMN.1)?;
    // The re-sort below is today's code, and today's code reads the v8 column.
    // Adding it here is harmless (v8 then finds it present) and keeps an
    // upgrade from v5 or older from failing on "no such column".
    add_column_if_missing(&tx, "bank_transactions", V8_COLUMN.0, V8_COLUMN.1)?;
    crate::budget::store::recategorise_all(&tx)?;
    tx.execute("UPDATE bank_transactions SET reviewed = (category_id IS NOT NULL)", [])?;
    tx.commit()
}

/// v7: a note on each bank transaction (Copilot's notes arrive with the import).
const V7_COLUMN: (&str, &str) = ("note", "note TEXT");

fn v7_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    column_exists(conn, "bank_transactions", V7_COLUMN.0)
}

/// Also drops pending rows dated 1970: SimpleFIN sent `posted: 0` for them and
/// an older parser read it as an epoch. They are pending copies — the next sync
/// brings them back with the date they happened.
fn apply_v7(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    add_column_if_missing(&tx, "bank_transactions", V7_COLUMN.0, V7_COLUMN.1)?;
    tx.execute("DELETE FROM bank_transactions WHERE pending = 1 AND posted < '2000-01-01'", [])?;
    tx.commit()
}

/// v8: a transaction can be removed — the owner does this when they are paid
/// back. A flag rather than a delete, because a deleted SimpleFIN row would
/// come straight back on the next sync, and because it can be restored.
const V8_COLUMN: (&str, &str) = ("removed", "removed INTEGER NOT NULL DEFAULT 0");

fn v8_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    column_exists(conn, "bank_transactions", V8_COLUMN.0)
}

fn apply_v8(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_missing(conn, "bank_transactions", V8_COLUMN.0, V8_COLUMN.1)
}

/// The tables v3 is responsible for, used by the completeness check below.
const V3_TABLES: &[&str] = &["categories", "bank_transactions", "category_rules", "budgets"];

fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

fn set_user_version(conn: &Connection, version: i64) -> rusqlite::Result<()> {
    // PRAGMA will not take a bound parameter, hence the format.
    conn.execute_batch(&format!("PRAGMA user_version = {};", version))
}

pub(crate) fn table_exists(conn: &Connection, name: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM pragma_table_info(?1) WHERE name=?2",
        [table, column],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Add a column only if it is not already there. SQLite has no
/// `ADD COLUMN IF NOT EXISTS`, and re-adding one is a hard error that would
/// panic the app on startup.
pub(crate) fn add_column_if_missing(conn: &Connection, table: &str, column: &str, definition: &str)
    -> rusqlite::Result<()> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition};"))
}

/// Whether v2 is really in place, whatever the version stamp says.
fn v2_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    for (name, _) in V2_COLUMNS {
        if !column_exists(conn, "accounts", name)? {
            return Ok(false);
        }
    }
    table_exists(conn, "synced_holdings")
}

/// Apply v2. Each column is added only if missing, so a run that died
/// part-way can be retried.
fn apply_v2(conn: &Connection) -> rusqlite::Result<()> {
    for (name, definition) in V2_COLUMNS {
        add_column_if_missing(conn, "accounts", name, definition)?;
    }
    conn.execute_batch(MIGRATION_2)
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
    column_exists(conn, "accounts", V4_COLUMN.0)
}

fn apply_v4(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_missing(conn, "accounts", V4_COLUMN.0, V4_COLUMN.1)
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
    // The base schema is CREATE TABLE IF NOT EXISTS throughout, so it is safe
    // against anything.
    if user_version(conn)? < 1 {
        conn.execute_batch(SCHEMA)?;
        set_user_version(conn, 1)?;
    }

    // From here the *schema itself* decides what runs, never the version stamp.
    // A stamp can be wrong in both directions: ahead of the schema (a migration
    // interrupted part-way, or a build that stamped before the migration
    // existed) or behind it (an older build re-stamping a database it had
    // already migrated). Trusting it while ahead strands the database with
    // missing tables; trusting it while behind re-runs ALTER TABLE ADD COLUMN
    // against a column that is already there, which SQLite treats as a hard
    // error and which panics the app on startup. Asking the schema is the only
    // answer that is right in both directions.
    if !v2_is_complete(conn)? {
        apply_v2(conn)?;
        set_user_version(conn, 2)?;
    }
    if !v3_is_complete(conn)? {
        apply_v3(conn)?;
        set_user_version(conn, 3)?;
    }
    // v4 is checked after v3: the v3 accounts rebuild recreates the table
    // without this column, so a v3 repair would otherwise drop it again.
    if !v4_is_complete(conn)? {
        apply_v4(conn)?;
    }
    if !v5_is_complete(conn)? {
        apply_v5(conn)?;
    }
    if !v6_is_complete(conn)? {
        apply_v6(conn)?;
    }
    if !v7_is_complete(conn)? {
        apply_v7(conn)?;
    }
    if !v8_is_complete(conn)? {
        apply_v8(conn)?;
    }
    if !crate::devicesync::schema::is_complete(conn)? {
        crate::devicesync::schema::install(conn)?;
    }
    set_user_version(conn, TARGET_VERSION)?;
    Ok(())
}

/// Would `open` change this database's structure? Asks exactly the questions
/// `apply_migrations` asks, without acting on the answers, so the backup taken
/// at launch can be labelled `pre-migration`. A new migration must be added
/// here as well as there.
pub fn migration_pending(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(user_version(conn)? < 1
        || !v2_is_complete(conn)?
        || !v3_is_complete(conn)?
        || !v4_is_complete(conn)?
        || !v5_is_complete(conn)?
        || !v6_is_complete(conn)?
        || !v7_is_complete(conn)?
        || !v8_is_complete(conn)?
        || !crate::devicesync::schema::is_complete(conn)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v8_adds_a_removed_flag_that_starts_off() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE bank_transactions DROP COLUMN removed;
             INSERT INTO accounts (id,name,type,created_at) VALUES (92,'Card','credit','2026-10-01');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (92,'t','2026-10-01',-4,'Coffee');",
        ).unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();
        apply_migrations(&conn).unwrap();

        let removed: i64 = conn.query_row("SELECT removed FROM bank_transactions WHERE external_id='t'", [], |r| r.get(0)).unwrap();
        assert_eq!(removed, 0);
        assert!(!migration_pending(&conn).unwrap());
    }

    #[test]
    fn v7_adds_notes_and_drops_pending_rows_dated_1970() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE bank_transactions DROP COLUMN note;
             INSERT INTO accounts (id,name,type,created_at) VALUES (91,'Card','credit','2026-10-01');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,pending)
               VALUES (91,'stale','1970-01-01',-4,'Coffee',1), (91,'real','2026-10-01',-4,'Coffee',0);",
        ).unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();

        assert!(column_exists(&conn, "bank_transactions", "note").unwrap());
        let left: Vec<String> = conn.prepare("SELECT external_id FROM bank_transactions WHERE account_id=91")
            .unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(left, vec!["real".to_string()]);
    }

    #[test]
    fn v6_re_sorts_existing_rows_and_reviews_only_the_categorised_ones() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        // Undo v6 to stand in for a v5 database with rows from an older build.
        conn.execute_batch(
            "ALTER TABLE bank_transactions DROP COLUMN reviewed;
             INSERT INTO accounts (id,name,type,created_at) VALUES (90,'Card','credit','2026-10-01');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee)
               VALUES (90,'shop','2026-10-01',-10,'TARGET','Target'),
                      (90,'mystery','2026-10-02',-10,'ZQX','Zqx Holdings');",
        ).unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();

        let get = |ext: &str| -> (Option<String>, i64) {
            conn.query_row(
                "SELECT c.name, b.reviewed FROM bank_transactions b
                 LEFT JOIN categories c ON c.id=b.category_id WHERE b.external_id=?1",
                [ext], |r| Ok((r.get(0)?, r.get(1)?)),
            ).unwrap()
        };
        assert_eq!(get("shop"), (Some("Shopping".into()), 1));
        assert_eq!(get("mystery"), (None, 0), "only what is still uncategorised waits for review");
        assert!(!migration_pending(&conn).unwrap());
    }

    #[test]
    fn v6_run_twice_changes_nothing() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        apply_migrations(&conn).unwrap();
        assert!(column_exists(&conn, "bank_transactions", "reviewed").unwrap());
    }

    #[test]
    fn a_fully_migrated_database_has_no_migration_pending() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        assert!(!migration_pending(&conn).unwrap());
    }

    #[test]
    fn a_v1_database_has_a_migration_pending() {
        assert!(migration_pending(&v1_database()).unwrap());
    }

    #[test]
    fn an_empty_database_has_a_migration_pending() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(migration_pending(&conn).unwrap());
    }

    #[test]
    fn a_database_missing_a_market_table_has_a_migration_pending() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch("DROP TABLE index_quotes;").unwrap();
        assert!(migration_pending(&conn).unwrap());
    }

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
        apply_v2(&conn).unwrap();
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
    fn repairs_a_database_stamped_v5_that_is_missing_a_market_table() {
        // The same failure mode as the v3 and v4 mis-stamps: a version that ran
        // ahead of the schema. A migration interrupted part-way leaves exactly
        // this state, and the stamp alone would never let it repair itself.
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch("DROP TABLE index_quotes;").unwrap();
        conn.execute_batch("PRAGMA user_version = 5;").unwrap();

        apply_migrations(&conn).unwrap();

        assert!(table_exists(&conn, "index_quotes").unwrap(), "the dropped table must be restored");
    }

    #[test]
    fn a_real_v8_database_upgrades_to_v9_with_keys() {
        let conn = db_at_v9_with_a_simplefin_row();
        conn.execute_batch(
            "DROP INDEX accounts_sync_key; DROP INDEX categories_sync_key;
             DROP INDEX bank_transactions_sync_key; DROP INDEX transactions_sync_key;
             DROP VIEW sync_on;
             DROP TABLE sync_meta; DROP TABLE sync_outbox; DROP TABLE sync_clock;
             DROP TABLE sync_files_applied; DROP TABLE sync_pending;
             ALTER TABLE accounts DROP COLUMN sync_key;
             ALTER TABLE categories DROP COLUMN sync_key;
             ALTER TABLE bank_transactions DROP COLUMN sync_key;
             ALTER TABLE transactions DROP COLUMN sync_key;
             PRAGMA user_version = 8;",
        )
        .unwrap();
        assert!(!crate::devicesync::schema::is_complete(&conn).unwrap());
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TARGET_VERSION);
        assert!(crate::devicesync::schema::is_complete(&conn).unwrap());
        let key: String = conn
            .query_row("SELECT sync_key FROM bank_transactions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(key, "sf:ACT-1|TRN-1");
        assert!(!migration_pending(&conn).unwrap());
    }

    fn db_at_v9_with_a_simplefin_row() -> Connection {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES ((SELECT id FROM accounts WHERE external_id='ACT-1'),'TRN-1','2026-10-01',-5,'Coffee');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_v1_database_migrated_forward_ends_at_the_target_version() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TARGET_VERSION);
    }
    #[test]
    fn survives_a_version_stamp_that_went_backwards() {
        // Exactly what a downgrade-then-upgrade does: the schema is fully
        // migrated, but the stamp says otherwise. Re-running ALTER TABLE ADD
        // COLUMN against an existing column is a hard error in SQLite, so the
        // version must never be what decides whether a migration runs.
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch("PRAGMA user_version = 3;").unwrap();

        apply_migrations(&conn).expect("a backwards stamp must not crash the app");

        assert_eq!(hidden_of(&conn, "Old"), 0, "the column must survive untouched");
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TARGET_VERSION, "and the stamp must be put right");
    }

    #[test]
    fn survives_a_stamp_that_went_all_the_way_back_to_v1() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch("PRAGMA user_version = 1;").unwrap();

        // v2 adds columns the same way v4 does, so it carries the same hazard.
        apply_migrations(&conn).expect("re-running v2 on migrated columns must not crash");

        let source: String = conn.query_row("SELECT source FROM accounts WHERE name='Old'", [], |r| r.get(0)).unwrap();
        assert_eq!(source, "manual");
        assert_eq!(hidden_of(&conn, "Old"), 0);
    }

    #[test]
    fn a_hidden_flag_is_not_reset_by_a_backwards_stamp() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute("UPDATE accounts SET hidden=1 WHERE name='Old'", []).unwrap();
        conn.execute_batch("PRAGMA user_version = 2;").unwrap();

        apply_migrations(&conn).unwrap();

        assert_eq!(hidden_of(&conn, "Old"), 1, "a repair must not silently unhide accounts");
    }
    #[test]
    fn foreign_keys_are_back_on_after_the_rebuild() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        let on: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(on, 1);
    }

    #[test]
    fn v5_creates_market_tables_and_is_idempotent() {
        let conn = open_in_memory().unwrap();
        for t in V5_TABLES {
            assert!(table_exists(&conn, t).unwrap(), "{t} should exist");
        }
        // Running the migration a second time must not error. This is the rule
        // db.rs already enforces: a stamp can be wrong in both directions, so
        // every migration has to survive being re-applied.
        apply_v5(&conn).unwrap();
        apply_migrations(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TARGET_VERSION);
    }

    #[test]
    fn news_items_dedupe_on_guid_and_cascade_with_the_security() {
        let conn = open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
        let insert = "INSERT INTO news_items (security_id,guid,title,url,published,fetched_at)
                      VALUES (1,'g1','A','http://x','2026-09-10T00:00:00Z','2026-09-10T00:00:00Z')
                      ON CONFLICT(security_id,guid) DO UPDATE SET title=excluded.title";
        conn.execute(insert, []).unwrap();
        conn.execute(insert, []).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM news_items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the same guid must not duplicate");

        conn.execute("DELETE FROM securities WHERE id=1", []).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM news_items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "news must go with its security");
    }
}
