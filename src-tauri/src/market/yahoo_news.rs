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
}

pub struct YahooNews;

impl NewsProvider for YahooNews {
    fn headlines(&self, ticker: &str) -> anyhow::Result<Vec<NewsItem>> {
        let client = reqwest::blocking::Client::builder().user_agent(UA).build()?;
        let body = client.get(feed_url(ticker)).send()?.text()?;
        Ok(parse_feed(&body))
    }
}

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
