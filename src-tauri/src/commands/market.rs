//! Commands for the Markets screen. These return rows, never a finished
//! screen: assembly lives in `src/domain/market.ts` so it can be unit-tested
//! the way `derivePortfolio` is.
use crate::db::Db;
use crate::market::{self, store};

#[tauri::command]
pub fn market_news_list(db: tauri::State<Db>) -> Result<Vec<store::StoredNews>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::list_news(&conn, market::NEWS_PER_SECURITY).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn market_earnings_list(db: tauri::State<Db>) -> Result<Vec<store::EarningsEvent>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::list_earnings(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn market_profiles_list(
    db: tauri::State<Db>,
) -> Result<Vec<crate::market::profile::SecurityProfile>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::list_profiles(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn market_indices(db: tauri::State<Db>) -> Result<Vec<store::IndexQuote>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::list_index_quotes(&conn).map_err(|e| e.to_string())
}

/// A full refresh. Holds the database lock for the duration, which is fine
/// because it is driven by the screen's own timer, never by a render.
#[tauri::command]
pub fn market_refresh(db: tauri::State<Db>) -> Result<market::MarketRefreshReport, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    Ok(market::refresh_all(&conn))
}
