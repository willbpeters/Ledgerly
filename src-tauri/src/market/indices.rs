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

    /// Hits the network. Run with:
    /// `cargo test --lib live_index_closes -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn live_index_closes_returns_at_least_two_days() {
        let closes = fetch_closes("^GSPC").unwrap();
        assert!(closes.len() >= 2, "the strip needs latest and previous");
    }
}
