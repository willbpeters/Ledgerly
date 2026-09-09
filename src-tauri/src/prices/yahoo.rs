use serde_json::Value;

/// Window for the ordinary price refresh: just enough for latest and previous.
pub const RECENT_RANGE: &str = "5d";
/// Window for the history backfill. Two years of daily closes is enough for
/// beta, volatility and drawdown without making the response unwieldy, and it
/// costs the same single request as the short window.
pub const HISTORY_RANGE: &str = "2y";

/// Yahoo Finance public chart endpoint for a ticker's daily bars over `range`.
pub fn chart_url(ticker: &str, range: &str) -> String {
    format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range={}",
        ticker.trim().to_uppercase(),
        range
    )
}

fn unix_to_date(secs: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// Parse Yahoo chart JSON into (YYYY-MM-DD, close) rows, oldest first.
/// Skips null closes; falls back to the meta regular-market price if the
/// daily arrays are absent.
pub fn parse_chart_json(body: &str) -> Vec<(String, f64)> {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let result = &v["chart"]["result"][0];

    let mut out = Vec::new();
    if let (Some(ts), Some(closes)) = (
        result["timestamp"].as_array(),
        result["indicators"]["quote"][0]["close"].as_array(),
    ) {
        for (t, c) in ts.iter().zip(closes.iter()) {
            if let (Some(secs), Some(close)) = (t.as_i64(), c.as_f64()) {
                out.push((unix_to_date(secs), close));
            }
        }
    }

    if out.is_empty() {
        let meta = &result["meta"];
        if let (Some(price), Some(secs)) = (
            meta["regularMarketPrice"].as_f64(),
            meta["regularMarketTime"].as_i64(),
        ) {
            out.push((unix_to_date(secs), price));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_url_asks_for_two_years_of_daily_closes() {
        let url = chart_url("vti", HISTORY_RANGE);
        assert!(url.contains("range=2y"), "{url}");
        assert!(url.contains("interval=1d"), "{url}");
        assert!(url.contains("/VTI?"), "{url}");
    }

    #[test]
    fn the_ordinary_refresh_still_asks_for_a_short_window() {
        assert!(chart_url("aapl", RECENT_RANGE).contains("range=5d"));
    }

    #[test]
    fn builds_uppercase_url() {
        assert_eq!(
            chart_url("aapl", RECENT_RANGE),
            "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d"
        );
    }

    #[test]
    fn parses_daily_closes_oldest_first_and_skips_nulls() {
        let body = r#"{"chart":{"result":[{
            "meta":{"regularMarketPrice":320.0,"regularMarketTime":1788552000},
            "timestamp":[1788206400,1788292800,1788552000],
            "indicators":{"quote":[{"close":[315.5,null,320.0]}]}
        }]}}"#;
        let rows = parse_chart_json(body);
        assert_eq!(rows.len(), 2); // the null close is skipped
        assert_eq!(rows[0].1, 315.5);
        assert_eq!(rows[1].1, 320.0);
    }

    #[test]
    fn falls_back_to_meta_price_when_no_daily_arrays() {
        let body = r#"{"chart":{"result":[{
            "meta":{"regularMarketPrice":100.25,"regularMarketTime":1788552000}
        }]}}"#;
        let rows = parse_chart_json(body);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1, 100.25);
    }

    #[test]
    fn returns_empty_on_garbage() {
        assert!(parse_chart_json("not json").is_empty());
        assert!(parse_chart_json(r#"{"chart":{"result":[]}}"#).is_empty());
    }
}
