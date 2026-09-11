//! HTTP for Nasdaq's earnings endpoints. Parsing lives in `nasdaq_parse`.
use crate::market::nasdaq_parse::{parse_calendar, parse_surprise, ParsedEarnings};
use crate::market::yahoo_news::UA;
use chrono::Datelike;

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
