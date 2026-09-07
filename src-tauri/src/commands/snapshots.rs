use crate::db::Db;
use crate::models::Snapshot;
use rusqlite::Connection;

pub fn record(conn: &Connection, date: &str, total_value: f64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO snapshots (date,total_value) VALUES (?1,?2)
         ON CONFLICT(date) DO UPDATE SET total_value=excluded.total_value",
        rusqlite::params![date, total_value],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Snapshot>> {
    let mut stmt = conn.prepare("SELECT date,total_value FROM snapshots ORDER BY date")?;
    let rows = stmt.query_map([], |r| Ok(Snapshot { date: r.get(0)?, total_value: r.get(1)? }))?;
    rows.collect()
}

#[tauri::command]
pub fn snapshots_list(db: tauri::State<Db>) -> Result<Vec<Snapshot>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snapshots_record(db: tauri::State<Db>, date: String, total_value: f64) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    record(&conn, &date, total_value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn record_upserts_same_date() {
        let conn = db::open_in_memory().unwrap();
        record(&conn, "2026-01-01", 100.0).unwrap();
        record(&conn, "2026-01-01", 150.0).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].total_value, 150.0);
    }
}
