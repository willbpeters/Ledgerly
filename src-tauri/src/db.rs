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
