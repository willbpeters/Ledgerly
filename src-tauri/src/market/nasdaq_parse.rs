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

/// `6/24/2026` becomes `2026-06-24`.
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
#[allow(dead_code)] // the calendar covers the near term; kept for a later drill-down
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
