use crate::db::Db;
use crate::models::Security;
use rusqlite::Connection;

/// Get an existing security by ticker or create it. Tickers are upper-cased.
pub fn get_or_create(conn: &Connection, ticker: &str, name: Option<&str>, type_: &str)
    -> rusqlite::Result<Security> {
    let t = ticker.trim().to_uppercase();
    conn.execute(
        "INSERT INTO securities (ticker,name,type,currency) VALUES (?1,?2,?3,'USD')
         ON CONFLICT(ticker) DO NOTHING",
        rusqlite::params![t, name, type_],
    )?;
    conn.query_row(
        "SELECT id,ticker,name,type,currency FROM securities WHERE ticker=?1",
        [t],
        row_to_security,
    )
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Security>> {
    let mut stmt = conn.prepare("SELECT id,ticker,name,type,currency FROM securities ORDER BY ticker")?;
    let rows = stmt.query_map([], row_to_security)?;
    rows.collect()
}

fn row_to_security(r: &rusqlite::Row) -> rusqlite::Result<Security> {
    Ok(Security { id: r.get(0)?, ticker: r.get(1)?, name: r.get(2)?, type_: r.get(3)?, currency: r.get(4)? })
}

#[tauri::command]
pub fn securities_list(db: tauri::State<Db>) -> Result<Vec<Security>, String> {
    let conn = db.0.lock().unwrap();
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn securities_get_or_create(db: tauri::State<Db>, ticker: String, name: Option<String>, kind: String)
    -> Result<Security, String> {
    let conn = db.0.lock().unwrap();
    get_or_create(&conn, &ticker, name.as_deref(), &kind).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn get_or_create_is_idempotent_and_uppercases() {
        let conn = db::open_in_memory().unwrap();
        let a = get_or_create(&conn, "voo", Some("Vanguard S&P 500"), "etf").unwrap();
        let b = get_or_create(&conn, "VOO", None, "etf").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(a.ticker, "VOO");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
}
