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
