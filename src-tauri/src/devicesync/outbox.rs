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

/// Everything waiting to be sent, oldest first. `None` when there is nothing.
pub fn take(conn: &Connection) -> rusqlite::Result<Option<Taken>> {
    let mut stmt = conn.prepare("SELECT seq, tbl, key, field, value, at FROM sync_outbox ORDER BY seq")?;
    let rows = stmt.query_map([], |r| {
        // Only SQL NULL means "deleted". Text that won't parse is damage, and
        // sending it as a delete would remove the row on the other computer.
        let value = match r.get::<_, Option<String>>(4)? {
            None => serde_json::Value::Null,
            Some(v) => serde_json::from_str(&v).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
            })?,
        };
        Ok((
            r.get::<_, i64>(0)?,
            Change {
                tbl: r.get(1)?,
                key: r.get(2)?,
                field: r.get(3)?,
                value,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::devicesync::meta;

    fn recording() -> Connection {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
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
        let recorded: (i64, String) = conn
            .query_row(
                "SELECT at, device FROM sync_clock WHERE tbl=?1 AND key=?2 AND field=?3",
                rusqlite::params![c.tbl, c.key, c.field],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(recorded, (c.at, "pc".to_string()));
        assert!(!clock::is_newer(&conn, &c.tbl, &c.key, &c.field, c.at - 1, "pc").unwrap());
    }

    #[test]
    fn a_deleted_row_takes_as_null() {
        let conn = recording();
        conn.execute("DELETE FROM categories WHERE name='Dining'", []).unwrap();
        let taken = take(&conn).unwrap().unwrap();
        let del = taken.changes.iter().find(|c| c.field == "_row").unwrap();
        assert_eq!(del.value, serde_json::Value::Null);
    }

    #[test]
    fn a_corrupt_value_is_an_error_not_a_delete() {
        let conn = recording();
        conn.execute(
            "INSERT INTO sync_outbox (tbl, key, field, value, at) VALUES ('categories', 'cat:X', '_row', 'not json', 1)",
            [],
        )
        .unwrap();
        assert!(take(&conn).is_err());
    }
}
