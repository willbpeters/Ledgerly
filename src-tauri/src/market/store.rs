//! All SQLite access for the Markets module. Callers pass parsed values in and
//! get plain rows out; nothing here touches the network.
use crate::market::rss::{publisher_from_url, NewsItem};
use rusqlite::{params, Connection};
use serde::Serialize;

/// A headline as the UI receives it.
#[allow(dead_code)] // wired up in a later task; only tests call this today
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
/// Re-fetching the same guid refreshes the row rather than duplicating it,
/// which is what makes a 30-minute poll cheap.
#[allow(dead_code)] // wired up in a later task; only tests call this today
pub fn upsert_news(
    conn: &Connection,
    security_id: i64,
    items: &[NewsItem],
    fetched_at: &str,
) -> rusqlite::Result<usize> {
    let before: i64 = conn.query_row(
        "SELECT count(*) FROM news_items WHERE security_id=?1", [security_id], |r| r.get(0))?;
    for it in items {
        conn.execute(
            "INSERT INTO news_items (security_id,guid,title,summary,url,publisher,published,fetched_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(security_id,guid) DO UPDATE SET
               title=excluded.title, summary=excluded.summary, url=excluded.url,
               publisher=excluded.publisher, published=excluded.published,
               fetched_at=excluded.fetched_at",
            params![
                security_id, it.guid, it.title,
                if it.summary.is_empty() { None } else { Some(it.summary.as_str()) },
                it.url, publisher_from_url(&it.url), it.published, fetched_at
            ],
        )?;
    }
    let after: i64 = conn.query_row(
        "SELECT count(*) FROM news_items WHERE security_id=?1", [security_id], |r| r.get(0))?;
    Ok((after - before).max(0) as usize)
}

/// The newest `per_security` headlines for every security that has any.
#[allow(dead_code)] // wired up in a later task; only tests call this today
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
#[allow(dead_code)] // wired up in a later task; only tests call this today
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
}
