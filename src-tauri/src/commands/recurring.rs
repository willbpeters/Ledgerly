//! Bills the owner has said are not recurring. Spotting bills happens in
//! TypeScript (`src/domain/recurring.ts`); Rust only remembers the keys it
//! should skip, as opaque strings.
use crate::db::Db;
use rusqlite::{params, Connection};

/// Every dismissed key, alphabetically.
pub fn dismissed(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT payee_key FROM recurring_dismissed ORDER BY payee_key")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    rows.collect()
}

/// Remember that `key` is not a bill. Dismissing again keeps the first date.
/// The key is stored exactly as given: it has to match what `recurringKey`
/// makes next time, so it is not trimmed or lowercased here.
pub fn dismiss(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    // A blank key is meaningless: detection never produces one.
    if key.trim().is_empty() {
        return Err(rusqlite::Error::InvalidParameterName("an empty recurring key".into()));
    }
    conn.execute(
        "INSERT INTO recurring_dismissed (payee_key, dismissed_at) VALUES (?1, ?2)
         ON CONFLICT(payee_key) DO NOTHING",
        params![key, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

/// Put a dismissed bill back on the list.
pub fn undismiss(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM recurring_dismissed WHERE payee_key=?1", [key])?;
    Ok(())
}

#[tauri::command]
pub fn recurring_dismissed_list(db: tauri::State<Db>) -> Result<Vec<String>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    dismissed(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recurring_dismiss(db: tauri::State<Db>, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("There is nothing to dismiss.".into());
    }
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    dismiss(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recurring_undismiss(db: tauri::State<Db>, key: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    undismiss(&conn, &key).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn a_dismissed_key_is_listed_until_it_is_undismissed() {
        let conn = db::open_in_memory().unwrap();
        assert!(dismissed(&conn).unwrap().is_empty());

        dismiss(&conn, "netflix").unwrap();
        dismiss(&conn, "gym").unwrap();
        assert_eq!(dismissed(&conn).unwrap(), vec!["gym".to_string(), "netflix".to_string()]);

        undismiss(&conn, "netflix").unwrap();
        assert_eq!(dismissed(&conn).unwrap(), vec!["gym".to_string()]);
    }

    #[test]
    fn dismissing_twice_keeps_one_row() {
        let conn = db::open_in_memory().unwrap();
        dismiss(&conn, "netflix").unwrap();
        dismiss(&conn, "netflix").unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM recurring_dismissed", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn dismissing_twice_keeps_the_first_date() {
        let conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO recurring_dismissed (payee_key, dismissed_at) VALUES ('netflix', '2020-01-01T00:00:00+00:00')",
            [],
        )
        .unwrap();
        dismiss(&conn, "netflix").unwrap();
        let at: String = conn
            .query_row("SELECT dismissed_at FROM recurring_dismissed WHERE payee_key='netflix'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(at, "2020-01-01T00:00:00+00:00");
    }

    #[test]
    fn an_empty_key_is_refused() {
        let conn = db::open_in_memory().unwrap();
        assert!(dismiss(&conn, "  ").is_err());
        assert!(dismissed(&conn).unwrap().is_empty());
    }

    #[test]
    fn undismissing_a_key_that_is_not_there_is_harmless() {
        let conn = db::open_in_memory().unwrap();
        undismiss(&conn, "never-dismissed").unwrap();
    }
}
