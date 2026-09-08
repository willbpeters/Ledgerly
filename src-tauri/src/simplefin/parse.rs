//! Pure parsing of SimpleFIN data. No I/O — everything here is unit-tested
//! against fixtures.
use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct SfHolding {
    /// Upper-cased ticker; empty when SimpleFIN doesn't provide one.
    pub symbol: String,
    pub description: String,
    pub shares: f64,
    pub cost_basis: f64,
    pub market_value: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SfAccount {
    pub id: String,
    pub name: String,
    pub institution: String,
    pub currency: String,
    pub balance: f64,
    /// YYYY-MM-DD derived from `balance-date`
    pub balance_date: String,
    pub holdings: Vec<SfHolding>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SfAccountSet {
    pub errors: Vec<String>,
    pub accounts: Vec<SfAccount>,
}

const BAD_TOKEN: &str = "That doesn't look like a SimpleFIN setup token. Copy the whole token from SimpleFIN Bridge and try again.";

/// A setup token is base64 of an https claim URL. Tolerates surrounding
/// whitespace, URL-safe alphabet, and missing padding.
pub fn decode_setup_token(token: &str) -> Result<String, String> {
    let cleaned: String = token.chars().filter(|c| !c.is_whitespace()).collect();
    if cleaned.is_empty() {
        return Err("Paste your SimpleFIN setup token first.".into());
    }
    use base64::engine::general_purpose as b64;
    let bytes = b64::STANDARD
        .decode(&cleaned)
        .or_else(|_| b64::STANDARD_NO_PAD.decode(&cleaned))
        .or_else(|_| b64::URL_SAFE.decode(&cleaned))
        .or_else(|_| b64::URL_SAFE_NO_PAD.decode(&cleaned))
        .map_err(|_| BAD_TOKEN.to_string())?;
    let url = String::from_utf8(bytes).map_err(|_| BAD_TOKEN.to_string())?;
    let url = url.trim().to_string();
    if !url.starts_with("https://") {
        return Err(BAD_TOKEN.into());
    }
    Ok(url)
}

/// SimpleFIN sends money as strings ("1234.56"); be lenient about numbers
/// and thousands separators. Anything unparseable is 0.
pub fn money(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().replace(',', "").parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/// Unix seconds (number or numeric string) → YYYY-MM-DD (UTC). Falls back to today.
pub fn epoch_to_date(v: &Value) -> String {
    let secs = v.as_i64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<i64>().ok()));
    secs.and_then(|s| chrono::DateTime::from_timestamp(s, 0))
        .map(|dt| dt.format("%Y-%m-%d").to_string())
        .unwrap_or_else(today)
}

/// Parse a `/accounts` response. Accepts protocol v1 (`errors`, `org`) and
/// v2 (`errlist`, `connections`).
pub fn parse_accounts_json(body: &str) -> Result<SfAccountSet, String> {
    let root: Value = serde_json::from_str(body)
        .map_err(|_| "SimpleFIN sent a response Ledgerly couldn't read. Try again in a minute.".to_string())?;

    let mut errors: Vec<String> = Vec::new();
    if let Some(arr) = root.get("errors").and_then(Value::as_array) {
        errors.extend(arr.iter().filter_map(Value::as_str).map(str::to_string));
    }
    if let Some(arr) = root.get("errlist").and_then(Value::as_array) {
        errors.extend(arr.iter().map(|e| {
            e.get("msg").and_then(Value::as_str).unwrap_or("Unknown SimpleFIN error").to_string()
        }));
    }

    let mut connections: HashMap<String, String> = HashMap::new();
    if let Some(arr) = root.get("connections").and_then(Value::as_array) {
        for c in arr {
            if let (Some(id), Some(name)) =
                (c.get("conn_id").and_then(Value::as_str), c.get("name").and_then(Value::as_str))
            {
                connections.insert(id.to_string(), name.to_string());
            }
        }
    }

    let accounts = root
        .get("accounts")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(|a| parse_account(a, &connections)).collect())
        .unwrap_or_default();

    Ok(SfAccountSet { errors, accounts })
}

fn parse_account(a: &Value, connections: &HashMap<String, String>) -> Option<SfAccount> {
    let id = a.get("id")?.as_str()?.to_string();
    let name = a.get("name").and_then(Value::as_str).unwrap_or("Account").to_string();
    let institution = a
        .get("org")
        .and_then(|o| o.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            a.get("conn_id")
                .and_then(Value::as_str)
                .and_then(|c| connections.get(c).cloned())
        })
        .unwrap_or_else(|| "SimpleFIN".to_string());
    let currency = a.get("currency").and_then(Value::as_str).unwrap_or("USD").to_string();
    let balance = a.get("balance").map(money).unwrap_or(0.0);
    let balance_date = a.get("balance-date").map(epoch_to_date).unwrap_or_else(today);
    let holdings = a
        .get("holdings")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(parse_holding).collect())
        .unwrap_or_default();
    Some(SfAccount { id, name, institution, currency, balance, balance_date, holdings })
}

fn parse_holding(h: &Value) -> SfHolding {
    let text = |k: &str| h.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let num = |k: &str| h.get(k).map(money).unwrap_or(0.0);
    SfHolding {
        symbol: text("symbol").to_uppercase(),
        description: text("description"),
        shares: num("shares"),
        cost_basis: num("cost_basis"),
        market_value: num("market_value"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEMO_JSON: &str = r#"{"errors":[],"accounts":[
      {"id":"Demo Savings","name":"SimpleFIN Savings","currency":"USD","balance":"114405.51",
       "available-balance":"114405.51","balance-date":1788912000,"transactions":[],"holdings":[],
       "org":{"domain":"beta-bridge.simplefin.org","name":"SimpleFIN Demo","sfin-url":"x","url":"y","id":"simplefin.demoorg"}},
      {"id":"Demo Checking","name":"SimpleFIN Checking","currency":"USD","balance":"24668.87",
       "balance-date":1788912000,"transactions":[],"holdings":[],
       "org":{"name":"SimpleFIN Demo"}}
    ]}"#;

    const BROKERAGE_JSON: &str = r#"{"errors":["Connection to Fidelity may need attention"],"accounts":[
      {"id":"ACT-1","name":"Roth IRA","currency":"USD","balance":"250.10","balance-date":1788912000,
       "holdings":[
         {"id":"h1","symbol":"vti","description":"Vanguard Total Stock Market ETF","shares":"10.5","cost_basis":"2000.00","market_value":"2500.00","purchase_price":"190.48"},
         {"id":"h2","symbol":"","description":"Money Market Fund","shares":"5","cost_basis":"5","market_value":"5"},
         {"id":"h3","symbol":"AAPL","description":"Apple Inc","shares":2,"cost_basis":300,"market_value":"400"}
       ],
       "org":{"name":"Fidelity"}}
    ]}"#;

    const V2_JSON: &str = r#"{"errlist":[{"code":"E1","msg":"Bank needs re-auth"}],
      "connections":[{"conn_id":"c1","name":"Chase","org_id":"o1","sfin_url":"x"}],
      "accounts":[{"id":"A9","name":"Checking","conn_id":"c1","currency":"USD","balance":"12.00","balance-date":1788912000}]}"#;

    #[test]
    fn decodes_setup_token_to_claim_url() {
        let token = "aHR0cHM6Ly9iZXRhLWJyaWRnZS5zaW1wbGVmaW4ub3JnL3NpbXBsZWZpbi9jbGFpbS9kZW1v";
        assert_eq!(
            decode_setup_token(token).unwrap(),
            "https://beta-bridge.simplefin.org/simplefin/claim/demo"
        );
    }

    #[test]
    fn decodes_setup_token_with_whitespace_and_no_padding() {
        let token = " aHR0cHM6Ly9leGFtcGxlLmNvbS9jbGFpbS9hYmM\n";
        assert_eq!(decode_setup_token(token).unwrap(), "https://example.com/claim/abc");
    }

    #[test]
    fn rejects_garbage_token() {
        assert!(decode_setup_token("not a token!!").is_err());
        assert!(decode_setup_token("").is_err());
        // valid base64 but not an https URL
        assert!(decode_setup_token("aGVsbG8=").is_err());
    }

    #[test]
    fn parses_demo_feed() {
        let set = parse_accounts_json(DEMO_JSON).unwrap();
        assert!(set.errors.is_empty());
        assert_eq!(set.accounts.len(), 2);
        let a = &set.accounts[0];
        assert_eq!(a.id, "Demo Savings");
        assert_eq!(a.name, "SimpleFIN Savings");
        assert_eq!(a.institution, "SimpleFIN Demo");
        assert!((a.balance - 114405.51).abs() < 1e-9);
        assert_eq!(a.balance_date, "2026-09-09"); // 1788912000 = 2026-09-09T00:00:00Z
        assert!(a.holdings.is_empty());
    }

    #[test]
    fn parses_holdings_and_errors() {
        let set = parse_accounts_json(BROKERAGE_JSON).unwrap();
        assert_eq!(set.errors, vec!["Connection to Fidelity may need attention".to_string()]);
        let a = &set.accounts[0];
        assert_eq!(a.institution, "Fidelity");
        assert_eq!(a.holdings.len(), 3);
        assert_eq!(a.holdings[0].symbol, "VTI"); // upper-cased
        assert!((a.holdings[0].shares - 10.5).abs() < 1e-9);
        assert!((a.holdings[0].cost_basis - 2000.0).abs() < 1e-9);
        assert!((a.holdings[0].market_value - 2500.0).abs() < 1e-9);
        assert_eq!(a.holdings[1].symbol, ""); // symbol-less kept; sync skips it
        assert!((a.holdings[2].shares - 2.0).abs() < 1e-9); // numeric JSON accepted
        assert!((a.holdings[2].cost_basis - 300.0).abs() < 1e-9);
    }

    #[test]
    fn parses_v2_shape() {
        let set = parse_accounts_json(V2_JSON).unwrap();
        assert_eq!(set.errors, vec!["Bank needs re-auth".to_string()]);
        assert_eq!(set.accounts[0].institution, "Chase");
        assert!((set.accounts[0].balance - 12.0).abs() < 1e-9);
    }

    #[test]
    fn money_handles_strings_numbers_and_junk() {
        use serde_json::json;
        assert_eq!(money(&json!("1,234.50")), 1234.5);
        assert_eq!(money(&json!(-3)), -3.0);
        assert_eq!(money(&json!("abc")), 0.0);
        assert_eq!(money(&json!(null)), 0.0);
    }

    #[test]
    fn malformed_json_is_a_readable_error() {
        let err = parse_accounts_json("<html>").unwrap_err();
        assert!(err.contains("couldn't read"));
    }
}
