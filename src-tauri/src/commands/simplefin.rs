use crate::db::Db;
use crate::models::SyncedHolding;
use crate::secrets;
use crate::simplefin::{client, sync, SyncReport};
use rusqlite::Connection;
use serde::Serialize;

const KEY: &str = "simplefin_access_url";

#[derive(Serialize)]
pub struct SimplefinStatus {
    pub connected: bool,
    pub last_synced_at: Option<String>,
}

pub fn list_holdings(conn: &Connection) -> rusqlite::Result<Vec<SyncedHolding>> {
    let mut stmt = conn.prepare(
        "SELECT id,account_id,security_id,shares,cost_basis,market_value,as_of
         FROM synced_holdings ORDER BY account_id, security_id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SyncedHolding {
            id: r.get(0)?, account_id: r.get(1)?, security_id: r.get(2)?,
            shares: r.get(3)?, cost_basis: r.get(4)?, market_value: r.get(5)?, as_of: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn last_synced_at(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT MAX(last_synced_at) FROM accounts WHERE source='simplefin'",
        [],
        |r| r.get::<_, Option<String>>(0),
    )
}

fn run_sync(db: &Db, access_url: &str) -> Result<SyncReport, String> {
    // Network first, without holding the DB lock.
    let set = client::fetch_accounts(access_url)?;
    let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    sync::apply(&mut conn, &set)
}

#[tauri::command]
pub fn simplefin_status(db: tauri::State<Db>) -> Result<SimplefinStatus, String> {
    let connected = secrets::get(KEY)?.is_some();
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let last = last_synced_at(&conn).map_err(|e| e.to_string())?;
    Ok(SimplefinStatus { connected, last_synced_at: last })
}

#[tauri::command]
pub fn simplefin_connect(db: tauri::State<Db>, setup_token: String) -> Result<SyncReport, String> {
    let access_url = client::claim(&setup_token)?;
    secrets::set(KEY, &access_url)?;
    run_sync(&db, &access_url)
}

#[tauri::command]
pub fn simplefin_sync(db: tauri::State<Db>) -> Result<SyncReport, String> {
    let access_url = secrets::get(KEY)?
        .ok_or_else(|| "SimpleFIN isn't connected yet. Paste a setup token in Settings to connect.".to_string())?;
    run_sync(&db, &access_url)
}

#[tauri::command]
pub fn simplefin_disconnect(db: tauri::State<Db>, delete_accounts: bool) -> Result<(), String> {
    secrets::delete(KEY)?;
    if delete_accounts {
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute("DELETE FROM accounts WHERE source='simplefin'", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn synced_holdings_list(db: tauri::State<Db>) -> Result<Vec<SyncedHolding>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list_holdings(&conn).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn list_holdings_and_last_synced() {
        let conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id,last_synced_at)
             VALUES ('B','brokerage','USD','2026-01-01','simplefin','x','2026-09-07T10:00:00Z')", []).unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('VTI','etf','USD')", []).unwrap();
        conn.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (1,1,10,2000,2500,'2026-09-07')", []).unwrap();
        let rows = list_holdings(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].shares, 10.0);
        assert_eq!(last_synced_at(&conn).unwrap().as_deref(), Some("2026-09-07T10:00:00Z"));
    }
}
