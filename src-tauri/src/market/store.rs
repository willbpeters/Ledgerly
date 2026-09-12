//! All SQLite access for the Markets module. Callers pass parsed values in and
//! get plain rows out; nothing here touches the network.
use crate::market::rss::{publisher_from_url, NewsItem};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// A headline as the UI receives it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct StoredNews {
    pub security_id: i64,
    pub title: String,
    pub summary: Option<String>,
    pub url: String,
    pub publisher: Option<String>,
    pub published: String,
    pub fetched_at: String,
}

/// Write headlines for one security. Returns how many rows were newly created.
/// Re-fetching the same guid updates that row rather than duplicating it, which
/// is what makes a 30-minute poll cheap.
///
/// Counted per row, the way `budget::store::upsert_transactions` does, so the
/// figure is exact rather than inferred from the table's size before and after.
pub fn upsert_news(
    conn: &Connection,
    security_id: i64,
    items: &[NewsItem],
    fetched_at: &str,
) -> rusqlite::Result<usize> {
    let mut added = 0usize;
    for it in items {
        let summary = if it.summary.is_empty() { None } else { Some(it.summary.as_str()) };
        let publisher = publisher_from_url(&it.url);
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM news_items WHERE security_id=?1 AND guid=?2",
                params![security_id, it.guid],
                |r| r.get(0),
            )
            .optional()?;

        match existing {
            Some(id) => {
                conn.execute(
                    "UPDATE news_items SET title=?1, summary=?2, url=?3, publisher=?4,
                       published=?5, fetched_at=?6 WHERE id=?7",
                    params![it.title, summary, it.url, publisher, it.published, fetched_at, id],
                )?;
            }
            None => {
                conn.execute(
                    "INSERT INTO news_items
                       (security_id,guid,title,summary,url,publisher,published,fetched_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![security_id, it.guid, it.title, summary, it.url,
                            publisher, it.published, fetched_at],
                )?;
                added += 1;
            }
        }
    }
    Ok(added)
}

/// The newest `per_security` headlines for every security that has any.
pub fn list_news(conn: &Connection, per_security: i64) -> rusqlite::Result<Vec<StoredNews>> {
    let mut stmt = conn.prepare(
        "SELECT security_id,title,summary,url,publisher,published,fetched_at FROM (
           SELECT *, row_number() OVER (PARTITION BY security_id ORDER BY published DESC) rn
           FROM news_items
         ) WHERE rn <= ?1
         ORDER BY security_id, published DESC",
    )?;
    let rows = stmt.query_map([per_security], |r| {
        Ok(StoredNews {
            security_id: r.get(0)?, title: r.get(1)?, summary: r.get(2)?, url: r.get(3)?,
            publisher: r.get(4)?, published: r.get(5)?, fetched_at: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// Securities worth spending a request on: those actually held, either through
/// a synced holding or a manual transaction. Fetching news for a security with
/// no position would burn the politeness budget on nothing.
pub fn tracked_securities(conn: &Connection) -> rusqlite::Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT s.id, s.ticker FROM securities s
         WHERE EXISTS (SELECT 1 FROM synced_holdings h WHERE h.security_id=s.id AND h.shares > 0)
            OR EXISTS (SELECT 1 FROM transactions t WHERE t.security_id=s.id)
         ORDER BY s.ticker",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}


use crate::market::profile::{ParsedProfile, SecurityProfile};

pub fn upsert_profile(
    conn: &Connection,
    security_id: i64,
    p: &ParsedProfile,
    updated_at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO security_profile (security_id,long_name,sector,quote_type,updated_at)
         VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(security_id) DO UPDATE SET
           long_name=excluded.long_name, sector=excluded.sector,
           quote_type=excluded.quote_type, updated_at=excluded.updated_at",
        params![security_id, p.long_name, p.sector, p.quote_type, updated_at],
    )?;
    Ok(())
}

/// Profiles for every security that has one, with the benchmark label filled
/// in from the static map at read time rather than stored.
pub fn list_profiles(conn: &Connection) -> rusqlite::Result<Vec<SecurityProfile>> {
    let mut stmt = conn.prepare(
        "SELECT p.security_id, p.long_name, p.sector, p.quote_type, s.ticker
         FROM security_profile p JOIN securities s ON s.id = p.security_id
         ORDER BY s.ticker",
    )?;
    let rows = stmt.query_map([], |r| {
        let ticker: String = r.get(4)?;
        Ok(SecurityProfile {
            security_id: r.get(0)?, long_name: r.get(1)?, sector: r.get(2)?,
            quote_type: r.get(3)?,
            tracks: crate::market::benchmarks::tracks_for(&ticker).map(str::to_string),
        })
    })?;
    rows.collect()
}

/// When this security's profile was last fetched, if ever.
pub fn profile_updated_at(conn: &Connection, security_id: i64) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT updated_at FROM security_profile WHERE security_id=?1")?;
    let mut rows = stmt.query([security_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(r.get(0)?)),
        None => Ok(None),
    }
}


use crate::market::nasdaq_parse::ParsedEarnings;

/// An earnings row as the UI receives it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct EarningsEvent {
    pub security_id: i64,
    pub fiscal_period: Option<String>,
    pub report_date: String,
    pub eps_actual: Option<f64>,
    pub eps_estimate: Option<f64>,
    pub estimate_count: Option<i64>,
}

/// One row per (security, report date). `COALESCE` on the actual is what lets
/// the calendar and the surprise table write to the same row without the
/// calendar's empty actual wiping a figure the surprise table already landed.
pub fn upsert_earnings(
    conn: &Connection,
    security_id: i64,
    rows: &[ParsedEarnings],
    updated_at: &str,
) -> rusqlite::Result<usize> {
    let mut written = 0usize;
    for e in rows {
        if e.report_date.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT INTO earnings_events
               (security_id,fiscal_period,report_date,eps_actual,eps_estimate,estimate_count,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(security_id,report_date) DO UPDATE SET
               fiscal_period=COALESCE(excluded.fiscal_period, fiscal_period),
               eps_actual=COALESCE(excluded.eps_actual, eps_actual),
               eps_estimate=COALESCE(excluded.eps_estimate, eps_estimate),
               estimate_count=COALESCE(excluded.estimate_count, estimate_count),
               updated_at=excluded.updated_at",
            params![
                security_id, e.fiscal_period, e.report_date,
                e.eps_actual, e.eps_estimate, e.estimate_count, updated_at
            ],
        )?;
        written += 1;
    }
    Ok(written)
}

/// Every earnings row, oldest first. The UI decides what is "next" and what is
/// "just reported" — the store does not need a clock.
pub fn list_earnings(conn: &Connection) -> rusqlite::Result<Vec<EarningsEvent>> {
    let mut stmt = conn.prepare(
        "SELECT security_id,fiscal_period,report_date,eps_actual,eps_estimate,estimate_count
         FROM earnings_events ORDER BY report_date",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(EarningsEvent {
            security_id: r.get(0)?, fiscal_period: r.get(1)?, report_date: r.get(2)?,
            eps_actual: r.get(3)?, eps_estimate: r.get(4)?, estimate_count: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// When any earnings row was last written, if ever. Earnings move once a
/// quarter, so this gates a daily refresh rather than a 30-minute one.
pub fn earnings_last_updated(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT MAX(updated_at) FROM earnings_events", [], |r| r.get(0))
}


/// An index as the market strip receives it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct IndexQuote {
    pub symbol: String,
    pub label: String,
    pub latest: f64,
    pub previous: f64,
}

pub fn upsert_index_closes(
    conn: &Connection,
    symbol: &str,
    closes: &[(String, f64)],
) -> rusqlite::Result<usize> {
    for (date, close) in closes {
        conn.execute(
            "INSERT INTO index_quotes (symbol,date,close) VALUES (?1,?2,?3)
             ON CONFLICT(symbol,date) DO UPDATE SET close=excluded.close",
            params![symbol, date, close],
        )?;
    }
    Ok(closes.len())
}

/// Latest and previous close per index. An index with fewer than two closes is
/// omitted: showing it as a flat 0.00% would be a lie about a missing fetch.
pub fn list_index_quotes(conn: &Connection) -> rusqlite::Result<Vec<IndexQuote>> {
    let mut out = Vec::new();
    for (symbol, label) in crate::market::indices::INDICES {
        let mut stmt = conn.prepare(
            "SELECT close FROM index_quotes WHERE symbol=?1 ORDER BY date DESC LIMIT 2")?;
        let closes: Vec<f64> = stmt
            .query_map([symbol], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<f64>>>()?;
        if closes.len() < 2 {
            continue;
        }
        out.push(IndexQuote {
            symbol: (*symbol).to_string(),
            label: (*label).to_string(),
            latest: closes[0],
            previous: closes[1],
        });
    }
    Ok(out)
}

/// Every stored close for one index, oldest first. The risk maths walks this
/// forwards turning closes into daily returns, so the order is load-bearing.
pub fn index_history(conn: &Connection, symbol: &str) -> rusqlite::Result<Vec<(String, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT date, close FROM index_quotes WHERE symbol=?1 ORDER BY date")?;
    let rows = stmt.query_map([symbol], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// How many closes are stored for one index. The frontend uses this to decide
/// whether the two-year backfill still needs running.
pub fn index_history_depth(conn: &Connection, symbol: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM index_quotes WHERE symbol=?1", [symbol], |r| r.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn seed(conn: &rusqlite::Connection) {
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
    }
    fn item(guid: &str, published: &str) -> crate::market::rss::NewsItem {
        crate::market::rss::NewsItem {
            guid: guid.into(), title: format!("Headline {guid}"), summary: "blurb".into(),
            url: "https://finance.yahoo.com/news/a.html".into(), published: published.into(),
        }
    }


    // The whole point of the window function is PARTITION BY security_id.
    // With only one security seeded, a regression that dropped the partition
    // and capped globally would still have passed every other test here.


    fn earnings(report_date: &str, actual: Option<f64>, est: Option<f64>)
        -> crate::market::nasdaq_parse::ParsedEarnings {
        crate::market::nasdaq_parse::ParsedEarnings {
            symbol: "MU".into(), fiscal_period: Some("May 2026".into()),
            report_date: report_date.into(), eps_actual: actual, eps_estimate: est,
            estimate_count: Some(18),
        }
    }


    #[test]
    fn index_quotes_keep_the_latest_two_closes_per_symbol() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[
            ("2026-09-08".into(), 7500.0),
            ("2026-09-09".into(), 7550.0),
            ("2026-09-10".into(), 7591.7),
        ]).unwrap();
        let rows = list_index_quotes(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].symbol, "^GSPC");
        assert_eq!(rows[0].label, "S&P 500");
        assert_eq!(rows[0].latest, 7591.7);
        assert_eq!(rows[0].previous, 7550.0);
    }

    #[test]
    fn an_index_with_only_one_close_is_left_out_rather_than_shown_as_flat() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[("2026-09-10".into(), 7591.7)]).unwrap();
        assert!(list_index_quotes(&conn).unwrap().is_empty());
    }
    #[test]
    fn an_estimate_is_replaced_by_the_actual_when_the_quarter_reports() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        upsert_earnings(&conn, 1, &[earnings("2026-09-23", None, Some(1.92))], "2026-09-10T12:00:00Z").unwrap();
        upsert_earnings(&conn, 1, &[earnings("2026-09-23", Some(1.79), Some(1.60))], "2026-09-24T12:00:00Z").unwrap();
        let rows = list_earnings(&conn).unwrap();
        assert_eq!(rows.len(), 1, "one row per report date, not one per fetch");
        assert_eq!(rows[0].eps_actual, Some(1.79));
        assert_eq!(rows[0].eps_estimate, Some(1.60));
    }

    #[test]
    fn a_later_fetch_without_an_actual_does_not_erase_one_already_known() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        upsert_earnings(&conn, 1, &[earnings("2026-09-23", Some(1.79), Some(1.60))], "2026-09-24T12:00:00Z").unwrap();
        upsert_earnings(&conn, 1, &[earnings("2026-09-23", None, Some(1.60))], "2026-09-25T12:00:00Z").unwrap();
        let rows = list_earnings(&conn).unwrap();
        assert_eq!(rows[0].eps_actual, Some(1.79), "a reported figure must survive a stale estimate");
    }

    #[test]
    fn a_row_with_no_report_date_is_skipped_because_it_cannot_be_keyed() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        let written = upsert_earnings(&conn, 1, &[earnings("", None, Some(1.92))], "2026-09-10T12:00:00Z").unwrap();
        assert_eq!(written, 0);
        assert!(list_earnings(&conn).unwrap().is_empty());
        assert_eq!(earnings_last_updated(&conn).unwrap(), None);
    }
    #[test]
    fn a_stored_fund_profile_reads_back_with_its_benchmark_label() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('SWPPX','etf','USD')", []).unwrap();
        let p = crate::market::profile::ParsedProfile {
            long_name: Some("Schwab S&P 500 Index Fund".into()),
            sector: None, quote_type: Some("MUTUALFUND".into()),
        };
        upsert_profile(&conn, 1, &p, "2026-09-10T12:00:00Z").unwrap();
        let rows = list_profiles(&conn).unwrap();
        assert_eq!(rows[0].quote_type.as_deref(), Some("MUTUALFUND"));
        assert_eq!(rows[0].tracks.as_deref(), Some("S&P 500"));
        assert_eq!(profile_updated_at(&conn, 1).unwrap().as_deref(), Some("2026-09-10T12:00:00Z"));
    }

    #[test]
    fn a_profile_refetch_replaces_rather_than_duplicates() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        let mut p = crate::market::profile::ParsedProfile {
            long_name: Some("Micron".into()), sector: Some("Technology".into()),
            quote_type: Some("EQUITY".into()),
        };
        upsert_profile(&conn, 1, &p, "2026-09-10T12:00:00Z").unwrap();
        p.long_name = Some("Micron Technology, Inc.".into());
        upsert_profile(&conn, 1, &p, "2026-09-11T12:00:00Z").unwrap();
        let rows = list_profiles(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].long_name.as_deref(), Some("Micron Technology, Inc."));
        assert_eq!(profile_updated_at(&conn, 2).unwrap(), None, "an unfetched security has no stamp");
    }
    #[test]
    fn the_cap_is_per_security_not_global() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('GOOG','stock','USD')", []).unwrap();
        for id in [1i64, 2] {
            let items = vec![
                item(&format!("{id}-old"), "2026-09-08T10:00:00Z"),
                item(&format!("{id}-new"), "2026-09-10T10:00:00Z"),
                item(&format!("{id}-mid"), "2026-09-09T10:00:00Z"),
            ];
            upsert_news(&conn, id, &items, "2026-09-10T12:00:00Z").unwrap();
        }
        let rows = list_news(&conn, 2).unwrap();
        assert_eq!(rows.len(), 4, "two securities, two headlines each");
        let for_security = |id: i64| -> Vec<String> {
            rows.iter().filter(|r| r.security_id == id).map(|r| r.title.clone()).collect()
        };
        assert_eq!(for_security(1), vec!["Headline 1-new", "Headline 1-mid"]);
        assert_eq!(for_security(2), vec!["Headline 2-new", "Headline 2-mid"]);
    }

    // An item repeated inside one call must count once, not twice.
    #[test]
    fn the_same_guid_twice_in_one_batch_counts_as_one_new_row() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        let dupe = vec![item("g1", "2026-09-10T10:00:00Z"), item("g1", "2026-09-10T10:00:00Z")];
        let added = upsert_news(&conn, 1, &dupe, "2026-09-10T12:00:00Z").unwrap();
        assert_eq!(added, 1);
        assert_eq!(list_news(&conn, 10).unwrap().len(), 1);
    }
    #[test]
    fn stores_items_and_re_storing_the_same_guid_updates_rather_than_duplicates() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        let added = upsert_news(&conn, 1, &[item("g1", "2026-09-10T10:00:00Z")], "2026-09-10T12:00:00Z").unwrap();
        assert_eq!(added, 1);
        upsert_news(&conn, 1, &[item("g1", "2026-09-10T10:00:00Z")], "2026-09-10T13:00:00Z").unwrap();
        let rows = list_news(&conn, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fetched_at, "2026-09-10T13:00:00Z", "re-fetch refreshes the stamp");
        assert_eq!(rows[0].publisher.as_deref(), Some("finance.yahoo.com"));
    }

    #[test]
    fn returns_newest_first_and_caps_per_security() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        let items = vec![
            item("old", "2026-09-08T10:00:00Z"),
            item("new", "2026-09-10T10:00:00Z"),
            item("mid", "2026-09-09T10:00:00Z"),
        ];
        upsert_news(&conn, 1, &items, "2026-09-10T12:00:00Z").unwrap();
        let rows = list_news(&conn, 2).unwrap();
        assert_eq!(rows.len(), 2, "capped at 2 per security");
        assert_eq!(rows[0].title, "Headline new");
        assert_eq!(rows[1].title, "Headline mid");
    }

    #[test]
    fn tracked_securities_are_those_actually_held() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('GHOST','stock','USD')", []).unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
             VALUES ('B','brokerage','USD','2026-01-01','simplefin','x')", []).unwrap();
        conn.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (1,1,10,100,120,'2026-09-10')", []).unwrap();
        let held = tracked_securities(&conn).unwrap();
        assert_eq!(held, vec![(1, "MU".to_string())], "a security with no position is not tracked");
    }

    #[test]
    fn index_history_returns_every_close_oldest_first() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[
            ("2026-09-10".into(), 7591.7),
            ("2026-09-08".into(), 7500.0),
            ("2026-09-09".into(), 7550.0),
        ]).unwrap();

        let rows = index_history(&conn, "^GSPC").unwrap();

        assert_eq!(rows, vec![
            ("2026-09-08".to_string(), 7500.0),
            ("2026-09-09".to_string(), 7550.0),
            ("2026-09-10".to_string(), 7591.7),
        ], "the return series is built forwards, so the rows must arrive forwards");
    }

    #[test]
    fn index_history_depth_counts_rows_for_that_symbol_only() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[
            ("2026-09-08".into(), 7500.0), ("2026-09-09".into(), 7550.0),
        ]).unwrap();
        upsert_index_closes(&conn, "^IXIC", &[("2026-09-09".into(), 23000.0)]).unwrap();

        assert_eq!(index_history_depth(&conn, "^GSPC").unwrap(), 2);
        assert_eq!(index_history_depth(&conn, "^DJI").unwrap(), 0, "never fetched is zero, not an error");
    }

    #[test]
    fn storing_index_closes_never_creates_a_security() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[("2026-09-09".into(), 7550.0)]).unwrap();

        let securities: i64 = conn
            .query_row("SELECT count(*) FROM securities", [], |r| r.get(0))
            .unwrap();
        assert_eq!(securities, 0, "the S&P must never be something the owner appears to hold");
    }
}
