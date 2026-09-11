use crate::db::Db;
use rusqlite::Connection;

pub fn upsert(conn: &Connection, security_id: i64, date: &str, close: f64, source: &str)
    -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO prices (security_id,date,close,source) VALUES (?1,?2,?3,?4)
         ON CONFLICT(security_id,date) DO UPDATE SET close=excluded.close, source=excluded.source",
        rusqlite::params![security_id, date, close, source],
    )?;
    Ok(())
}

/// Latest close per security (most recent date), returned as (security_id, close).
pub fn latest_all(conn: &Connection) -> rusqlite::Result<Vec<(i64, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT p.security_id, p.close FROM prices p
         JOIN (SELECT security_id, MAX(date) d FROM prices GROUP BY security_id) m
           ON p.security_id=m.security_id AND p.date=m.d")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Previous close per security (second most recent date), for day-change math.
pub fn previous_all(conn: &Connection) -> rusqlite::Result<Vec<(i64, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT security_id, close FROM (
            SELECT security_id, date, close,
                   ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY date DESC) rn
            FROM prices)
         WHERE rn = 2")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Every stored close from `from` onward, oldest first, as
/// (security_id, date, close). The chart rebuilds its history from these.
pub fn history_since(conn: &Connection, from: &str) -> rusqlite::Result<Vec<(i64, String, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT security_id, date, close FROM prices WHERE date >= ?1 ORDER BY date, security_id")?;
    let rows = stmt.query_map([from], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

#[tauri::command]
pub fn prices_history(db: tauri::State<Db>, from: String) -> Result<Vec<(i64, String, f64)>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    history_since(&conn, &from).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prices_latest(db: tauri::State<Db>) -> Result<Vec<(i64, f64)>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    latest_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prices_previous(db: tauri::State<Db>) -> Result<Vec<(i64, f64)>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    previous_all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prices_set_manual(db: tauri::State<Db>, security_id: i64, date: String, close: f64)
    -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    upsert(&conn, security_id, &date, close, "manual").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prices_refresh(db: tauri::State<Db>) -> Result<usize, String> {
    crate::prices::refresh_all(&db, &crate::prices::YahooProvider)
}

/// Download the full daily history for every security. Run rarely — see
/// `backfill_all`.
#[tauri::command]
pub fn prices_backfill(db: tauri::State<Db>) -> Result<usize, String> {
    crate::prices::backfill_all(&db, &crate::prices::YahooProvider)
}

/// How many days of history the best-covered security has. The frontend uses
/// this to decide whether a backfill is needed, so it is not re-downloaded on
/// every launch.
#[tauri::command]
pub fn prices_history_depth(db: tauri::State<Db>) -> Result<i64, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.query_row(
        "SELECT COALESCE(MAX(n), 0) FROM (SELECT count(*) n FROM prices GROUP BY security_id)",
        [], |r| r.get(0),
    ).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn history_since_returns_only_dates_in_range_oldest_first() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,name,type,currency) VALUES ('VTI',NULL,'etf','USD')", []).unwrap();
        let sid: i64 = conn.query_row("SELECT id FROM securities WHERE ticker='VTI'", [], |r| r.get(0)).unwrap();
        upsert(&conn, sid, "2026-01-01", 90.0, "test").unwrap();
        upsert(&conn, sid, "2026-06-01", 100.0, "test").unwrap();
        upsert(&conn, sid, "2026-09-01", 110.0, "test").unwrap();

        let rows = history_since(&conn, "2026-05-01").unwrap();

        assert_eq!(rows.len(), 2, "anything older than the window is left behind");
        assert_eq!(rows[0], (sid, "2026-06-01".to_string(), 100.0));
        assert_eq!(rows[1], (sid, "2026-09-01".to_string(), 110.0));
    }

    #[test]
    fn latest_and_previous_pick_right_rows() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,name,type,currency) VALUES ('AAPL',NULL,'stock','USD')", []).unwrap();
        let sid: i64 = conn.query_row("SELECT id FROM securities WHERE ticker='AAPL'", [], |r| r.get(0)).unwrap();
        upsert(&conn, sid, "2026-01-01", 100.0, "stooq").unwrap();
        upsert(&conn, sid, "2026-01-02", 110.0, "stooq").unwrap();
        assert_eq!(latest_all(&conn).unwrap(), vec![(sid, 110.0)]);
        assert_eq!(previous_all(&conn).unwrap(), vec![(sid, 100.0)]);
    }
}
