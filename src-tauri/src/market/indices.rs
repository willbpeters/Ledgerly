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


/// The benchmark every risk figure is measured against. It is one of the
/// `INDICES` above, so the ordinary strip refresh keeps it current and only the
/// initial two-year backfill is extra work.
pub const BENCHMARK: &str = "^GSPC";

/// The two-year chart URL for one index. Split out from `fetch_history` so the
/// range can be asserted without a network call.
pub fn history_url(symbol: &str) -> String {
    crate::prices::yahoo::chart_url(symbol, crate::prices::yahoo::HISTORY_RANGE)
}

/// Two years of daily closes for one index, oldest first. Run once, not on a
/// timer: `fetch_closes` stays the 5-day call the market strip uses.
pub fn fetch_history(symbol: &str) -> anyhow::Result<Vec<(String, f64)>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::market::yahoo_news::UA)
        .build()?;
    let body = client.get(history_url(symbol)).send()?.text()?;
    Ok(crate::prices::yahoo::parse_chart_json(&body))
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
    use crate::prices::yahoo::RECENT_RANGE;

    /// Hits the network. Run with:
    /// `cargo test --lib live_index_closes -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn live_index_closes_returns_at_least_two_days() {
        let closes = fetch_closes("^GSPC").unwrap();
        assert!(closes.len() >= 2, "the strip needs latest and previous");
    }

    #[test]
    fn the_benchmark_is_the_sp_500_and_is_one_of_the_strip_indices() {
        assert_eq!(BENCHMARK, "^GSPC");
        assert!(
            INDICES.iter().any(|(sym, _)| *sym == BENCHMARK),
            "the benchmark must already be fetched by the ordinary strip refresh",
        );
    }

    #[test]
    fn history_is_requested_over_two_years_and_the_strip_is_not() {
        assert!(history_url(BENCHMARK).contains("range=2y"), "{}", history_url(BENCHMARK));
        assert!(
            crate::prices::yahoo::chart_url(BENCHMARK, RECENT_RANGE).contains("range=5d"),
            "the 60-second refresh must not rewrite two years of rows",
        );
    }
}
