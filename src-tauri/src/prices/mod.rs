pub mod stooq;

use crate::db::Db;
use crate::commands::prices::upsert;

/// A source of security prices. v1 has one keyless implementation (Stooq);
/// keyed providers can implement this later without touching callers.
pub trait PriceProvider {
    /// Fetch recent (date, close) rows for a ticker, oldest first.
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>>;
    fn name(&self) -> &'static str;
}

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
        let conn = db.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, ticker FROM securities").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let mut updated = 0usize;
    for (sid, ticker) in tickers {
        match provider.recent(&ticker) {
            Ok(rows) if !rows.is_empty() => {
                let conn = db.0.lock().unwrap();
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
