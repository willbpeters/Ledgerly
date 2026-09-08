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

/// Re-fetch a few days either side of what we already hold, so a transaction
/// that was pending last time settles rather than lingering.
const OVERLAP_DAYS: i64 = 5;
/// How far back a first import reaches when the user has not chosen.
const DEFAULT_BACKFILL_DAYS: i64 = 365;

fn merge(total: &mut SyncReport, part: SyncReport) {
    // Accounts are counted once, not once per window.
    total.accounts_synced = total.accounts_synced.max(part.accounts_synced);
    total.holdings_synced = total.holdings_synced.max(part.holdings_synced);
    total.holdings_skipped = total.holdings_skipped.max(part.holdings_skipped);
    total.transactions_added += part.transactions_added;
    total.transactions_updated += part.transactions_updated;
    for e in part.errors {
        if !total.errors.contains(&e) {
            total.errors.push(e);
        }
    }
}

/// Pull transactions as well as balances.
///
/// `days_back` beyond SimpleFIN's 45-day guidance is walked in windows, oldest
/// first, because the bridge warns (and may one day refuse) on a wider ask.
fn run_sync_with_transactions(db: &Db, access_url: &str, days_back: i64) -> Result<SyncReport, String> {
    let now = chrono::Utc::now().timestamp();
    let window = client::MAX_WINDOW_DAYS * 86_400;
    let mut start = now - days_back.max(1) * 86_400;
    let mut total = SyncReport::default();

    loop {
        let end = start + window;
        let range = if end >= now {
            client::Range { since: start, until: None }
        } else {
            client::Range { since: start, until: Some(end) }
        };
        let set = client::fetch_accounts_in(access_url, range)?;
        {
            let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
            merge(&mut total, sync::apply(&mut conn, &set)?);
        }
        if end >= now {
            break;
        }
        start = end;
    }
    Ok(total)
}

/// How far back this sync needs to reach: from just before the newest
/// transaction we hold, or a full backfill when we hold none.
fn days_back_for_incremental(conn: &Connection) -> i64 {
    let newest: Option<String> = conn
        .query_row("SELECT MAX(posted) FROM bank_transactions", [], |r| r.get(0))
        .unwrap_or(None);
    let Some(newest) = newest else { return DEFAULT_BACKFILL_DAYS };
    let Ok(date) = chrono::NaiveDate::parse_from_str(&newest, "%Y-%m-%d") else {
        return DEFAULT_BACKFILL_DAYS;
    };
    let age = (chrono::Utc::now().date_naive() - date).num_days();
    (age + OVERLAP_DAYS).clamp(1, DEFAULT_BACKFILL_DAYS)
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
    let access_url = client::resolve_access_url(&setup_token)?;
    secrets::set(KEY, &access_url)?;
    // A first connect brings a year of history so budgeting has something to show.
    run_sync_with_transactions(&db, &access_url, DEFAULT_BACKFILL_DAYS)
}

#[tauri::command]
pub fn simplefin_sync(db: tauri::State<Db>) -> Result<SyncReport, String> {
    let access_url = access_url()?;
    let days = {
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        days_back_for_incremental(&conn)
    };
    run_sync_with_transactions(&db, &access_url, days)
}

/// Reach further back than the routine sync does, for someone who wants more
/// history than they started with.
#[tauri::command]
pub fn simplefin_backfill(db: tauri::State<Db>, days: i64) -> Result<SyncReport, String> {
    let access_url = access_url()?;
    run_sync_with_transactions(&db, &access_url, days.clamp(1, 2000))
}

fn access_url() -> Result<String, String> {
    secrets::get(KEY)?
        .ok_or_else(|| "SimpleFIN isn't connected yet. Paste a setup token in Settings to connect.".to_string())
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
