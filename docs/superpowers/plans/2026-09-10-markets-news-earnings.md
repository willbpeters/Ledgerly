# Markets News & Earnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Markets screen showing today's moves beside company headlines and earnings dates, split into held companies and held index funds, answering "what happened to what I own?" and "is this me or the whole market?"

**Architecture:** A new Rust `market/` module fetches from Yahoo RSS, the Yahoo search endpoint and three Nasdaq endpoints, caches everything in four new SQLite tables (migration v5), and exposes rows through Tauri commands. Parsing is pure and fixture-tested; assembly into the screen's view model is pure TypeScript in `src/domain/market.ts`. The screen renders from cache and never blocks on the network.

**Tech Stack:** Rust (rusqlite, reqwest blocking, serde_json, chrono), React 19 + TypeScript, TanStack Query, Vitest, react-router-dom.

**Spec:** `docs/superpowers/specs/2026-09-10-markets-news-earnings-design.md`

---

## Conventions used throughout

- Rust tests run with `cd src-tauri && cargo test --lib <name>`.
- TypeScript tests run with `npx vitest run <path>`.
- Every HTTP call uses the browser-like User-Agent already required by Yahoo:
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1`
- Fixtures live in `src-tauri/src/market/fixtures/` and are `include_str!`-ed.
- Dates are stored as `YYYY-MM-DD`; timestamps as RFC 3339.

### Names defined once, used everywhere

| Name | Defined in | Shape |
| --- | --- | --- |
| `NewsItem` | Task 2 | `{ guid, title, summary, url, published }` — parsed, not yet stored |
| `StoredNews` | Task 3 | `{ security_id, title, summary, url, publisher, published, fetched_at }` |
| `SecurityProfile` | Task 5 | `{ security_id, long_name, sector, quote_type, tracks }` |
| `EarningsEvent` | Task 6 | `{ security_id, fiscal_period, report_date, eps_actual, eps_estimate, estimate_count }` |
| `IndexQuote` | Task 8 | `{ symbol, label, latest, previous }` |
| `MarketRefreshReport` | Task 9 | `{ news_added, profiles_updated, earnings_updated, indices_updated, errors }` |

---

## Task 1: Migration v5 — the four tables

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block at the bottom of `src-tauri/src/db.rs`:

```rust
    #[test]
    fn v5_creates_market_tables_and_is_idempotent() {
        let conn = open_in_memory().unwrap();
        for t in V5_TABLES {
            assert!(table_exists(&conn, t).unwrap(), "{t} should exist");
        }
        // Running the migration a second time must not error. This is the rule
        // db.rs already enforces: a stamp can be wrong in both directions, so
        // every migration has to survive being re-applied.
        apply_v5(&conn).unwrap();
        apply_migrations(&conn).unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, TARGET_VERSION);
    }

    #[test]
    fn news_items_dedupe_on_guid_and_cascade_with_the_security() {
        let conn = open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
        let insert = "INSERT INTO news_items (security_id,guid,title,url,published,fetched_at)
                      VALUES (1,'g1','A','http://x','2026-09-10T00:00:00Z','2026-09-10T00:00:00Z')
                      ON CONFLICT(security_id,guid) DO UPDATE SET title=excluded.title";
        conn.execute(insert, []).unwrap();
        conn.execute(insert, []).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM news_items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the same guid must not duplicate");

        conn.execute("DELETE FROM securities WHERE id=1", []).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM news_items", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "news must go with its security");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib v5_creates_market_tables`
Expected: FAIL to compile — `cannot find value V5_TABLES in this scope`

- [ ] **Step 3: Write the migration**

In `src-tauri/src/db.rs`, change the target version:

```rust
const TARGET_VERSION: i64 = 5;
```

Add below the `V4_COLUMN` declaration:

```rust
/// v5: the Markets module — cached headlines, earnings events, per-security
/// profile (which routes a holding into "companies" or "funds"), and index
/// levels. Index levels live in their own table rather than in `securities`,
/// so the S&P never appears in Holdings or the allocation chart as though it
/// were owned.
const V5_TABLES: &[&str] = &["news_items", "earnings_events", "security_profile", "index_quotes"];

const MIGRATION_5: &str = "
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  publisher TEXT,
  published TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (security_id, guid)
);
CREATE INDEX IF NOT EXISTS news_items_published ON news_items(published);

CREATE TABLE IF NOT EXISTS earnings_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  fiscal_period TEXT,
  report_date TEXT NOT NULL,
  eps_actual REAL,
  eps_estimate REAL,
  estimate_count INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (security_id, report_date)
);

CREATE TABLE IF NOT EXISTS security_profile (
  security_id INTEGER PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
  long_name TEXT,
  sector TEXT,
  quote_type TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_quotes (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);
";

/// Whether every v5 object is really present, whatever the version stamp says.
fn v5_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    for table in V5_TABLES {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Every statement is IF NOT EXISTS, so this is safe to re-run.
fn apply_v5(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_5)
}
```

In `apply_migrations`, add after the v4 block and before `set_user_version(conn, TARGET_VERSION)?`:

```rust
    if !v5_is_complete(conn)? {
        apply_v5(conn)?;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib db::`
Expected: PASS, including the two new tests

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(db): v5 adds news, earnings, profile and index tables"
```

---

## Task 2: Pure RSS parsing

Yahoo's feed has no CDATA and only `&amp;` entities, so a small hand-rolled
reader beats adding an XML dependency. It also has **no publisher element** —
that is derived from the link's host.

**Files:**
- Create: `src-tauri/src/market/mod.rs`
- Create: `src-tauri/src/market/rss.rs`
- Create: `src-tauri/src/market/fixtures/yahoo_news_mu.xml`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Capture the fixture**

```bash
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1" \
  "https://feeds.finance.yahoo.com/rss/2.0/headline?s=MU&region=US&lang=en-US" \
  -o src-tauri/src/market/fixtures/yahoo_news_mu.xml
head -c 200 src-tauri/src/market/fixtures/yahoo_news_mu.xml
```

Expected: XML beginning `<?xml version="1.0"` — if it is HTML or empty, stop and report it.

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/market/rss.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = include_str!("fixtures/yahoo_news_mu.xml");

    #[test]
    fn parses_the_real_feed() {
        let items = parse_feed(FEED);
        assert!(!items.is_empty(), "the fixture should carry items");
        let first = &items[0];
        assert!(!first.guid.is_empty());
        assert!(!first.title.is_empty());
        assert!(first.url.starts_with("http"));
        assert_eq!(first.published.len(), 20, "published should be RFC3339 UTC");
        assert!(first.published.ends_with('Z'));
    }

    #[test]
    fn reads_fields_out_of_one_item_including_an_attributed_guid() {
        const XML: &str = r#"<rss><channel><item>
            <description>Blurb &amp; more</description>
            <guid isPermaLink="false">abc123</guid>
            <link>https://finance.yahoo.com/news/thing.html</link>
            <pubDate>Thu, 10 Sep 2026 19:29:06 +0000</pubDate>
            <title>Micron rises &amp; holds</title>
        </item></channel></rss>"#;
        let items = parse_feed(XML);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].guid, "abc123", "the guid has an attribute on its tag");
        assert_eq!(items[0].title, "Micron rises & holds", "entities decoded");
        assert_eq!(items[0].summary, "Blurb & more");
        assert_eq!(items[0].published, "2026-09-10T19:29:06Z");
    }

    #[test]
    fn an_item_without_a_link_or_title_is_skipped_rather_than_stored_blank() {
        const XML: &str = r#"<rss><channel>
            <item><title>No link here</title><guid>g1</guid></item>
            <item><link>https://x.test/a</link><guid>g2</guid></item>
        </channel></rss>"#;
        assert!(parse_feed(XML).is_empty());
    }

    #[test]
    fn publisher_comes_from_the_host_because_the_feed_has_no_publisher_field() {
        assert_eq!(publisher_from_url("https://finance.yahoo.com/news/a.html").as_deref(), Some("finance.yahoo.com"));
        assert_eq!(publisher_from_url("https://www.reuters.com/x").as_deref(), Some("reuters.com"));
        assert_eq!(publisher_from_url("not a url"), None);
    }

    #[test]
    fn an_unparseable_date_drops_the_item_rather_than_inventing_a_time() {
        const XML: &str = r#"<rss><channel><item>
            <title>T</title><guid>g</guid><link>https://x.test/a</link>
            <pubDate>sometime last week</pubDate>
        </item></channel></rss>"#;
        assert!(parse_feed(XML).is_empty());
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib market::rss`
Expected: FAIL — `cannot find function parse_feed`

- [ ] **Step 4: Write the implementation**

Put this **above** the `mod tests` block in `src-tauri/src/market/rss.rs`:

```rust
//! Pure parsing of Yahoo Finance's per-ticker RSS feed. No I/O, so it is
//! tested against a captured fixture the way `simplefin::parse` is.
//!
//! The feed is plain XML: no CDATA, and `&amp;` is the only entity seen in
//! practice. That makes a small hand-rolled reader cheaper and more
//! predictable than pulling in an XML crate.

/// One headline, parsed. Not yet tied to a security — `store` does that.
#[derive(Debug, Clone, PartialEq)]
pub struct NewsItem {
    pub guid: String,
    pub title: String,
    pub summary: String,
    pub url: String,
    /// RFC 3339, UTC, e.g. `2026-09-10T19:29:06Z`.
    pub published: String,
}

/// Inner text of the first `<name>` element in `block`. Tolerates attributes
/// on the opening tag, which `<guid isPermaLink="false">` has.
fn tag(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}");
    let start = block.find(&open)?;
    let after_attrs = block[start..].find('>')? + start + 1;
    let end = block[after_attrs..].find(&format!("</{name}>"))? + after_attrs;
    Some(unescape(block[after_attrs..end].trim()))
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        // Ampersand last, so "&amp;lt;" does not become "<".
        .replace("&amp;", "&")
}

/// The host of a link, minus a leading `www.`. The feed carries no publisher
/// element, so this is the only honest source for one.
pub fn publisher_from_url(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let host = rest.split('/').next()?;
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    Some(host.strip_prefix("www.").unwrap_or(host).to_string())
}

/// Parse a feed into items, oldest-to-newest order preserved from the source.
/// An item missing a title, link, guid or a parseable date is dropped: a blank
/// row on screen is worse than one fewer headline.
pub fn parse_feed(xml: &str) -> Vec<NewsItem> {
    let mut out = Vec::new();
    for chunk in xml.split("<item>").skip(1) {
        let block = match chunk.find("</item>") {
            Some(end) => &chunk[..end],
            None => chunk,
        };
        let (Some(title), Some(url), Some(guid)) =
            (tag(block, "title"), tag(block, "link"), tag(block, "guid"))
        else {
            continue;
        };
        let Some(published) = tag(block, "pubDate").and_then(|d| to_rfc3339(&d)) else {
            continue;
        };
        if title.is_empty() || url.is_empty() {
            continue;
        }
        out.push(NewsItem {
            guid,
            title,
            summary: tag(block, "description").unwrap_or_default(),
            url,
            published,
        });
    }
    out
}

/// RSS dates are RFC 2822 (`Thu, 10 Sep 2026 19:29:06 +0000`). Normalised to
/// UTC so string comparison also sorts chronologically.
fn to_rfc3339(raw: &str) -> Option<String> {
    let dt = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some(dt.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}
```

Create `src-tauri/src/market/mod.rs`:

```rust
//! The Markets module: headlines, earnings and index levels for held
//! securities. Laid out like `simplefin/` — HTTP, pure parsing and SQLite are
//! separate files, so the parsing is fixture-testable with no network.
pub mod rss;
```

Register the module in `src-tauri/src/lib.rs` by adding after `mod budget;`:

```rust
mod market;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::rss`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/market src-tauri/src/lib.rs
git commit -m "feat(market): pure RSS parsing with a captured Yahoo fixture"
```

---

## Task 3: Storing and reading headlines

**Files:**
- Create: `src-tauri/src/market/store.rs`
- Modify: `src-tauri/src/market/mod.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/market/store.rs` containing only:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib market::store`
Expected: FAIL — `cannot find function upsert_news`

- [ ] **Step 3: Write the implementation**

Put above the `mod tests` block in `src-tauri/src/market/store.rs`:

```rust
//! All SQLite access for the Markets module. Callers pass parsed values in and
//! get plain rows out; nothing here touches the network.
use crate::market::rss::{publisher_from_url, NewsItem};
use rusqlite::{params, Connection};
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
/// Re-fetching the same guid refreshes the row rather than duplicating it,
/// which is what makes a 30-minute poll cheap.
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
```

Add to `src-tauri/src/market/mod.rs`:

```rust
pub mod store;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::store`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/market
git commit -m "feat(market): store and read cached headlines"
```

---

## Task 4: Fetching headlines over HTTP

**Files:**
- Create: `src-tauri/src/market/yahoo_news.rs`
- Modify: `src-tauri/src/market/mod.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/market/yahoo_news.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_feed_url_for_a_ticker() {
        assert_eq!(
            feed_url("mu"),
            "https://feeds.finance.yahoo.com/rss/2.0/headline?s=MU&region=US&lang=en-US"
        );
    }

    /// Hits the network. Run with:
    /// `cargo test --lib live_yahoo_news -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn live_yahoo_news_returns_items() {
        let items = YahooNews.headlines("MU").unwrap();
        assert!(!items.is_empty(), "MU should have headlines");
        assert!(items[0].url.starts_with("http"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib market::yahoo_news`
Expected: FAIL — `cannot find function feed_url`

- [ ] **Step 3: Write the implementation**

Put above the `mod tests` block in `src-tauri/src/market/yahoo_news.rs`:

```rust
//! HTTP for headlines. Kept apart from `rss.rs` so the parsing stays testable
//! without a network, exactly as `simplefin::client` is kept apart from
//! `simplefin::parse`.
use crate::market::rss::{parse_feed, NewsItem};

/// Yahoo rejects plain clients; the same UA the price provider uses works.
pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1";

pub fn feed_url(ticker: &str) -> String {
    format!(
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s={}&region=US&lang=en-US",
        ticker.trim().to_uppercase()
    )
}

/// A source of company headlines. Behind a trait so a replacement (Google News
/// RSS) can be dropped in without touching callers — the lesson from Stooq.
pub trait NewsProvider {
    fn headlines(&self, ticker: &str) -> anyhow::Result<Vec<NewsItem>>;
    fn name(&self) -> &'static str;
}

pub struct YahooNews;

impl NewsProvider for YahooNews {
    fn headlines(&self, ticker: &str) -> anyhow::Result<Vec<NewsItem>> {
        let client = reqwest::blocking::Client::builder().user_agent(UA).build()?;
        let body = client.get(feed_url(ticker)).send()?.text()?;
        Ok(parse_feed(&body))
    }
    fn name(&self) -> &'static str { "yahoo-rss" }
}
```

Add to `src-tauri/src/market/mod.rs`:

```rust
pub mod yahoo_news;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::yahoo_news`
Expected: PASS, 1 test (1 ignored)

- [ ] **Step 5: Verify against the live endpoint once**

Run: `cd src-tauri && cargo test --lib live_yahoo_news -- --ignored --nocapture`
Expected: PASS. If it fails with an empty list, Yahoo has changed the feed — stop and report rather than working around it.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/market
git commit -m "feat(market): fetch headlines from Yahoo RSS behind a provider trait"
```

---

## Task 5: Security profiles — the companies/funds split

`quote_type` is what routes GOOG into *Your companies* and SWPPX into *Your
funds*, so this task is what makes the screen's structure real.

**Files:**
- Create: `src-tauri/src/market/profile.rs`
- Create: `src-tauri/src/market/benchmarks.rs`
- Create: `src-tauri/src/market/fixtures/yahoo_search_mu.json`
- Modify: `src-tauri/src/market/store.rs`, `src-tauri/src/market/mod.rs`

- [ ] **Step 1: Capture the fixture**

```bash
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1" \
  "https://query1.finance.yahoo.com/v1/finance/search?q=MU&newsCount=0" \
  -o src-tauri/src/market/fixtures/yahoo_search_mu.json
head -c 200 src-tauri/src/market/fixtures/yahoo_search_mu.json
```

Expected: JSON beginning `{"explains":[]` and containing `"quoteType":"EQUITY"`.

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/market/benchmarks.rs`:

```rust
//! What a fund tracks, as a small static map in the spirit of `budget/mcc.rs`.
//! An unknown fund gets no label rather than a guess.

const MAP: &[(&str, &str)] = &[
    ("SWPPX", "S&P 500"),
    ("VOO", "S&P 500"),
    ("SPY", "S&P 500"),
    ("IVV", "S&P 500"),
    ("SWLGX", "US large-cap growth"),
    ("SWSSX", "US small-cap"),
    ("SWISX", "MSCI EAFE (international)"),
    ("SWTSX", "US total market"),
    ("VTI", "US total market"),
    ("QQQ", "Nasdaq 100"),
];

pub fn tracks_for(ticker: &str) -> Option<&'static str> {
    let t = ticker.trim().to_uppercase();
    MAP.iter().find(|(sym, _)| *sym == t).map(|(_, label)| *label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_funds_get_a_label_and_unknown_ones_get_nothing() {
        assert_eq!(tracks_for("SWPPX"), Some("S&P 500"));
        assert_eq!(tracks_for("swppx"), Some("S&P 500"), "case-insensitive");
        assert_eq!(tracks_for("SOMEFUND"), None, "never guess");
    }
}
```

Create `src-tauri/src/market/profile.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = include_str!("fixtures/yahoo_search_mu.json");

    #[test]
    fn reads_the_matching_quote_out_of_the_real_response() {
        let p = parse_profile(SEARCH, "MU").expect("MU should be found");
        assert_eq!(p.quote_type.as_deref(), Some("EQUITY"));
        assert!(p.long_name.is_some());
        assert!(p.sector.is_some(), "equities carry a sector");
    }

    #[test]
    fn picks_the_exact_symbol_not_merely_the_first_result() {
        const JSON: &str = r#"{"quotes":[
          {"symbol":"MUX","quoteType":"EQUITY","longname":"McEwen Mining","sector":"Basic Materials"},
          {"symbol":"MU","quoteType":"EQUITY","longname":"Micron Technology","sector":"Technology"}
        ]}"#;
        let p = parse_profile(JSON, "MU").unwrap();
        assert_eq!(p.long_name.as_deref(), Some("Micron Technology"));
    }

    #[test]
    fn a_fund_has_a_quote_type_but_no_sector() {
        const JSON: &str = r#"{"quotes":[
          {"symbol":"SWPPX","quoteType":"MUTUALFUND","longname":"Schwab S&P 500 Index Fund"}
        ]}"#;
        let p = parse_profile(JSON, "SWPPX").unwrap();
        assert_eq!(p.quote_type.as_deref(), Some("MUTUALFUND"));
        assert_eq!(p.sector, None);
    }

    #[test]
    fn a_symbol_that_is_not_in_the_response_yields_nothing() {
        assert!(parse_profile(r#"{"quotes":[]}"#, "MU").is_none());
        assert!(parse_profile("not json", "MU").is_none());
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib market::profile`
Expected: FAIL — `cannot find function parse_profile`

- [ ] **Step 4: Write the implementation**

Put above the `mod tests` block in `src-tauri/src/market/profile.rs`:

```rust
//! Per-security profile from Yahoo's keyless search endpoint. The field that
//! matters is `quoteType`: it is what splits held securities into companies
//! (which have news and earnings) and funds (which have neither).
use serde::Serialize;
use serde_json::Value;

/// What the UI needs to place and label a holding. `tracks` is not stored — it
/// is filled from `benchmarks.rs` when the row is read.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SecurityProfile {
    pub security_id: i64,
    pub long_name: Option<String>,
    pub sector: Option<String>,
    pub quote_type: Option<String>,
    pub tracks: Option<String>,
}

/// A profile before it is tied to a security row.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedProfile {
    pub long_name: Option<String>,
    pub sector: Option<String>,
    pub quote_type: Option<String>,
}

pub fn search_url(ticker: &str) -> String {
    format!(
        "https://query1.finance.yahoo.com/v1/finance/search?q={}&newsCount=0",
        ticker.trim().to_uppercase()
    )
}

/// Find the quote whose symbol matches exactly. The endpoint is a search, so
/// the first result is not reliably the ticker asked for — "MU" also matches
/// "MUX".
pub fn parse_profile(body: &str, ticker: &str) -> Option<ParsedProfile> {
    let v: Value = serde_json::from_str(body).ok()?;
    let wanted = ticker.trim().to_uppercase();
    let quotes = v["quotes"].as_array()?;
    let q = quotes.iter().find(|q| {
        q["symbol"].as_str().map(str::to_uppercase).as_deref() == Some(wanted.as_str())
    })?;
    let text = |key: &str| q[key].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Some(ParsedProfile {
        long_name: text("longname").or_else(|| text("shortname")),
        sector: text("sector"),
        quote_type: text("quoteType"),
    })
}

/// Fetch one security's profile. Separate from parsing so parsing stays pure.
pub fn fetch_profile(ticker: &str) -> anyhow::Result<Option<ParsedProfile>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::market::yahoo_news::UA)
        .build()?;
    let body = client.get(search_url(ticker)).send()?.text()?;
    Ok(parse_profile(&body, ticker))
}
```

Append to `src-tauri/src/market/store.rs`, above its `mod tests`:

```rust
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
```

Add to `src-tauri/src/market/store.rs`'s `mod tests`:

```rust
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
    }
```

Add to `src-tauri/src/market/mod.rs`:

```rust
pub mod benchmarks;
pub mod profile;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::`
Expected: PASS — profile 4, benchmarks 1, store 4

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/market
git commit -m "feat(market): security profiles split holdings into companies and funds"
```

---

## Task 6: Pure Nasdaq parsing

Three payloads, and three traps worth knowing before writing the code:
`eps` arrives as a **number** while `consensusForecast` arrives as a **string**;
`epsForecast` is `"$1.05"` with a currency symbol; and the forecast response
contains **two** `rows` arrays, only the first of which is quarterly.

**Files:**
- Create: `src-tauri/src/market/nasdaq_parse.rs`
- Create: `src-tauri/src/market/fixtures/nasdaq_calendar.json`
- Create: `src-tauri/src/market/fixtures/nasdaq_surprise_mu.json`
- Create: `src-tauri/src/market/fixtures/nasdaq_forecast_mu.json`
- Modify: `src-tauri/src/market/mod.rs`

- [ ] **Step 1: Capture the fixtures**

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1"
D=src-tauri/src/market/fixtures
curl -s -A "$UA" "https://api.nasdaq.com/api/calendar/earnings?date=2026-09-11" -o $D/nasdaq_calendar.json
curl -s -A "$UA" "https://api.nasdaq.com/api/company/MU/earnings-surprise" -o $D/nasdaq_surprise_mu.json
curl -s -A "$UA" "https://api.nasdaq.com/api/analyst/MU/earnings-forecast" -o $D/nasdaq_forecast_mu.json
grep -c "rows" $D/nasdaq_calendar.json $D/nasdaq_surprise_mu.json $D/nasdaq_forecast_mu.json
```

Expected: each file reports at least 1. If any is 0, the endpoint changed — stop and report.

- [ ] **Step 2: Write the failing test**

Create `src-tauri/src/market/nasdaq_parse.rs` containing only:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const CALENDAR: &str = include_str!("fixtures/nasdaq_calendar.json");
    const SURPRISE: &str = include_str!("fixtures/nasdaq_surprise_mu.json");
    const FORECAST: &str = include_str!("fixtures/nasdaq_forecast_mu.json");

    #[test]
    fn money_reads_numbers_strings_currency_and_junk() {
        use serde_json::json;
        assert_eq!(money(&json!(24.89)), Some(24.89), "eps arrives as a number");
        assert_eq!(money(&json!("20.98")), Some(20.98), "consensus arrives as a string");
        assert_eq!(money(&json!("$1.05")), Some(1.05), "the calendar adds a currency symbol");
        assert_eq!(money(&json!("($0.31)")), Some(-0.31), "a loss is in brackets");
        assert_eq!(money(&json!("N/A")), None);
        assert_eq!(money(&json!(null)), None);
    }

    #[test]
    fn us_dates_become_iso() {
        assert_eq!(us_date("6/24/2026").as_deref(), Some("2026-06-24"));
        assert_eq!(us_date("12/3/2026").as_deref(), Some("2026-12-03"));
        assert_eq!(us_date("nonsense"), None);
    }

    #[test]
    fn parses_the_real_calendar_into_symbol_keyed_rows() {
        let rows = parse_calendar(CALENDAR);
        assert!(!rows.is_empty(), "the fixture day should list companies");
        let r = &rows[0];
        assert!(!r.symbol.is_empty());
        assert!(r.symbol.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.'));
    }

    #[test]
    fn parses_the_real_surprise_table_into_reported_quarters() {
        let rows = parse_surprise(SURPRISE);
        assert!(!rows.is_empty());
        let r = &rows[0];
        assert!(r.eps_actual.is_some(), "a reported quarter has an actual");
        assert!(r.report_date.len() == 10, "report_date is ISO");
    }

    #[test]
    fn parses_only_the_quarterly_half_of_the_forecast_response() {
        let rows = parse_forecast(FORECAST);
        assert!(!rows.is_empty());
        assert!(rows[0].eps_estimate.is_some());
        assert!(rows[0].eps_actual.is_none(), "a forecast has no actual yet");
        // The payload also carries a yearlyForecast rows array; taking both
        // would mix annual estimates in with quarterly ones.
        assert!(rows.len() <= 8, "quarterly only, not quarterly plus yearly");
    }

    #[test]
    fn a_calendar_row_without_a_symbol_is_skipped() {
        const JSON: &str = r#"{"data":{"rows":[
          {"name":"No symbol here","epsForecast":"$1.00"},
          {"symbol":"MU","epsForecast":"$1.92","noOfEsts":"18"}
        ]}}"#;
        let rows = parse_calendar(JSON);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].symbol, "MU");
        assert_eq!(rows[0].eps_estimate, Some(1.92));
        assert_eq!(rows[0].estimate_count, Some(18));
    }

    #[test]
    fn malformed_json_yields_nothing_rather_than_panicking() {
        assert!(parse_calendar("not json").is_empty());
        assert!(parse_surprise("not json").is_empty());
        assert!(parse_forecast("not json").is_empty());
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test --lib market::nasdaq_parse`
Expected: FAIL — `cannot find function money`

- [ ] **Step 4: Write the implementation**

Put above the `mod tests` block in `src-tauri/src/market/nasdaq_parse.rs`:

```rust
//! Pure parsing of Nasdaq's three keyless earnings payloads. No I/O.
//!
//! Yahoo's `quoteSummary` would normally supply this, but it answers
//! `401 Invalid Crumb` to a plain client — the same anti-bot pattern that
//! killed Stooq. Nasdaq is the replacement, and carries consensus and actuals
//! together, which suits one row serving both "next report" and "beat/miss".
use serde_json::Value;

/// One earnings row, before it is tied to a security.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedEarnings {
    pub symbol: String,
    pub fiscal_period: Option<String>,
    /// ISO `YYYY-MM-DD`.
    pub report_date: String,
    pub eps_actual: Option<f64>,
    pub eps_estimate: Option<f64>,
    pub estimate_count: Option<i64>,
}

/// Nasdaq mixes numbers and strings for the same idea, dresses some in `$`,
/// and puts losses in brackets. Mirrors `simplefin::parse`'s money handling.
pub fn money(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    let raw = v.as_str()?.trim();
    let negative = raw.starts_with('(') && raw.ends_with(')');
    let cleaned: String = raw
        .trim_matches(|c| c == '(' || c == ')')
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    let n: f64 = cleaned.parse().ok()?;
    Some(if negative { -n } else { n })
}

fn count(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    v.as_str()?.trim().replace(',', "").parse().ok()
}

/// `6/24/2026` → `2026-06-24`.
pub fn us_date(raw: &str) -> Option<String> {
    let mut parts = raw.trim().split('/');
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    let y: i32 = parts.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn rows_at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Vec<Value>> {
    let mut node = v;
    for key in path {
        node = node.get(key)?;
    }
    node.as_array()
}

/// The whole market's reports for one date. Callers intersect with holdings.
/// `report_date` is filled in by the caller, which knows the date it asked for.
pub fn parse_calendar(body: &str) -> Vec<ParsedEarnings> {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return vec![] };
    let Some(rows) = rows_at(&v, &["data", "rows"]) else { return vec![] };
    rows.iter()
        .filter_map(|r| {
            let symbol = r["symbol"].as_str()?.trim().to_uppercase();
            if symbol.is_empty() {
                return None;
            }
            Some(ParsedEarnings {
                symbol,
                fiscal_period: r["fiscalQuarterEnding"].as_str().map(str::to_string),
                report_date: String::new(),
                eps_actual: None,
                eps_estimate: money(&r["epsForecast"]),
                estimate_count: count(&r["noOfEsts"]),
            })
        })
        .collect()
}

/// Reported quarters, newest first: actual against consensus.
pub fn parse_surprise(body: &str) -> Vec<ParsedEarnings> {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return vec![] };
    let Some(rows) = rows_at(&v, &["data", "earningsSurpriseTable", "rows"]) else { return vec![] };
    rows.iter()
        .filter_map(|r| {
            Some(ParsedEarnings {
                symbol: String::new(),
                fiscal_period: r["fiscalQtrEnd"].as_str().map(str::to_string),
                report_date: us_date(r["dateReported"].as_str()?)?,
                eps_actual: money(&r["eps"]),
                eps_estimate: money(&r["consensusForecast"]),
                estimate_count: None,
            })
        })
        .collect()
}

/// Upcoming quarters. The response also carries `yearlyForecast`; only the
/// quarterly half is taken, or annual estimates would be mixed in with
/// quarterly ones. Fiscal end is a month like `Aug 2026`, not a report date,
/// so these rows carry no `report_date` — the calendar supplies that.
pub fn parse_forecast(body: &str) -> Vec<ParsedEarnings> {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return vec![] };
    let Some(rows) = rows_at(&v, &["data", "quarterlyForecast", "rows"]) else { return vec![] };
    rows.iter()
        .map(|r| ParsedEarnings {
            symbol: String::new(),
            fiscal_period: r["fiscalEnd"].as_str().map(str::to_string),
            report_date: String::new(),
            eps_actual: None,
            eps_estimate: money(&r["consensusEPSForecast"]),
            estimate_count: count(&r["noOfEstimates"]),
        })
        .collect()
}
```

Add to `src-tauri/src/market/mod.rs`:

```rust
pub mod nasdaq_parse;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::nasdaq_parse`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/market
git commit -m "feat(market): pure Nasdaq earnings parsing with captured fixtures"
```

---

## Task 7: Fetching and storing earnings

**Files:**
- Create: `src-tauri/src/market/nasdaq.rs`
- Modify: `src-tauri/src/market/store.rs`, `src-tauri/src/market/mod.rs`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/market/store.rs`'s `mod tests`:

```rust
    fn earnings(report_date: &str, actual: Option<f64>, est: Option<f64>)
        -> crate::market::nasdaq_parse::ParsedEarnings {
        crate::market::nasdaq_parse::ParsedEarnings {
            symbol: "MU".into(), fiscal_period: Some("May 2026".into()),
            report_date: report_date.into(), eps_actual: actual, eps_estimate: est,
            estimate_count: Some(18),
        }
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib market::store`
Expected: FAIL — `cannot find function upsert_earnings`

- [ ] **Step 3: Write the store functions**

Append to `src-tauri/src/market/store.rs`, above its `mod tests`:

```rust
use crate::market::nasdaq_parse::ParsedEarnings;

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::store`
Expected: PASS, 6 tests

- [ ] **Step 5: Write the HTTP layer**

Create `src-tauri/src/market/nasdaq.rs`:

```rust
//! HTTP for Nasdaq's earnings endpoints. Parsing lives in `nasdaq_parse`.
use crate::market::nasdaq_parse::{parse_calendar, parse_surprise, ParsedEarnings};
use crate::market::yahoo_news::UA;

fn get(url: String) -> anyhow::Result<String> {
    let client = reqwest::blocking::Client::builder().user_agent(UA).build()?;
    Ok(client.get(url).send()?.text()?)
}

/// Every company reporting on one date. Callers intersect with held tickers;
/// this is one request per day rather than one per holding, which is what
/// keeps the politeness budget small.
pub fn calendar_for(date: &str) -> anyhow::Result<Vec<ParsedEarnings>> {
    let body = get(format!("https://api.nasdaq.com/api/calendar/earnings?date={date}"))?;
    let mut rows = parse_calendar(&body);
    for r in &mut rows {
        r.report_date = date.to_string();
    }
    Ok(rows)
}

/// The last four reported quarters for one company: actual against consensus.
pub fn surprise_for(ticker: &str) -> anyhow::Result<Vec<ParsedEarnings>> {
    let t = ticker.trim().to_uppercase();
    let body = get(format!("https://api.nasdaq.com/api/company/{t}/earnings-surprise"))?;
    Ok(parse_surprise(&body))
}

/// The next `days` weekdays from `from`, as ISO dates. Markets are shut at
/// weekends, so asking for them would waste two requests in five.
pub fn upcoming_weekdays(from: chrono::NaiveDate, days: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut d = from;
    while out.len() < days {
        if !matches!(d.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun) {
            out.push(d.format("%Y-%m-%d").to_string());
        }
        d = d.succ_opt().unwrap();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upcoming_weekdays_skips_the_weekend() {
        // 2026-09-11 is a Friday.
        let days = upcoming_weekdays(chrono::NaiveDate::from_ymd_opt(2026, 9, 11).unwrap(), 4);
        assert_eq!(days, vec!["2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16"]);
    }

    /// Hits the network. Run with:
    /// `cargo test --lib live_nasdaq -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn live_nasdaq_calendar_and_surprise_return_rows() {
        let today = chrono::Utc::now().date_naive().format("%Y-%m-%d").to_string();
        let cal = calendar_for(&today).unwrap();
        println!("calendar rows for {today}: {}", cal.len());
        let sup = surprise_for("MU").unwrap();
        assert!(!sup.is_empty(), "MU should have reported quarters");
        assert!(sup[0].eps_actual.is_some());
    }
}
```

Add to `src-tauri/src/market/mod.rs`:

```rust
pub mod nasdaq;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::nasdaq`
Expected: PASS, 1 test (1 ignored)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/market
git commit -m "feat(market): fetch and store earnings from Nasdaq"
```

---

## Task 8: Index levels and the market strip data

**Files:**
- Create: `src-tauri/src/market/indices.rs`
- Modify: `src-tauri/src/market/store.rs`, `src-tauri/src/market/mod.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/market/indices.rs`:

```rust
//! Index levels for the market strip. Reuses the existing Yahoo chart endpoint
//! and its parser, so there is no new parsing to test — only the symbol list
//! and the storage shape.
//!
//! These deliberately do not go in `securities`: the S&P would then appear in
//! Holdings and in the allocation chart as though it were owned.

/// The indices the market strip shows, with the labels the UI uses.
pub const INDICES: &[(&str, &str)] = &[
    ("^GSPC", "S&P 500"),
    ("^IXIC", "Nasdaq"),
    ("^DJI", "Dow"),
];

pub fn label_for(symbol: &str) -> Option<&'static str> {
    INDICES.iter().find(|(s, _)| *s == symbol).map(|(_, l)| *l)
}

/// Fetch the last few daily closes for one index, oldest first.
pub fn fetch_closes(symbol: &str) -> anyhow::Result<Vec<(String, f64)>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::market::yahoo_news::UA)
        .build()?;
    let url = crate::prices::yahoo::chart_url(symbol, crate::prices::yahoo::RECENT_RANGE);
    let body = client.get(url).send()?.text()?;
    Ok(crate::prices::yahoo::parse_chart_json(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_index_has_a_label() {
        assert_eq!(label_for("^GSPC"), Some("S&P 500"));
        assert_eq!(label_for("^NOTREAL"), None);
    }

    /// Hits the network. Run with:
    /// `cargo test --lib live_index_closes -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn live_index_closes_returns_at_least_two_days() {
        let closes = fetch_closes("^GSPC").unwrap();
        assert!(closes.len() >= 2, "the strip needs latest and previous");
    }
}
```

Add to `src-tauri/src/market/store.rs`'s `mod tests`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib market::store`
Expected: FAIL — `cannot find function upsert_index_closes`

- [ ] **Step 3: Write the store functions**

Append to `src-tauri/src/market/store.rs`, above its `mod tests`:

```rust
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
```

Add to `src-tauri/src/market/mod.rs`:

```rust
pub mod indices;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::`
Expected: PASS — store 8, indices 1

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/market
git commit -m "feat(market): index levels for the market strip"
```

---

## Task 9: Refresh orchestration and Tauri commands

**Files:**
- Create: `src-tauri/src/commands/market.rs`
- Modify: `src-tauri/src/market/mod.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/market/mod.rs` (below the `pub mod` lines from earlier tasks):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn a_refresh_report_starts_empty_and_collects_errors() {
        let mut report = MarketRefreshReport::default();
        assert_eq!(report.news_added, 0);
        report.errors.push("MU: timed out".into());
        assert_eq!(report.errors.len(), 1);
    }

    #[test]
    fn equities_are_the_only_securities_worth_a_news_request() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('SWPPX','etf','USD')", []).unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
             VALUES ('B','brokerage','USD','2026-01-01','simplefin','x')", []).unwrap();
        for id in [1, 2] {
            conn.execute(
                "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
                 VALUES (1,?1,10,100,120,'2026-09-10')", [id]).unwrap();
        }
        let equity = crate::market::profile::ParsedProfile {
            long_name: Some("Micron".into()), sector: Some("Technology".into()),
            quote_type: Some("EQUITY".into()),
        };
        let fund = crate::market::profile::ParsedProfile {
            long_name: Some("Schwab S&P 500".into()), sector: None,
            quote_type: Some("MUTUALFUND".into()),
        };
        store::upsert_profile(&conn, 1, &equity, "2026-09-10T00:00:00Z").unwrap();
        store::upsert_profile(&conn, 2, &fund, "2026-09-10T00:00:00Z").unwrap();

        let targets = news_targets(&conn).unwrap();
        assert_eq!(targets, vec![(1, "MU".to_string())],
            "an index fund has no company news to fetch");
    }

    #[test]
    fn age_days_treats_an_unparseable_stamp_as_ancient_so_it_refetches() {
        assert_eq!(age_days("2026-09-03T00:00:00Z", "2026-09-10T00:00:00Z"), 7);
        assert_eq!(age_days("2026-09-10T00:00:00Z", "2026-09-10T06:00:00Z"), 0);
        assert_eq!(age_days("rubbish", "2026-09-10T00:00:00Z"), i64::MAX);
    }

    #[test]
    fn a_security_with_no_profile_yet_is_still_worth_asking_about() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO securities (ticker,type,currency) VALUES ('MU','stock','USD')", []).unwrap();
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
             VALUES ('B','brokerage','USD','2026-01-01','simplefin','x')", []).unwrap();
        conn.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (1,1,10,100,120,'2026-09-10')", []).unwrap();
        // No profile row yet — the first refresh must not skip it for ever.
        assert_eq!(news_targets(&conn).unwrap(), vec![(1, "MU".to_string())]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib market::tests`
Expected: FAIL — `cannot find type MarketRefreshReport`

- [ ] **Step 3: Add the two staleness lookups to the store**

Append to `src-tauri/src/market/store.rs`, above its `mod tests`:

```rust
/// When this security's profile was last fetched, if ever.
pub fn profile_updated_at(conn: &Connection, security_id: i64) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT updated_at FROM security_profile WHERE security_id=?1")?;
    let mut rows = stmt.query([security_id])?;
    match rows.next()? {
        Some(r) => Ok(Some(r.get(0)?)),
        None => Ok(None),
    }
}

/// When any earnings row was last written, if ever. Earnings move once a
/// quarter, so this gates a daily refresh rather than a 30-minute one.
pub fn earnings_last_updated(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT MAX(updated_at) FROM earnings_events", [], |r| r.get(0))
}
```

Add to `src-tauri/src/market/store.rs`'s `mod tests`:

```rust
    #[test]
    fn staleness_lookups_report_nothing_before_a_first_fetch() {
        let conn = db::open_in_memory().unwrap();
        seed(&conn);
        assert_eq!(profile_updated_at(&conn, 1).unwrap(), None);
        assert_eq!(earnings_last_updated(&conn).unwrap(), None);

        upsert_earnings(&conn, 1, &[earnings("2026-09-23", None, Some(1.92))], "2026-09-10T12:00:00Z").unwrap();
        assert_eq!(earnings_last_updated(&conn).unwrap().as_deref(), Some("2026-09-10T12:00:00Z"));
    }
```

- [ ] **Step 4: Write the orchestration**

Replace the contents of `src-tauri/src/market/mod.rs` with this, keeping the
`mod tests` block from Step 1 at the bottom:

```rust
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

/// Whole days between two RFC 3339 stamps. An unparseable stamp reads as
/// ancient, so a bad value causes a refetch rather than a permanent skip.
fn age_days(then: &str, now: &str) -> i64 {
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).ok();
    match (parse(then), parse(now)) {
        (Some(a), Some(b)) => (b - a).num_days(),
        _ => i64::MAX,
    }
}

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
    // barely changes, so it is refetched weekly — refetching all 11 on every
    // 30-minute news poll would quadruple the request budget for nothing.
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
    // difference between ~6 requests per poll and ~27.
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib market::`
Expected: PASS, all market tests

- [ ] **Step 6: Write the commands**

Create `src-tauri/src/commands/market.rs`:

```rust
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

#[tauri::command]
pub fn market_refresh(db: tauri::State<Db>) -> Result<market::MarketRefreshReport, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    Ok(market::refresh_all(&conn))
}
```

Add to `src-tauri/src/commands/mod.rs`:

```rust
pub mod market;
```

Add to the `tauri::generate_handler!` list in `src-tauri/src/lib.rs`, after the
budget entries:

```rust
            commands::market::market_news_list,
            commands::market::market_earnings_list,
            commands::market::market_profiles_list,
            commands::market::market_indices,
            commands::market::market_refresh,
```

- [ ] **Step 7: Verify the whole Rust suite passes**

Run: `cd src-tauri && cargo test --lib && cargo clippy --lib --all-targets 2>&1 | grep -E "^(warning|error)"`
Expected: all tests PASS. Clippy shows only the two pre-existing `parse_daily_csv` / `daily_url` dead-code warnings — any new warning must be fixed before committing.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src
git commit -m "feat(market): refresh orchestration and Tauri commands"
```

---

## Task 10: TypeScript types, API and query hooks

**Files:**
- Modify: `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts`

- [ ] **Step 1: Add the types**

Append to `src/domain/types.ts`:

```ts
export interface NewsItem {
  security_id: number; title: string; summary: string | null; url: string;
  publisher: string | null; published: string; fetched_at: string;
}
export interface EarningsEvent {
  security_id: number; fiscal_period: string | null; report_date: string;
  eps_actual: number | null; eps_estimate: number | null; estimate_count: number | null;
}
export interface SecurityProfile {
  security_id: number; long_name: string | null; sector: string | null;
  quote_type: string | null; tracks: string | null;
}
export interface IndexQuote { symbol: string; label: string; latest: number; previous: number; }
export interface MarketRefreshReport {
  news_added: number; profiles_updated: number; earnings_updated: number;
  indices_updated: number; errors: string[];
}
```

- [ ] **Step 2: Add the API calls**

In `src/data/api.ts`, extend the type import with the new names:

```ts
import type {
  Account, Security, Transaction, Snapshot,
  SyncedHolding, SyncReport, SimplefinStatus,
  Category, BankTransaction, CategoryRule, Budget,
  NewAccount, NewTransaction,
  NewsItem, EarningsEvent, SecurityProfile, IndexQuote, MarketRefreshReport,
} from "../domain/types";
```

Add this entry to the `api` object, after `simplefin`:

```ts
  market: {
    news: () => invoke<NewsItem[]>("market_news_list"),
    earnings: () => invoke<EarningsEvent[]>("market_earnings_list"),
    profiles: () => invoke<SecurityProfile[]>("market_profiles_list"),
    indices: () => invoke<IndexQuote[]>("market_indices"),
    refresh: () => invoke<MarketRefreshReport>("market_refresh"),
  },
```

- [ ] **Step 3: Add the query hooks**

In `src/data/queries.ts`, add to the `keys` object:

```ts
  marketNews: ["market", "news"] as const,
  marketEarnings: ["market", "earnings"] as const,
  marketProfiles: ["market", "profiles"] as const,
  marketIndices: ["market", "indices"] as const,
```

Add below the other `useQuery` exports:

```ts
export const useMarketNews = () => useQuery({ queryKey: keys.marketNews, queryFn: api.market.news });
export const useMarketEarnings = () => useQuery({ queryKey: keys.marketEarnings, queryFn: api.market.earnings });
export const useMarketProfiles = () => useQuery({ queryKey: keys.marketProfiles, queryFn: api.market.profiles });
export const useMarketIndices = () => useQuery({ queryKey: keys.marketIndices, queryFn: api.market.indices });

/** A market refresh can change all four, so they are invalidated together. */
export function useMarketRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.market.refresh(),
    onSettled: () => {
      for (const k of [keys.marketNews, keys.marketEarnings, keys.marketProfiles, keys.marketIndices]) {
        qc.invalidateQueries({ queryKey: k });
      }
    },
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/data/api.ts src/data/queries.ts
git commit -m "feat(market): types, api and query hooks for the Markets screen"
```

---

## Task 11: The view model — pure assembly

**Files:**
- Create: `src/domain/market.ts`
- Create: `src/domain/market.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/market.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildMarketView } from "./market";
import type { Security, SecurityProfile, NewsItem, EarningsEvent, IndexQuote } from "./types";

const securities: Security[] = [
  { id: 1, ticker: "MU", name: null, type: "stock", currency: "USD" },
  { id: 2, ticker: "GOOG", name: null, type: "stock", currency: "USD" },
  { id: 3, ticker: "SWPPX", name: null, type: "etf", currency: "USD" },
];
const profiles: SecurityProfile[] = [
  { security_id: 1, long_name: "Micron", sector: "Technology", quote_type: "EQUITY", tracks: null },
  { security_id: 2, long_name: "Alphabet", sector: "Technology", quote_type: "EQUITY", tracks: null },
  { security_id: 3, long_name: "Schwab S&P 500", sector: null, quote_type: "MUTUALFUND", tracks: "S&P 500" },
];
const news = (security_id: number, title: string, published: string): NewsItem =>
  ({ security_id, title, summary: null, url: "https://x.test/a", publisher: "reuters.com",
     published, fetched_at: "2026-09-10T12:00:00Z" });
const holdings = new Map([[1, 900], [2, 1400], [3, 3400]]);
const dayChange = new Map([[1, 3.8], [2, 0.9], [3, 0.42]]);
const indices: IndexQuote[] = [{ symbol: "^GSPC", label: "S&P 500", latest: 101, previous: 100 }];

const base = {
  securities, profiles, holdings, dayChange, indices,
  news: [] as NewsItem[], earnings: [] as EarningsEvent[],
  today: "2026-09-10",
};

describe("buildMarketView", () => {
  it("splits holdings into companies and funds by quote_type", () => {
    const v = buildMarketView(base);
    expect(v.companies.map((r) => r.ticker)).toEqual(["MU", "GOOG"]);
    expect(v.funds.map((r) => r.ticker)).toEqual(["SWPPX"]);
    expect(v.funds[0].tracks).toBe("S&P 500");
  });

  it("orders companies by size of move, not alphabetically", () => {
    const v = buildMarketView({ ...base, dayChange: new Map([[1, -0.4], [2, 5.2], [3, 0]]) });
    expect(v.companies.map((r) => r.ticker)).toEqual(["GOOG", "MU"]);
  });

  it("a big fall outranks a small rise", () => {
    const v = buildMarketView({ ...base, dayChange: new Map([[1, -6.0], [2, 1.0], [3, 0]]) });
    expect(v.companies[0].ticker).toBe("MU");
  });

  it("attaches each company's newest headlines", () => {
    const v = buildMarketView({ ...base, news: [
      news(1, "older", "2026-09-09T10:00:00Z"),
      news(1, "newest", "2026-09-10T10:00:00Z"),
      news(2, "alphabet news", "2026-09-10T09:00:00Z"),
    ]});
    const mu = v.companies.find((r) => r.ticker === "MU")!;
    expect(mu.news.map((n) => n.title)).toEqual(["newest", "older"]);
  });

  it("a holding with no news still appears, so a quiet row never looks like a bug", () => {
    const v = buildMarketView(base);
    expect(v.companies).toHaveLength(2);
    expect(v.companies[0].news).toEqual([]);
  });

  it("a security with no profile yet is treated as a company rather than dropped", () => {
    const v = buildMarketView({ ...base, profiles: [] });
    expect(v.companies.map((r) => r.ticker)).toEqual(["SWPPX", "MU", "GOOG"]);
    expect(v.funds).toEqual([]);
  });

  it("leaves out securities with no position", () => {
    const v = buildMarketView({ ...base, holdings: new Map([[1, 900]]) });
    expect(v.companies.map((r) => r.ticker)).toEqual(["MU"]);
    expect(v.funds).toEqual([]);
  });

  it("picks the next report ahead and the most recent one behind", () => {
    const earnings: EarningsEvent[] = [
      { security_id: 1, fiscal_period: "Feb 2026", report_date: "2026-03-20",
        eps_actual: 1.18, eps_estimate: 1.21, estimate_count: null },
      { security_id: 1, fiscal_period: "May 2026", report_date: "2026-09-08",
        eps_actual: 1.79, eps_estimate: 1.60, estimate_count: null },
      { security_id: 1, fiscal_period: "Aug 2026", report_date: "2026-09-23",
        eps_actual: null, eps_estimate: 1.92, estimate_count: 18 },
    ];
    const mu = buildMarketView({ ...base, earnings }).companies.find((r) => r.ticker === "MU")!;
    expect(mu.nextEarnings?.report_date).toBe("2026-09-23");
    expect(mu.lastEarnings?.report_date).toBe("2026-09-08");
    expect(mu.lastEarnings?.beat).toBe(true);
  });

  it("marks a miss as a miss", () => {
    const earnings: EarningsEvent[] = [
      { security_id: 1, fiscal_period: "Feb 2026", report_date: "2026-09-08",
        eps_actual: 1.18, eps_estimate: 1.21, estimate_count: null },
    ];
    const mu = buildMarketView({ ...base, earnings }).companies.find((r) => r.ticker === "MU")!;
    expect(mu.lastEarnings?.beat).toBe(false);
  });

  it("builds a calendar of reports within the next 14 days only", () => {
    const earnings: EarningsEvent[] = [
      { security_id: 1, fiscal_period: null, report_date: "2026-09-12",
        eps_actual: null, eps_estimate: 1.92, estimate_count: null },
      { security_id: 2, fiscal_period: null, report_date: "2026-11-01",
        eps_actual: null, eps_estimate: 2.0, estimate_count: null },
    ];
    const v = buildMarketView({ ...base, earnings });
    expect(v.calendar.map((d) => d.date)).toEqual(["2026-09-12"]);
    expect(v.calendar[0].tickers).toEqual(["MU"]);
  });

  it("turns index closes into a percentage move", () => {
    const v = buildMarketView(base);
    expect(v.indices[0].label).toBe("S&P 500");
    expect(v.indices[0].changePct).toBeCloseTo(1.0, 5);
  });

  it("reports the newest fetch time so staleness can be shown", () => {
    const v = buildMarketView({ ...base, news: [
      news(1, "a", "2026-09-09T10:00:00Z"),
      news(2, "b", "2026-09-10T10:00:00Z"),
    ]});
    expect(v.newestFetch).toBe("2026-09-10T12:00:00Z");
  });

  it("has no fetch time at all before the first refresh", () => {
    expect(buildMarketView(base).newestFetch).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/market.test.ts`
Expected: FAIL — cannot resolve `./market`

- [ ] **Step 3: Write the implementation**

Create `src/domain/market.ts`:

```ts
import type {
  Security, SecurityProfile, NewsItem, EarningsEvent, IndexQuote,
} from "./types";

/** How far ahead the earnings strip looks. */
export const CALENDAR_DAYS = 14;

export interface ReportedEarnings extends EarningsEvent {
  /** Actual at or above consensus. Undefined when either figure is missing. */
  beat?: boolean;
}

export interface MarketRow {
  security_id: number;
  ticker: string;
  name: string | null;
  value: number;
  dayChangePct: number;
  tracks: string | null;
  news: NewsItem[];
  nextEarnings?: EarningsEvent;
  lastEarnings?: ReportedEarnings;
}

export interface IndexRow { symbol: string; label: string; changePct: number; }
export interface CalendarDay { date: string; tickers: string[]; }

export interface MarketView {
  indices: IndexRow[];
  companies: MarketRow[];
  funds: MarketRow[];
  calendar: CalendarDay[];
  /** Newest `fetched_at` across all cached news, or null before a first refresh. */
  newestFetch: string | null;
}

export interface MarketInputs {
  securities: Security[];
  profiles: SecurityProfile[];
  news: NewsItem[];
  earnings: EarningsEvent[];
  indices: IndexQuote[];
  /** Market value per security_id. A security absent here is not held. */
  holdings: Map<number, number>;
  /** Day change as a percentage, per security_id. */
  dayChange: Map<number, number>;
  /** Today as `YYYY-MM-DD`. Passed in so the function stays pure. */
  today: string;
}

function shiftDays(date: string, by: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/**
 * Assemble everything the Markets screen renders.
 *
 * A security with no profile yet is treated as a company: the alternative is
 * hiding a holding until its first profile fetch lands, which reads as data
 * loss. Funds are only ever those explicitly typed as ETF or MUTUALFUND.
 */
export function buildMarketView(i: MarketInputs): MarketView {
  const profileOf = new Map(i.profiles.map((p) => [p.security_id, p]));
  const newsOf = new Map<number, NewsItem[]>();
  for (const n of i.news) {
    const list = newsOf.get(n.security_id) ?? [];
    list.push(n);
    newsOf.set(n.security_id, list);
  }
  for (const list of newsOf.values()) list.sort((a, b) => b.published.localeCompare(a.published));

  const held = i.securities.filter((s) => (i.holdings.get(s.id) ?? 0) > 0);

  const row = (s: Security): MarketRow => {
    const p = profileOf.get(s.id);
    const mine = i.earnings.filter((e) => e.security_id === s.id);
    const ahead = mine.filter((e) => e.report_date >= i.today)
      .sort((a, b) => a.report_date.localeCompare(b.report_date));
    const behind = mine.filter((e) => e.report_date < i.today && e.eps_actual != null)
      .sort((a, b) => b.report_date.localeCompare(a.report_date));
    const last = behind[0];
    return {
      security_id: s.id,
      ticker: s.ticker,
      name: p?.long_name ?? s.name,
      value: i.holdings.get(s.id) ?? 0,
      dayChangePct: i.dayChange.get(s.id) ?? 0,
      tracks: p?.tracks ?? null,
      news: newsOf.get(s.id) ?? [],
      nextEarnings: ahead[0],
      lastEarnings: last && {
        ...last,
        beat: last.eps_actual != null && last.eps_estimate != null
          ? last.eps_actual >= last.eps_estimate
          : undefined,
      },
    };
  };

  const isFund = (s: Security) => {
    const q = profileOf.get(s.id)?.quote_type;
    return q === "ETF" || q === "MUTUALFUND";
  };

  // Biggest mover first: alphabetical would bury what the screen exists to show.
  const companies = held.filter((s) => !isFund(s)).map(row)
    .sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct));
  const funds = held.filter(isFund).map(row)
    .sort((a, b) => b.value - a.value);

  const horizon = shiftDays(i.today, CALENDAR_DAYS);
  const byDate = new Map<string, string[]>();
  for (const s of held) {
    for (const e of i.earnings) {
      if (e.security_id !== s.id) continue;
      if (e.report_date < i.today || e.report_date > horizon) continue;
      const list = byDate.get(e.report_date) ?? [];
      if (!list.includes(s.ticker)) list.push(s.ticker);
      byDate.set(e.report_date, list);
    }
  }
  const calendar: CalendarDay[] = [...byDate.entries()]
    .map(([date, tickers]) => ({ date, tickers }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const fetchTimes = i.news.map((n) => n.fetched_at).sort();
  return {
    indices: i.indices.map((q) => ({
      symbol: q.symbol, label: q.label,
      changePct: q.previous === 0 ? 0 : ((q.latest - q.previous) / q.previous) * 100,
    })),
    companies,
    funds,
    calendar,
    newestFetch: fetchTimes.length ? fetchTimes[fetchTimes.length - 1] : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/domain/market.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/domain/market.ts src/domain/market.test.ts
git commit -m "feat(market): pure view-model assembly for the Markets screen"
```

---

## Task 12: The refresh schedule

**Files:**
- Create: `src/data/marketSchedule.ts`
- Create: `src/data/marketSchedule.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/data/marketSchedule.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { planNextMarketTick, NEWS_MARKET_HOURS_MS, NEWS_OFF_HOURS_MS, HIDDEN_RECHECK_MS } from "./marketSchedule";

// 2026-09-10 is a Thursday. 14:00 UTC is 10:00 in New York — market open.
const open = new Date("2026-09-10T14:00:00Z");
const closed = new Date("2026-09-10T23:00:00Z");

describe("planNextMarketTick", () => {
  it("does not fetch while the window is hidden", () => {
    const tick = planNextMarketTick(open, false, null);
    expect(tick.fetch).toBe(false);
    expect(tick.delayMs).toBe(HIDDEN_RECHECK_MS);
  });

  it("polls every 30 minutes while the market is open", () => {
    expect(planNextMarketTick(open, true, null).delayMs).toBe(NEWS_MARKET_HOURS_MS);
  });

  it("backs off to two hours outside market hours", () => {
    expect(planNextMarketTick(closed, true, null).delayMs).toBe(NEWS_OFF_HOURS_MS);
  });

  it("fetches immediately when nothing has ever been fetched", () => {
    expect(planNextMarketTick(open, true, null).fetch).toBe(true);
  });

  it("skips a fetch when the cache is younger than the interval", () => {
    const justNow = new Date(open.getTime() - 60_000).toISOString();
    expect(planNextMarketTick(open, true, justNow).fetch).toBe(false);
  });

  it("fetches once the cache is older than the interval", () => {
    const stale = new Date(open.getTime() - 31 * 60_000).toISOString();
    expect(planNextMarketTick(open, true, stale).fetch).toBe(true);
  });

  it("treats an unparseable timestamp as no cache at all", () => {
    expect(planNextMarketTick(open, true, "not a date").fetch).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/marketSchedule.test.ts`
Expected: FAIL — cannot resolve `./marketSchedule`

- [ ] **Step 3: Write the implementation**

Create `src/data/marketSchedule.ts`:

```ts
/**
 * When to refresh news and earnings, as a pure decision so it can be tested
 * without timers — the same shape as `refreshSchedule.ts`.
 *
 * This is a politeness budget as much as a freshness one. Each refresh makes
 * one RSS request per held company, sequentially. Six companies every 30
 * minutes is 12 requests an hour, against the ~660 an hour the price refresh
 * already makes. Shortening this interval multiplies by the number of
 * holdings, which is exactly how Stooq was lost.
 */
import { isUsMarketOpen } from "./refreshSchedule";

export const NEWS_MARKET_HOURS_MS = 30 * 60_000;
export const NEWS_OFF_HOURS_MS = 2 * 60 * 60_000;
export const HIDDEN_RECHECK_MS = 5 * 60_000;

export interface MarketTick {
  fetch: boolean;
  delayMs: number;
}

/**
 * `lastFetchedAt` is the newest cached fetch time, or null when nothing has
 * been fetched. Checking it means reopening the screen does not trigger a
 * fetch when the cache is still warm.
 */
export function planNextMarketTick(
  now: Date,
  visible: boolean,
  lastFetchedAt: string | null,
): MarketTick {
  if (!visible) return { fetch: false, delayMs: HIDDEN_RECHECK_MS };
  const delayMs = isUsMarketOpen(now) ? NEWS_MARKET_HOURS_MS : NEWS_OFF_HOURS_MS;
  const age = lastFetchedAt ? now.getTime() - Date.parse(lastFetchedAt) : NaN;
  const fetch = Number.isNaN(age) || age >= delayMs;
  return { fetch, delayMs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/data/marketSchedule.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/data/marketSchedule.ts src/data/marketSchedule.test.ts
git commit -m "feat(market): pure refresh cadence for news and earnings"
```

---

## Task 13: The Markets screen

**Files:**
- Create: `src/features/markets/Markets.tsx`
- Create: `src/features/markets/useMarketView.ts`
- Modify: `src/app/icons.tsx`, `src/app/IconRail.tsx`, `src/App.tsx`

- [ ] **Step 1: Add the rail icon**

In `src/app/icons.tsx`, add a `markets` entry alongside the existing ones,
following the same shape as the others in that file (a function returning an
`<svg>` with `width="20" height="20" viewBox="0 0 24 24" fill="none"
stroke="currentColor" strokeWidth="1.7"`):

```tsx
  markets: () => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l5-6 4 4 6-8" />
      <path d="M14 7h5v5" />
    </svg>
  ),
```

In `src/app/IconRail.tsx`, add to the `links` array after Holdings:

```tsx
  { to: "/markets", label: "Markets", icon: Icons.markets },
```

In `src/App.tsx`, import the screen and add the route after `holdings`:

```tsx
import { Markets } from "./features/markets/Markets";
```

```tsx
      { path: "markets", element: <Markets /> },
```

- [ ] **Step 2: Write the hook that feeds the screen**

Create `src/features/markets/useMarketView.ts`:

```ts
import { useMemo } from "react";
import {
  useSecurities, useMarketNews, useMarketEarnings, useMarketProfiles,
  useMarketIndices, useLatestPrices, usePreviousPrices,
} from "../../data/queries";
import { usePortfolio } from "../../data/usePortfolio";
import { buildMarketView } from "../../domain/market";

/**
 * Everything the Markets screen needs, assembled by the pure
 * `buildMarketView`.
 *
 * `Holding` carries no per-security day change — only the portfolio summary
 * has one — so it is derived here from the same latest and previous closes the
 * Dashboard's day-change figure uses. Market values come from `usePortfolio`,
 * so the two screens cannot disagree about what is held.
 */
export function useMarketView() {
  const { data: securities = [] } = useSecurities();
  const { data: news = [] } = useMarketNews();
  const { data: earnings = [] } = useMarketEarnings();
  const { data: profiles = [] } = useMarketProfiles();
  const { data: indices = [] } = useMarketIndices();
  const { data: latest = [] } = useLatestPrices();
  const { data: previous = [] } = usePreviousPrices();
  const { holdings, summary } = usePortfolio();

  return useMemo(() => {
    const latestMap = new Map<number, number>(latest);
    const prevMap = new Map<number, number>(previous);

    const value = new Map<number, number>();
    const dayChange = new Map<number, number>();
    for (const h of holdings) {
      value.set(h.security_id, h.marketValue);
      const now = latestMap.get(h.security_id);
      const before = prevMap.get(h.security_id);
      // No previous close means we cannot know today's move. Zero is the
      // honest answer; a made-up percentage is not.
      dayChange.set(
        h.security_id,
        now != null && before != null && before !== 0 ? ((now - before) / before) * 100 : 0,
      );
    }

    const view = buildMarketView({
      securities, profiles, news, earnings, indices,
      holdings: value, dayChange,
      today: new Date().toISOString().slice(0, 10),
    });
    return { view, you: summary.dayChangePct };
  }, [securities, profiles, news, earnings, indices, latest, previous, holdings, summary]);
}
```

Note two things this relies on, both verified against the current code:
`PortfolioSummary` already carries `dayChangePct`, so "You" is read straight
off it rather than recomputed; and `useLatestPrices` / `usePreviousPrices`
return `[security_id, close][]` pairs, which is why they are fed into `new Map`.

- [ ] **Step 3: Write the screen**

Create `src/features/markets/Markets.tsx`:

```tsx
import { PageHeader, Card, Button, Badge, EmptyState } from "../../ui/components";
import { money, pct, timeAgo } from "../../ui/format";
import { useMarketRefresh } from "../../data/queries";
import { useMarketView } from "./useMarketView";
import type { MarketRow } from "../../domain/market";

// `pct` already supplies its own +/- sign, so do not add another.
// `.pos` and `.neg` are existing classes in styles.css.
function Move({ value }: { value: number }) {
  const tone = value > 0 ? "pos" : value < 0 ? "neg" : undefined;
  return <span className={tone}>{pct(value)}</span>;
}

function CompanyRow({ r }: { r: MarketRow }) {
  return (
    <div className="market-row">
      <div className="market-row-head">
        <span className="cell-primary">{r.ticker}</span>
        <Move value={r.dayChangePct} />
        {r.nextEarnings && <Badge tone="accent">Reports {r.nextEarnings.report_date}</Badge>}
        {r.lastEarnings?.beat !== undefined && (
          <Badge>{r.lastEarnings.beat ? "Beat" : "Missed"} last quarter</Badge>
        )}
        <span className="cell-secondary">{r.name ?? ""}</span>
        <span className="cell-secondary">{money(r.value)}</span>
      </div>
      {r.news.length === 0
        ? <div className="cell-secondary">No headlines today.</div>
        : r.news.map((n) => (
            <div key={n.url} className="cell-secondary">
              <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
              {" — "}{n.publisher ?? "unknown"} · {timeAgo(n.published)}
            </div>
          ))}
    </div>
  );
}

export function Markets() {
  const { view, you } = useMarketView();
  const refresh = useMarketRefresh();

  return (
    <>
      <PageHeader subtitle="What happened to what you own" />

      <Card title="Today" actions={
        <Button size="sm" loading={refresh.isPending} onClick={() => refresh.mutate()}>Refresh</Button>
      }>
        <div className="row center" style={{ gap: 18, flexWrap: "wrap" }}>
          {view.indices.map((i) => (
            <div key={i.symbol}>
              <div className="cell-secondary">{i.label}</div>
              <div className="cell-primary"><Move value={i.changePct} /></div>
            </div>
          ))}
          <div>
            <div className="cell-secondary">You</div>
            <div className="cell-primary"><Move value={you} /></div>
          </div>
        </div>
        {view.newestFetch && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            News as of {timeAgo(view.newestFetch)}.
          </p>
        )}
      </Card>

      <Card title="Your companies" subtitle="Biggest movers first. Headlines are shown beside moves, not as their cause.">
        {view.companies.length === 0
          ? <EmptyState title="No companies held"
              body="Individual stocks appear here once you hold them. Press Refresh to fetch headlines." />
          : view.companies.map((r) => <CompanyRow key={r.security_id} r={r} />)}
      </Card>

      <Card title="Your funds" subtitle="Index funds have no company news — what they track is the story.">
        {view.funds.length === 0
          ? <EmptyState title="No funds held" body="Index funds and ETFs appear here." />
          : view.funds.map((r) => (
              <div key={r.security_id} className="market-row-head">
                <span className="cell-primary">{r.ticker}</span>
                <span className="cell-secondary">{r.tracks ?? r.name ?? ""}</span>
                <Move value={r.dayChangePct} />
                <span className="cell-secondary">{money(r.value)}</span>
              </div>
            ))}
      </Card>

      <Card title="Earnings — next 14 days">
        {view.calendar.length === 0
          ? <p className="muted">Nothing you hold reports in the next two weeks.</p>
          : <div className="row center" style={{ gap: 12, flexWrap: "wrap" }}>
              {view.calendar.map((d) => (
                <div key={d.date} className="market-day">
                  <div className="cell-secondary">{d.date}</div>
                  <div className="cell-primary">{d.tickers.join(", ")}</div>
                </div>
              ))}
            </div>}
      </Card>
    </>
  );
}
```

All helpers used above were checked against the current code and exist with
these names and shapes: `money`, `pct` and `timeAgo` in `src/ui/format.ts`;
`PageHeader`, `Card`, `Button`, `Badge` and `EmptyState` in
`src/ui/components.tsx`, with `Badge` accepting
`tone="neutral" | "accent" | "pos" | "neg" | "warn"`.

`pct(3.8)` returns `"+3.8%"` — it takes a percentage, not a fraction, and adds
its own sign.

- [ ] **Step 4: Add the CSS**

Append to `src/styles.css`. `--line`, `.pos`, `.neg`, `.cell-primary` and
`.cell-secondary` already exist; only these three rules are new:

```css
.market-row { padding: 10px 0; border-bottom: 1px solid var(--line); }
.market-row:last-child { border-bottom: 0; }
.market-row-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.market-row-head .cell-secondary:last-child { margin-left: auto; }
.market-day { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
```

- [ ] **Step 5: Typecheck and run the whole suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no tsc output; all tests PASS

- [ ] **Step 6: Run the app and look at it**

Run: `npm run tauri dev`

Then: click the new Markets icon, press **Refresh**, and confirm
1. the market strip fills in with three indices and "You";
2. your five held companies appear, biggest mover first, with headlines;
3. SWPPX and the other funds appear under "Your funds" with what they track;
4. no company appears in both lists.

The first Refresh makes roughly 30 requests and takes a few seconds — profiles
for every held security, then news, then ten calendar days, then surprises.

- [ ] **Step 7: Commit**

```bash
git add src/features/markets src/app/icons.tsx src/app/IconRail.tsx src/App.tsx src/styles.css
git commit -m "feat(market): the Markets screen"
```

---

## Task 14: Wire the refresh timer

**Files:**
- Modify: `src/features/markets/Markets.tsx`

- [ ] **Step 1: Add the timer effect**

In `src/features/markets/Markets.tsx`, add these imports:

```tsx
import { useEffect, useRef } from "react";
import { planNextMarketTick } from "../../data/marketSchedule";
```

Add inside the `Markets` component, after `const refresh = useMarketRefresh();`:

```tsx
  // A slow poll while the screen is open. The cadence is decided by a pure
  // function so it is unit-tested; this effect only obeys it. Nothing fetches
  // while the window is hidden, and a warm cache is left alone.
  const busy = useRef(false);
  useEffect(() => {
    let timer: number;
    const tick = () => {
      const plan = planNextMarketTick(new Date(), !document.hidden, view.newestFetch);
      if (plan.fetch && !busy.current) {
        busy.current = true;
        refresh.mutate(undefined, { onSettled: () => { busy.current = false; } });
      }
      timer = window.setTimeout(tick, plan.delayMs);
    };
    timer = window.setTimeout(tick, 1000);
    return () => window.clearTimeout(timer);
    // `refresh` and `view.newestFetch` are read through closures that the
    // timeout recreates on each tick, so the effect itself runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 2: Typecheck and test**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no tsc output; all tests PASS

- [ ] **Step 3: Verify the poll does not stampede**

Run: `npm run tauri dev`, open Markets, and leave it for a minute. The Refresh
button should flash busy once shortly after opening (or not at all if the cache
is warm), then stay idle. If it refreshes repeatedly, the `busy` guard or the
`newestFetch` comparison is wrong — fix before committing.

- [ ] **Step 4: Commit**

```bash
git add src/features/markets/Markets.tsx
git commit -m "feat(market): poll for news on the schedule while the screen is open"
```

---

## Task 15: Update the handoff document

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Document what shipped**

In `docs/HANDOFF.md`, add to the **What's built** list:

```markdown
- **Markets**: a screen answering "what happened to what I own?" and "is this
  me or the whole market?". A strip of S&P/Nasdaq/Dow beside your own day
  change; held companies with their day move and latest headlines, biggest
  mover first; held index funds with what they track; and an earnings strip for
  the next 14 days with beat/miss on quarters just reported. Everything renders
  from a SQLite cache, so the screen never blocks on the network and works
  offline. Spec: `docs/superpowers/specs/2026-09-10-markets-news-earnings-design.md`
```

Add to **Gotchas worth knowing**:

```markdown
- **Yahoo's `quoteSummary` endpoint is dead to us.** It answers
  `401 Invalid Crumb` to any plain HTTP client — the same anti-bot pattern that
  took Stooq away. Earnings therefore come from Nasdaq's keyless endpoints
  (`api.nasdaq.com/api/calendar/earnings`, `/company/{SYM}/earnings-surprise`,
  `/analyst/{SYM}/earnings-forecast`). Do not "fix" the earnings code by
  reaching for quoteSummary.
- **Nasdaq's JSON mixes types for the same idea.** `eps` is a number while
  `consensusForecast` is a string, `epsForecast` arrives as `"$1.05"`, and a
  loss is `"($0.31)"`. Everything numeric goes through `nasdaq_parse::money`.
  The forecast response also carries **two** `rows` arrays — quarterly and
  yearly — and only the quarterly one is parsed.
- **`security_profile.quote_type` is what splits the Markets screen** into
  companies and funds. It is not a hardcoded ticker list, so it stays right as
  holdings change. A security with no profile yet is shown as a company rather
  than hidden.
- **Index levels live in `index_quotes`, not `securities`.** Putting ^GSPC in
  `securities` would make the S&P appear in Holdings and the allocation chart
  as though it were owned.
```

Update the schema line in the gotchas from `user_version` **4** to **5**, and
add:

```markdown
- **v5 adds the Markets tables** (`news_items`, `earnings_events`,
  `security_profile`, `index_quotes`). Every statement is `IF NOT EXISTS` and
  the completeness check is `v5_is_complete`.
```

In **Remaining work**, replace nothing but add at the top:

```markdown
0. **Local model summaries for the Markets screen** — an optional Ollama
   integration that reads `news_items` plus current positions and writes a
   short cross-holding summary ("INTC and MU both moved on the same
   memory-pricing story"). The model must never restate a number — every
   figure renders from SQLite — and must describe rather than recommend. See
   the follow-on section of the Markets spec.
```

- [ ] **Step 2: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: record the Markets screen in the handoff"
```

---

## Final verification

- [ ] **Run everything**

```bash
cd src-tauri && cargo test --lib && cargo clippy --lib --all-targets 2>&1 | grep -E "^(warning|error)"
cd .. && npx tsc --noEmit && npx vitest run
```

Expected: all Rust tests PASS; clippy shows only the two pre-existing
`parse_daily_csv` / `daily_url` dead-code warnings; no tsc output; all
TypeScript tests PASS.

- [ ] **Run the live-endpoint tests once**

```bash
cd src-tauri && cargo test --lib live_yahoo_news -- --ignored --nocapture
cargo test --lib live_nasdaq -- --ignored --nocapture
cargo test --lib live_index_closes -- --ignored --nocapture
```

Expected: all three PASS. A failure here means an upstream endpoint changed,
not that the code is wrong — report it rather than working around it.
