//! Pure parsing of Yahoo Finance's per-ticker RSS feed. No I/O, so it is
//! tested against a captured fixture the way `simplefin::parse` is.
//!
//! The feed is plain XML: no CDATA, and `&amp;` is the only entity seen in
//! practice. That makes a small hand-rolled reader cheaper and more
//! predictable than pulling in an XML crate.
//!
//! Only exercised by tests for now — `client.rs` and the SQLite store that
//! call this land in a later task, same as `StooqProvider` in `prices/mod.rs`.

/// One headline, parsed. Not yet tied to a security — `store` does that.
#[allow(dead_code)] // wired up in a later task; only tests call this today
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
#[allow(dead_code)] // wired up in a later task; only tests call this today
fn tag(block: &str, name: &str) -> Option<String> {
    let open = format!("<{name}");
    let start = block.find(&open)?;
    let after_attrs = block[start..].find('>')? + start + 1;
    let end = block[after_attrs..].find(&format!("</{name}>"))? + after_attrs;
    Some(unescape(block[after_attrs..end].trim()))
}

#[allow(dead_code)] // wired up in a later task; only tests call this today
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
#[allow(dead_code)] // wired up in a later task; only tests call this today
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
#[allow(dead_code)] // wired up in a later task; only tests call this today
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
        if title.is_empty() || url.is_empty() || guid.is_empty() {
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
#[allow(dead_code)] // wired up in a later task; only tests call this today
fn to_rfc3339(raw: &str) -> Option<String> {
    let dt = chrono::DateTime::parse_from_rfc2822(raw).ok()?;
    Some(dt.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = include_str!("fixtures/yahoo_news_mu.xml");

    #[test]
    fn parses_the_real_feed() {
        let items = parse_feed(FEED);
        assert_eq!(items.len(), 19, "the fixture carries 19 items");
        let first = &items[0];
        assert!(!first.guid.is_empty());
        assert!(!first.title.is_empty());
        assert!(first.url.starts_with("http"));
        assert_eq!(first.published.len(), 20, "published should be RFC3339 UTC");
        assert!(first.published.ends_with('Z'));
        assert_eq!(first.guid, "def3a003-6ab1-3ba7-9468-748c6f805bbb");
        assert_eq!(
            first.title,
            "Micron Is Down 19% From Its High. History Suggests a $5,000 Investment Today Could Be Worth This Much by 2030."
        );
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
        // Each item here has a valid date, so only the missing field can be
        // what drops it. An earlier version of this test omitted pubDate too,
        // which meant it passed even when the title/link guard was removed.
        const NO_LINK: &str = r#"<rss><channel><item>
            <title>No link here</title><guid>g1</guid>
            <pubDate>Thu, 10 Sep 2026 19:29:06 +0000</pubDate>
        </item></channel></rss>"#;
        const NO_TITLE: &str = r#"<rss><channel><item>
            <link>https://x.test/a</link><guid>g2</guid>
            <pubDate>Thu, 10 Sep 2026 19:29:06 +0000</pubDate>
        </item></channel></rss>"#;
        const BOTH: &str = r#"<rss><channel><item>
            <title>Fine</title><link>https://x.test/b</link><guid>g3</guid>
            <pubDate>Thu, 10 Sep 2026 19:29:06 +0000</pubDate>
        </item></channel></rss>"#;
        assert!(parse_feed(NO_LINK).is_empty(), "no link");
        assert!(parse_feed(NO_TITLE).is_empty(), "no title");
        assert_eq!(parse_feed(BOTH).len(), 1, "and a complete item still parses");
    }

    #[test]
    fn an_item_with_an_empty_guid_is_dropped_because_guid_is_the_dedup_key() {
        const XML: &str = r#"<rss><channel><item>
            <title>T</title><guid isPermaLink="false"></guid>
            <link>https://x.test/a</link>
            <pubDate>Thu, 10 Sep 2026 19:29:06 +0000</pubDate>
        </item></channel></rss>"#;
        assert!(parse_feed(XML).is_empty());
    }

    #[test]
    fn ampersand_is_unescaped_last_so_an_escaped_entity_stays_escaped() {
        const XML: &str = r#"<rss><channel><item>
            <title>Literal &amp;lt; stays literal</title><guid>g</guid>
            <link>https://x.test/a</link>
            <pubDate>Thu, 10 Sep 2026 19:29:06 +0000</pubDate>
        </item></channel></rss>"#;
        assert_eq!(parse_feed(XML)[0].title, "Literal &lt; stays literal");
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
