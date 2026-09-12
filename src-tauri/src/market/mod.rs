//! The Markets module: headlines, earnings and index levels for held
//! securities. Laid out like `simplefin/` — HTTP, pure parsing and SQLite are
//! separate files, so the parsing is fixture-testable with no network.
pub mod benchmarks;
pub mod indices;
pub mod nasdaq;
pub mod nasdaq_parse;
pub mod profile;
pub mod rss;
pub mod store;
pub mod yahoo_news;

use rusqlite::Connection;
use serde::Serialize;
use yahoo_news::{NewsProvider, YahooNews};

/// How many headlines to keep and show per company.
pub const NEWS_PER_SECURITY: i64 = 3;
/// How many weekdays ahead the earnings calendar reaches.
const CALENDAR_DAYS: usize = 10;
/// A company's sector and quote type barely change; once a week is plenty.
const PROFILE_MAX_AGE_DAYS: i64 = 7;
/// Earnings move once a quarter; once a day is plenty.
const EARNINGS_MAX_AGE_DAYS: i64 = 1;

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct MarketRefreshReport {
    pub news_added: usize,
    pub profiles_updated: usize,
    pub earnings_updated: usize,
    pub indices_updated: usize,
    /// One entry per failed ticker. A failure is never fatal: the screen
    /// renders from cache, so a partial refresh is better than none.
    pub errors: Vec<String>,
}

/// Whole days between two RFC 3339 stamps. An unparseable stamp reads as
/// ancient, so a bad value causes a refetch rather than a permanent skip.
fn age_days(then: &str, now: &str) -> i64 {
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (parse(then), parse(now)) {
        (Some(a), Some(b)) => (b - a).num_days(),
        _ => i64::MAX,
    }
}

/// Held securities worth a news request: equities, plus anything whose profile
/// has not been fetched yet, so a first run is not stuck with nothing to do.
pub fn news_targets(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let held = store::tracked_securities(conn)?;
    let profiles = store::list_profiles(conn)?;
    Ok(held
        .into_iter()
        .filter(|(id, _)| {
            match profiles.iter().find(|p| p.security_id == *id) {
                Some(p) => p.quote_type.as_deref() == Some("EQUITY"),
                None => true,
            }
        })
        .collect())
}

/// Refresh everything. Each ticker is isolated, as `simplefin::sync` isolates
/// each account: one failure is recorded and the rest carry on.
pub fn refresh_all(conn: &Connection) -> MarketRefreshReport {
    let mut report = MarketRefreshReport::default();
    let now = chrono::Utc::now().to_rfc3339();

    // Profiles first: they decide which securities get news at all. A profile
    // barely changes, so it is refetched weekly — refetching all of them on
    // every 30-minute news poll would multiply the request budget for nothing.
    match store::tracked_securities(conn) {
        Ok(held) => {
            for (id, ticker) in held {
                let fresh = match store::profile_updated_at(conn, id) {
                    Ok(Some(t)) => age_days(&t, &now) < PROFILE_MAX_AGE_DAYS,
                    _ => false,
                };
                if fresh {
                    continue;
                }
                match profile::fetch_profile(&ticker) {
                    Ok(Some(p)) => {
                        if store::upsert_profile(conn, id, &p, &now).is_ok() {
                            report.profiles_updated += 1;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => report.errors.push(format!("{ticker} profile: {e}")),
                }
            }
        }
        Err(e) => report.errors.push(format!("held securities: {e}")),
    }

    match news_targets(conn) {
        Ok(targets) => {
            for (id, ticker) in targets {
                match YahooNews.headlines(&ticker) {
                    Ok(items) => match store::upsert_news(conn, id, &items, &now) {
                        Ok(n) => report.news_added += n,
                        Err(e) => report.errors.push(format!("{ticker} news store: {e}")),
                    },
                    Err(e) => report.errors.push(format!("{ticker} news: {e}")),
                }
            }
        }
        Err(e) => report.errors.push(format!("news targets: {e}")),
    }

    // Earnings move once a quarter, so once a day is plenty. This is the
    // difference between roughly 6 requests per poll and roughly 27.
    let earnings_stale = match store::earnings_last_updated(conn) {
        Ok(Some(t)) => age_days(&t, &now) >= EARNINGS_MAX_AGE_DAYS,
        _ => true,
    };
    if earnings_stale {
        report.earnings_updated = refresh_earnings(conn, &now, &mut report.errors);
    }

    for (symbol, _) in indices::INDICES {
        match indices::fetch_closes(symbol) {
            Ok(closes) => {
                if store::upsert_index_closes(conn, symbol, &closes).is_ok() {
                    report.indices_updated += 1;
                }
            }
            Err(e) => report.errors.push(format!("{symbol}: {e}")),
        }
    }

    report
}

/// Store a run of benchmark closes and report how many rows the table now
/// holds. Split from `backfill_benchmark` so the storage half is testable
/// without a network call.
pub fn store_benchmark_history(
    conn: &Connection,
    closes: &[(String, f64)],
) -> rusqlite::Result<usize> {
    store::upsert_index_closes(conn, indices::BENCHMARK, closes)?;
    Ok(store::index_history_depth(conn, indices::BENCHMARK)? as usize)
}

/// Download two years of benchmark closes. Run once after upgrade, never on a
/// timer — the ordinary market refresh keeps the last few days current.
pub fn backfill_benchmark(conn: &Connection) -> Result<usize, String> {
    let closes = indices::fetch_history(indices::BENCHMARK).map_err(|e| e.to_string())?;
    store_benchmark_history(conn, &closes).map_err(|e| e.to_string())
}

/// The calendar is fetched by date for the whole market and intersected with
/// held tickers locally — one request per day rather than one per holding.
/// Per-company surprise is then fetched only for companies actually held.
fn refresh_earnings(conn: &Connection, now: &str, errors: &mut Vec<String>) -> usize {
    let Ok(targets) = news_targets(conn) else { return 0 };
    if targets.is_empty() {
        return 0;
    }
    let mut updated = 0usize;

    let today = chrono::Utc::now().date_naive();
    for date in nasdaq::upcoming_weekdays(today, CALENDAR_DAYS) {
        match nasdaq::calendar_for(&date) {
            Ok(rows) => {
                for (id, ticker) in &targets {
                    for row in rows.iter().filter(|r| &r.symbol == ticker) {
                        if let Ok(n) = store::upsert_earnings(conn, *id, std::slice::from_ref(row), now) {
                            updated += n;
                        }
                    }
                }
            }
            Err(e) => errors.push(format!("calendar {date}: {e}")),
        }
    }

    for (id, ticker) in &targets {
        match nasdaq::surprise_for(ticker) {
            Ok(rows) => match store::upsert_earnings(conn, *id, &rows, now) {
                Ok(n) => updated += n,
                Err(e) => errors.push(format!("{ticker} earnings store: {e}")),
            },
            Err(e) => errors.push(format!("{ticker} surprise: {e}")),
        }
    }
    updated
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn held_security(conn: &Connection, ticker: &str) {
        conn.execute(
            "INSERT INTO securities (ticker,type,currency) VALUES (?1,'stock','USD')",
            [ticker],
        )
        .unwrap();
        let id: i64 = conn
            .query_row("SELECT id FROM securities WHERE ticker=?1", [ticker], |r| r.get(0))
            .unwrap();
        conn.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (1,?1,10,100,120,'2026-09-10')",
            [id],
        )
        .unwrap();
    }

    fn with_account(conn: &Connection) {
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
             VALUES ('B','brokerage','USD','2026-01-01','simplefin','x')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn a_refresh_report_starts_empty_and_collects_errors() {
        let mut report = MarketRefreshReport::default();
        assert_eq!(report.news_added, 0);
        report.errors.push("MU: timed out".into());
        assert_eq!(report.errors.len(), 1);
    }

    #[test]
    fn age_days_treats_an_unparseable_stamp_as_ancient_so_it_refetches() {
        assert_eq!(age_days("2026-09-03T00:00:00Z", "2026-09-10T00:00:00Z"), 7);
        assert_eq!(age_days("2026-09-10T00:00:00Z", "2026-09-10T06:00:00Z"), 0);
        assert_eq!(age_days("rubbish", "2026-09-10T00:00:00Z"), i64::MAX);
    }

    #[test]
    fn equities_are_the_only_securities_worth_a_news_request() {
        let conn = db::open_in_memory().unwrap();
        with_account(&conn);
        held_security(&conn, "MU");
        held_security(&conn, "SWPPX");

        let equity = profile::ParsedProfile {
            long_name: Some("Micron".into()),
            sector: Some("Technology".into()),
            quote_type: Some("EQUITY".into()),
        };
        let fund = profile::ParsedProfile {
            long_name: Some("Schwab S&P 500".into()),
            sector: None,
            quote_type: Some("MUTUALFUND".into()),
        };
        store::upsert_profile(&conn, 1, &equity, "2026-09-10T00:00:00Z").unwrap();
        store::upsert_profile(&conn, 2, &fund, "2026-09-10T00:00:00Z").unwrap();

        let targets = news_targets(&conn).unwrap();
        assert_eq!(
            targets,
            vec![(1, "MU".to_string())],
            "an index fund has no company news to fetch"
        );
    }

    #[test]
    fn a_security_with_no_profile_yet_is_still_worth_asking_about() {
        let conn = db::open_in_memory().unwrap();
        with_account(&conn);
        held_security(&conn, "MU");
        // No profile row yet — the first refresh must not skip it for ever.
        assert_eq!(news_targets(&conn).unwrap(), vec![(1, "MU".to_string())]);
    }

    #[test]
    fn an_etf_is_treated_as_a_fund_just_like_a_mutual_fund() {
        let conn = db::open_in_memory().unwrap();
        with_account(&conn);
        held_security(&conn, "VOO");
        let etf = profile::ParsedProfile {
            long_name: Some("Vanguard S&P 500 ETF".into()),
            sector: None,
            quote_type: Some("ETF".into()),
        };
        store::upsert_profile(&conn, 1, &etf, "2026-09-10T00:00:00Z").unwrap();
        assert!(news_targets(&conn).unwrap().is_empty());
    }
}

#[cfg(test)]
mod backfill_tests {
    use super::*;
    use crate::db;

    #[test]
    fn a_backfill_stores_every_close_it_is_given_and_counts_them() {
        let conn = db::open_in_memory().unwrap();
        // Distinct dates across four months, so the count is a real count.
        let closes: Vec<(String, f64)> = (0..120)
            .map(|i| (format!("2025-{:02}-{:02}", (i / 30) + 1, (i % 30) + 1), 7000.0 + i as f64))
            .collect();

        let stored = store_benchmark_history(&conn, &closes).unwrap();

        assert_eq!(stored, 120, "every distinct date is a row");
        assert_eq!(
            stored,
            store::index_history_depth(&conn, indices::BENCHMARK).unwrap() as usize,
        );
    }

    #[test]
    fn a_second_backfill_replaces_rows_rather_than_doubling_them() {
        let conn = db::open_in_memory().unwrap();
        let closes = [("2025-01-02".to_string(), 7000.0), ("2025-01-03".to_string(), 7050.0)];

        store_benchmark_history(&conn, &closes).unwrap();
        let stored = store_benchmark_history(&conn, &closes).unwrap();

        assert_eq!(stored, 2, "(symbol, date) is the primary key; re-running is safe");
    }

    #[test]
    fn a_backfill_does_not_create_a_security_for_the_benchmark() {
        let conn = db::open_in_memory().unwrap();
        store_benchmark_history(&conn, &[("2025-01-02".into(), 7000.0)]).unwrap();

        let securities: i64 = conn
            .query_row("SELECT count(*) FROM securities", [], |r| r.get(0))
            .unwrap();
        assert_eq!(securities, 0);
    }
}
