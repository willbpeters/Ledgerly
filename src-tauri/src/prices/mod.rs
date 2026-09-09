pub mod stooq;
pub mod yahoo;

use crate::db::Db;
use crate::commands::prices::upsert;

/// A source of security prices. Keyless implementations live here (Yahoo is the
/// active one); keyed providers can implement this later without touching callers.
pub trait PriceProvider {
    /// Fetch recent (date, close) rows for a ticker, oldest first.
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>>;
    /// Fetch a long run of daily closes, for the risk maths. Defaults to
    /// whatever `recent` gives, so a provider without history still works.
    fn history(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>> {
        self.recent(ticker)
    }
    fn name(&self) -> &'static str;
}

/// Keyless provider backed by Yahoo Finance's public chart endpoint. Requires a
/// browser-like User-Agent or Yahoo returns 429/empty.
pub struct YahooProvider;

impl YahooProvider {
    fn fetch(&self, ticker: &str, range: &str) -> anyhow::Result<Vec<(String, f64)>> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1")
            .build()?;
        let body = client.get(yahoo::chart_url(ticker, range)).send()?.text()?;
        Ok(yahoo::parse_chart_json(&body))
    }
}

impl PriceProvider for YahooProvider {
    fn recent(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>> {
        self.fetch(ticker, yahoo::RECENT_RANGE)
    }
    fn history(&self, ticker: &str) -> anyhow::Result<Vec<(String, f64)>> {
        self.fetch(ticker, yahoo::HISTORY_RANGE)
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

/// Store the full daily history for every security. Unlike `refresh_all` this
/// keeps every close it is given, which is what the risk maths needs; it is one
/// request per security, same as a refresh, so it is run rarely rather than on
/// the polling timer. Safe to re-run: prices upsert on (security_id, date).
pub fn backfill_all(db: &Db, provider: &dyn PriceProvider) -> Result<usize, String> {
    let tickers: Vec<(i64, String)> = {
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = conn.prepare("SELECT id, ticker FROM securities").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let mut filled = 0usize;
    for (sid, ticker) in tickers {
        match provider.history(&ticker) {
            Ok(rows) if !rows.is_empty() => {
                let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
                for (date, close) in &rows {
                    let _ = upsert(&conn, sid, date, *close, provider.name());
                }
                filled += 1;
            }
            // A ticker Yahoo does not know has no history; the risk module
            // reports it as excluded rather than guessing.
            _ => {}
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    /// Returns a fixed run of daily closes, so storage behaviour can be tested
    /// without touching the network.
    struct FakeProvider;
    const DAYS: &[(&str, f64)] = &[
        ("2026-09-01", 100.0), ("2026-09-02", 101.0), ("2026-09-03", 102.0),
        ("2026-09-04", 103.0), ("2026-09-05", 104.0),
    ];
    impl PriceProvider for FakeProvider {
        fn recent(&self, _t: &str) -> anyhow::Result<Vec<(String, f64)>> {
            Ok(DAYS.iter().map(|(d, c)| (d.to_string(), *c)).collect())
        }
        fn name(&self) -> &'static str { "fake" }
    }

    fn db_with_one_security() -> Db {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,name,type,currency) VALUES ('VTI',NULL,'etf','USD')", []).unwrap();
        Db(std::sync::Mutex::new(conn))
    }

    fn price_count(db: &Db) -> i64 {
        let conn = db.0.lock().unwrap();
        conn.query_row("SELECT count(*) FROM prices", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn the_ordinary_refresh_keeps_only_the_two_most_recent_closes() {
        let db = db_with_one_security();
        refresh_all(&db, &FakeProvider).unwrap();
        assert_eq!(price_count(&db), 2, "the 60s refresh must stay cheap");
    }

    #[test]
    fn backfill_stores_the_whole_history() {
        let db = db_with_one_security();
        backfill_all(&db, &FakeProvider).unwrap();
        assert_eq!(price_count(&db), DAYS.len() as i64);
    }

    #[test]
    fn backfill_can_be_run_again_without_duplicating_rows() {
        let db = db_with_one_security();
        backfill_all(&db, &FakeProvider).unwrap();
        backfill_all(&db, &FakeProvider).unwrap();
        assert_eq!(price_count(&db), DAYS.len() as i64);
    }

    #[test]
    fn backfill_reports_how_many_securities_it_filled() {
        let db = db_with_one_security();
        assert_eq!(backfill_all(&db, &FakeProvider).unwrap(), 1);
    }
}
