pub mod stooq;
pub mod yahoo;

use crate::db::Db;
use crate::commands::prices::upsert;

/// A source of security prices. Keyless implementations live here (Yahoo is the
/// active one); keyed providers can implement this later without touching callers.
pub trait PriceProvider {
    /// Fetch recent (date, close) rows for a ticker, oldest first.
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>>;
    fn name(&self) -> &'static str;
}

/// Keyless provider backed by Yahoo Finance's public chart endpoint. Requires a
/// browser-like User-Agent or Yahoo returns 429/empty.
pub struct YahooProvider;

impl PriceProvider for YahooProvider {
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1")
            .build()?;
        let body = client.get(yahoo::chart_url(ticker)).send()?.text()?;
        Ok(yahoo::parse_chart_json(&body))
    }
    fn name(&self) -> &'static str { "yahoo" }
}

/// Legacy keyless provider. Kept behind the same trait, but Stooq now serves a
/// JavaScript anti-bot challenge to plain HTTP clients, so it is not the active
/// provider — retained for reference / future fallback.
#[allow(dead_code)]
pub struct StooqProvider;

impl PriceProvider for StooqProvider {
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>> {
        let url = stooq::daily_url(ticker);
        let body = reqwest::blocking::get(url)?.text()?;
        Ok(stooq::parse_daily_csv(&body))
    }
    fn name(&self) -> &'static str { "stooq" }
}

/// Fetch prices for every security and store the latest two closes each.
/// Returns the count of securities successfully updated. Never fails the whole
/// run because one ticker errored.
pub fn refresh_all(db: &Db, provider: &dyn PriceProvider) -> Result<usize, String> {
    let tickers: Vec<(i64, String)> = {
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare("SELECT id, ticker FROM securities").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let mut updated = 0usize;
    for (sid, ticker) in tickers {
        match provider.recent(&ticker) {
            Ok(rows) if !rows.is_empty() => {
                let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
                for (date, close) in rows.iter().rev().take(2) {
                    let _ = upsert(&conn, sid, date, *close, provider.name());
                }
                updated += 1;
            }
            _ => { /* leave last-known price in place */ }
        }
    }
    Ok(updated)
}
