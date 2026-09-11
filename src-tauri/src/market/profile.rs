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
