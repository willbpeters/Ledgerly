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

use crate::db::Db;
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

/// Everything the market refresh downloads, behind one trait so a test can
/// stand in for the network — and check the database is free while it does.
pub trait MarketSource {
    fn profile(&self, ticker: &str) -> anyhow::Result<Option<profile::ParsedProfile>>;
    fn headlines(&self, ticker: &str) -> anyhow::Result<Vec<rss::NewsItem>>;
    fn earnings_calendar(&self, date: &str) -> anyhow::Result<Vec<nasdaq_parse::ParsedEarnings>>;
    fn earnings_surprise(&self, ticker: &str) -> anyhow::Result<Vec<nasdaq_parse::ParsedEarnings>>;
    /// One batch of board symbols (at most `indices::SPARK_BATCH`), each with
    /// its recent closes. A symbol the source could not serve is left out.
    fn board_closes(&self, symbols: &[&str]) -> anyhow::Result<Vec<(String, Vec<(String, f64)>)>>;
}

/// The real sources: Yahoo for profiles, news and indices; Nasdaq for earnings.
pub struct LiveSource;

impl MarketSource for LiveSource {
    fn profile(&self, ticker: &str) -> anyhow::Result<Option<profile::ParsedProfile>> {
        profile::fetch_profile(ticker)
    }
    fn headlines(&self, ticker: &str) -> anyhow::Result<Vec<rss::NewsItem>> {
        YahooNews.headlines(ticker)
    }
    fn earnings_calendar(&self, date: &str) -> anyhow::Result<Vec<nasdaq_parse::ParsedEarnings>> {
        nasdaq::calendar_for(date)
    }
    fn earnings_surprise(&self, ticker: &str) -> anyhow::Result<Vec<nasdaq_parse::ParsedEarnings>> {
        nasdaq::surprise_for(ticker)
    }
    fn board_closes(&self, symbols: &[&str]) -> anyhow::Result<Vec<(String, Vec<(String, f64)>)>> {
        indices::fetch_board(symbols)
    }
}

fn lock(db: &Db) -> std::sync::MutexGuard<'_, Connection> {
    db.0.lock().unwrap_or_else(|e| e.into_inner())
}

/// Refresh everything. Each ticker is isolated, as `simplefin::sync` isolates
/// each account: one failure is recorded and the rest carry on.
///
/// The database is locked only to read what to fetch and to store what came
/// back — never across a download. `Db` is one mutex shared by every command,
/// so holding it through twenty-odd requests froze every other screen for the
/// length of the refresh.
pub fn refresh_all(db: &Db, src: &dyn MarketSource) -> MarketRefreshReport {
    let mut report = MarketRefreshReport::default();
    let now = chrono::Utc::now().to_rfc3339();

    // Profiles first: they decide which securities get news at all. A profile
    // barely changes, so it is refetched weekly — refetching all of them on
    // every 30-minute news poll would multiply the request budget for nothing.
    let stale_profiles: Vec<(i64, String)> = {
        let conn = lock(db);
        match store::tracked_securities(&conn) {
            Ok(held) => held
                .into_iter()
                .filter(|(id, _)| match store::profile_updated_at(&conn, *id) {
                    Ok(Some(t)) => age_days(&t, &now) >= PROFILE_MAX_AGE_DAYS,
                    _ => true,
                })
                .collect(),
            Err(e) => {
                report.errors.push(format!("held securities: {e}"));
                Vec::new()
            }
        }
    };
    let profiles: Vec<_> = stale_profiles
        .into_iter()
        .map(|(id, ticker)| {
            let fetched = src.profile(&ticker);
            (id, ticker, fetched)
        })
        .collect();

    let (targets, earnings_stale) = {
        let conn = lock(db);
        for (id, ticker, fetched) in profiles {
            match fetched {
                Ok(Some(p)) => {
                    if store::upsert_profile(&conn, id, &p, &now).is_ok() {
                        report.profiles_updated += 1;
                    }
                }
                Ok(None) => {}
                Err(e) => report.errors.push(format!("{ticker} profile: {e}")),
            }
        }
        let targets = news_targets(&conn).unwrap_or_else(|e| {
            report.errors.push(format!("news targets: {e}"));
            Vec::new()
        });
        // Earnings move once a quarter, so once a day is plenty. This is the
        // difference between roughly 6 requests per poll and roughly 27.
        let earnings_stale = match store::earnings_last_updated(&conn) {
            Ok(Some(t)) => age_days(&t, &now) >= EARNINGS_MAX_AGE_DAYS,
            _ => true,
        };
        (targets, earnings_stale)
    };

    let headlines: Vec<_> = targets
        .iter()
        .map(|(id, ticker)| (*id, ticker, src.headlines(ticker)))
        .collect();
    {
        let conn = lock(db);
        for (id, ticker, fetched) in headlines {
            match fetched {
                Ok(items) => match store::upsert_news(&conn, id, &items, &now) {
                    Ok(n) => report.news_added += n,
                    Err(e) => report.errors.push(format!("{ticker} news store: {e}")),
                },
                Err(e) => report.errors.push(format!("{ticker} news: {e}")),
            }
        }
    }

    if earnings_stale {
        report.earnings_updated = refresh_earnings(db, src, &targets, &now, &mut report.errors);
    }

    // The whole board in as few requests as the batch limit allows — one, today.
    let batches: Vec<(Vec<&str>, anyhow::Result<Vec<(String, Vec<(String, f64)>)>>)> = indices::INDICES
        .chunks(indices::SPARK_BATCH)
        .map(|chunk| {
            let symbols: Vec<&str> = chunk.iter().map(|b| b.symbol).collect();
            let fetched = src.board_closes(&symbols);
            (symbols, fetched)
        })
        .collect();
    {
        let conn = lock(db);
        for (symbols, fetched) in batches {
            match fetched {
                Ok(results) => {
                    for symbol in symbols {
                        match results.iter().find(|(s, _)| s == symbol) {
                            Some((_, closes)) => {
                                if store::upsert_index_closes(&conn, symbol, closes).is_ok() {
                                    report.indices_updated += 1;
                                }
                            }
                            None => report.errors.push(format!("{symbol}: not in the batch response")),
                        }
                    }
                }
                Err(e) => report.errors.push(format!("{}: {e}", symbols.join(", "))),
            }
        }
    }

    report
}

/// Store a run of benchmark closes and report how many this run wrote.
/// Matches `prices::backfill_all`, which also reports what the run itself
/// accomplished rather than the table's total depth. Split from
/// `backfill_benchmark` so the storage half is testable without a network
/// call.
pub fn store_benchmark_history(
    conn: &Connection,
    closes: &[(String, f64)],
) -> rusqlite::Result<usize> {
    store::upsert_index_closes(conn, indices::BENCHMARK, closes)?;
    Ok(closes.len())
}

/// An empty response is a failed fetch, not an empty market. Reporting it as
/// success would let a rate-limited download look like a completed backfill.
pub fn check_fetched(symbol: &str, closes: &[(String, f64)]) -> Result<(), String> {
    if closes.is_empty() {
        return Err(format!(
            "no closes returned for {symbol} — the response was empty or unparseable"
        ));
    }
    Ok(())
}

/// Download two years of benchmark closes. Run once after upgrade, never on a
/// timer — the ordinary market refresh keeps the last few days current.
///
/// The fetch happens before the lock is taken. `Db` is one mutex shared by
/// every command in the app, so holding it across a download would freeze
/// every other screen for as long as Yahoo takes to answer — up to
/// `http::REQUEST_TIMEOUT`.
pub fn backfill_benchmark(db: &crate::db::Db) -> Result<usize, String> {
    let closes = indices::fetch_history(indices::BENCHMARK).map_err(|e| e.to_string())?;
    check_fetched(indices::BENCHMARK, &closes)?;
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store_benchmark_history(&conn, &closes).map_err(|e| e.to_string())
}

/// The calendar is fetched by date for the whole market and intersected with
/// held tickers locally — one request per day rather than one per holding.
/// Per-company surprise is then fetched only for companies actually held.
/// Everything is downloaded before the lock is taken, as in `refresh_all`.
fn refresh_earnings(
    db: &Db,
    src: &dyn MarketSource,
    targets: &[(i64, String)],
    now: &str,
    errors: &mut Vec<String>,
) -> usize {
    if targets.is_empty() {
        return 0;
    }

    let mut calendar: Vec<(i64, nasdaq_parse::ParsedEarnings)> = Vec::new();
    let today = chrono::Utc::now().date_naive();
    for date in nasdaq::upcoming_weekdays(today, CALENDAR_DAYS) {
        match src.earnings_calendar(&date) {
            Ok(rows) => {
                for (id, ticker) in targets {
                    for row in rows.iter().filter(|r| &r.symbol == ticker) {
                        calendar.push((*id, row.clone()));
                    }
                }
            }
            Err(e) => errors.push(format!("calendar {date}: {e}")),
        }
    }

    let mut surprises = Vec::new();
    for (id, ticker) in targets {
        match src.earnings_surprise(ticker) {
            Ok(rows) => surprises.push((*id, ticker, rows)),
            Err(e) => errors.push(format!("{ticker} surprise: {e}")),
        }
    }

    // Calendar rows before surprise rows, as before: `upsert_earnings`
    // COALESCEs the actual, so the order decides nothing is overwritten.
    let conn = lock(db);
    let mut updated = 0usize;
    for (id, row) in &calendar {
        if let Ok(n) = store::upsert_earnings(&conn, *id, std::slice::from_ref(row), now) {
            updated += n;
        }
    }
    for (id, ticker, rows) in surprises {
        match store::upsert_earnings(&conn, id, &rows, now) {
            Ok(n) => updated += n,
            Err(e) => errors.push(format!("{ticker} earnings store: {e}")),
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
mod refresh_tests {
    use super::*;
    use crate::db::{self, Db};
    use nasdaq_parse::ParsedEarnings;
    use rss::NewsItem;
    use std::cell::Cell;

    /// Answers every fetch with canned data, and notes whether the database
    /// lock was held at the moment it was asked — the thing that froze every
    /// other screen for the length of a refresh.
    struct Fake<'a> {
        db: &'a Db,
        lock_was_held: Cell<bool>,
        calls: Cell<usize>,
        /// A board symbol the fake leaves out of its answer, as Yahoo does with one it cannot serve.
        skip: Option<&'static str>,
    }

    impl Fake<'_> {
        fn fetching(&self) {
            self.calls.set(self.calls.get() + 1);
            if self.db.0.try_lock().is_err() {
                self.lock_was_held.set(true);
            }
        }
    }

    fn earnings(date: &str, actual: Option<f64>) -> ParsedEarnings {
        ParsedEarnings {
            symbol: "MU".into(), fiscal_period: None, report_date: date.into(),
            eps_actual: actual, eps_estimate: Some(1.0), estimate_count: None,
        }
    }

    impl MarketSource for Fake<'_> {
        fn profile(&self, _ticker: &str) -> anyhow::Result<Option<profile::ParsedProfile>> {
            self.fetching();
            Ok(Some(profile::ParsedProfile {
                long_name: Some("Micron".into()), sector: Some("Technology".into()),
                quote_type: Some("EQUITY".into()),
            }))
        }
        fn headlines(&self, _ticker: &str) -> anyhow::Result<Vec<NewsItem>> {
            self.fetching();
            Ok(vec![NewsItem {
                guid: "g1".into(), title: "Micron news".into(), summary: String::new(),
                url: "https://example.com/a".into(), published: "2026-09-10T00:00:00Z".into(),
            }])
        }
        fn earnings_calendar(&self, date: &str) -> anyhow::Result<Vec<ParsedEarnings>> {
            self.fetching();
            Ok(vec![earnings(date, None)])
        }
        fn earnings_surprise(&self, _ticker: &str) -> anyhow::Result<Vec<ParsedEarnings>> {
            self.fetching();
            Ok(vec![earnings("2026-06-25", Some(1.2))])
        }
        fn board_closes(&self, symbols: &[&str]) -> anyhow::Result<Vec<(String, Vec<(String, f64)>)>> {
            self.fetching();
            Ok(symbols
                .iter()
                .filter(|sym| Some(**sym) != self.skip)
                .map(|sym| (sym.to_string(), vec![("2026-09-09".into(), 100.0), ("2026-09-10".into(), 101.0)]))
                .collect())
        }
    }

    fn db_holding_mu() -> Db {
        let conn = db::open_in_memory().unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
             VALUES ('B','brokerage','USD','2026-01-01','simplefin','x')", []).unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
        conn.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (1,1,10,100,120,'2026-09-10')", []).unwrap();
        Db(std::sync::Mutex::new(conn))
    }

    #[test]
    fn the_database_is_never_locked_while_the_refresh_is_downloading() {
        let db = db_holding_mu();
        let fake = Fake { db: &db, lock_was_held: Cell::new(false), calls: Cell::new(0), skip: None };
        refresh_all(&db, &fake);
        assert!(fake.calls.get() > 0, "the fake must actually have been asked");
        assert!(!fake.lock_was_held.get(), "a download ran with the database locked");
    }

    #[test]
    fn a_refresh_stores_everything_it_fetched() {
        let db = db_holding_mu();
        let fake = Fake { db: &db, lock_was_held: Cell::new(false), calls: Cell::new(0), skip: None };
        let report = refresh_all(&db, &fake);
        assert_eq!(report.profiles_updated, 1);
        assert_eq!(report.news_added, 1);
        assert_eq!(report.indices_updated, indices::INDICES.len());
        assert!(report.earnings_updated > 0);
        assert!(report.errors.is_empty(), "{:?}", report.errors);
    }

    #[test]
    fn a_second_refresh_skips_profiles_and_earnings_that_are_still_fresh() {
        let db = db_holding_mu();
        let fake = Fake { db: &db, lock_was_held: Cell::new(false), calls: Cell::new(0), skip: None };
        refresh_all(&db, &fake);
        fake.calls.set(0);

        let report = refresh_all(&db, &fake);

        assert_eq!(report.profiles_updated, 0, "profiles are refetched weekly");
        assert_eq!(report.earnings_updated, 0, "earnings are refetched daily");
        // What remains per poll: one news feed and one batch for the whole board.
        assert_eq!(fake.calls.get(), 1 + indices::INDICES.len().div_ceil(indices::SPARK_BATCH));
        assert_eq!(fake.calls.get(), 2);
    }

    #[test]
    fn a_symbol_missing_from_the_batch_is_named_and_the_rest_are_stored() {
        let db = db_holding_mu();
        let fake = Fake { db: &db, lock_was_held: Cell::new(false), calls: Cell::new(0), skip: Some("^VIX") };
        let report = refresh_all(&db, &fake);
        assert_eq!(report.indices_updated, indices::INDICES.len() - 1);
        assert!(report.errors.iter().any(|e| e.contains("^VIX")), "{:?}", report.errors);
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
        assert_eq!(
            store::index_history_depth(&conn, indices::BENCHMARK).unwrap(), 2,
            "the second run replaced the two rows rather than appending two more",
        );
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

    #[test]
    fn an_empty_fetch_is_reported_as_an_error_naming_the_symbol() {
        let err = check_fetched(indices::BENCHMARK, &[]).unwrap_err();
        assert!(
            err.contains(indices::BENCHMARK),
            "the error should name the symbol that failed: {err}",
        );
    }

    #[test]
    fn a_non_empty_fetch_passes_the_check() {
        assert!(check_fetched(indices::BENCHMARK, &[("2025-01-02".into(), 7000.0)]).is_ok());
    }
}
