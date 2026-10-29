//! Last writer wins, per field. `sync_clock` holds the newest change seen for
//! each (table, key, field), whichever computer made it.
use rusqlite::{params, Connection, OptionalExtension};

/// Is a change made at `at` by `device` newer than anything recorded? Ties
/// between different devices go to the larger device id, so both computers
/// reach the same answer. A tie with the same device is newer: one device can
/// edit a field twice in a millisecond, and it sends them in order.
///
/// An edit only reaches `sync_clock` once its file is written, so an edit
/// still waiting in `sync_outbox` counts as this computer's entry too.
pub fn is_newer(conn: &Connection, tbl: &str, key: &str, field: &str, at: i64, device: &str) -> rusqlite::Result<bool> {
    let seen: Option<(i64, String)> = conn
        .query_row(
            "SELECT at, device FROM sync_clock WHERE tbl=?1 AND key=?2 AND field=?3",
            params![tbl, key, field],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((seen_at, seen_device)) = seen {
        if (at, device) < (seen_at, seen_device.as_str()) {
            return Ok(false);
        }
    }
    let unsent: Option<i64> = conn.query_row(
        "SELECT max(at) FROM sync_outbox WHERE tbl=?1 AND key=?2 AND field=?3",
        params![tbl, key, field],
        |r| r.get(0),
    )?;
    if let Some(unsent_at) = unsent {
        let me = super::meta::get(conn, "device")?.unwrap_or_default();
        if (at, device) < (unsent_at, me.as_str()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Remember a change, unless something newer is already recorded.
pub fn record(conn: &Connection, tbl: &str, key: &str, field: &str, at: i64, device: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_clock (tbl, key, field, at, device) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(tbl, key, field) DO UPDATE SET at=excluded.at, device=excluded.device
         WHERE excluded.at > sync_clock.at
            OR (excluded.at = sync_clock.at AND excluded.device >= sync_clock.device)",
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
        crate::budget::seed::test_categories(&conn);
        assert!(is_newer(&conn, "budgets", "cat:Dining|*", "_row", 5, "pc").unwrap());
    }

    #[test]
    fn an_older_change_is_not_newer_and_does_not_rewind_the_clock() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        record(&conn, "budgets", "k", "_row", 10, "pc").unwrap();
        assert!(!is_newer(&conn, "budgets", "k", "_row", 9, "laptop").unwrap());
        record(&conn, "budgets", "k", "_row", 9, "laptop").unwrap();
        assert!(is_newer(&conn, "budgets", "k", "_row", 11, "laptop").unwrap());
        // The same device at the same instant is its own later edit, not stale.
        assert!(is_newer(&conn, "budgets", "k", "_row", 10, "pc").unwrap());
        assert!(!is_newer(&conn, "budgets", "k", "_row", 9, "pc").unwrap());
    }

    #[test]
    fn a_tie_goes_to_the_larger_device_id() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        record(&conn, "budgets", "k", "_row", 10, "aaa").unwrap();
        assert!(is_newer(&conn, "budgets", "k", "_row", 10, "bbb").unwrap());
        assert!(!is_newer(&conn, "budgets", "k", "_row", 10, "000").unwrap());
    }

    #[test]
    fn a_larger_device_overwrites_a_tie_and_a_smaller_one_does_not() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        record(&conn, "budgets", "k", "_row", 10, "aaa").unwrap();
        record(&conn, "budgets", "k", "_row", 10, "bbb").unwrap();
        assert!(!is_newer(&conn, "budgets", "k", "_row", 10, "aaa").unwrap());
        record(&conn, "budgets", "k", "_row", 10, "aaa").unwrap();
        assert!(is_newer(&conn, "budgets", "k", "_row", 10, "bbb").unwrap());
        assert!(!is_newer(&conn, "budgets", "k", "_row", 10, "aaa").unwrap());
    }

    #[test]
    fn an_unsent_local_edit_beats_an_older_remote_one() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        crate::devicesync::meta::enable(&conn, "laptop").unwrap();
        conn.execute_batch("UPDATE categories SET colour='chart-9' WHERE name='Dining';").unwrap();
        let (tbl, key, field): (String, String, String) = conn
            .query_row("SELECT tbl, key, field FROM sync_outbox", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        assert!(!is_newer(&conn, &tbl, &key, &field, 1, "pc").unwrap());
        assert!(is_newer(&conn, &tbl, &key, &field, i64::MAX, "pc").unwrap());
    }
}
