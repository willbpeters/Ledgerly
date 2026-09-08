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
}
