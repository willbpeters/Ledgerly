//! HTTP calls to SimpleFIN Bridge. Errors are plain-English strings meant to
//! be shown directly in the UI.
use super::parse::{self, SfAccountSet};
use std::time::Duration;

pub const NETWORK_ERR: &str =
    "Couldn't reach SimpleFIN. Check your internet connection and try again.";
const BAD_STORED: &str =
    "The saved SimpleFIN connection is invalid. Disconnect, then connect again with a new setup token.";

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("Ledgerly/0.1 (Windows; +https://github.com/willbpeters/Ledgerly)")
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

/// Turn whatever the user pasted into an access URL.
///
/// SimpleFIN Bridge hands out one-time *setup tokens*, but some setups (and the
/// public demo, whose shared token is permanently claimed) give you the *access
/// URL* directly. Accepting both means a paste that already looks like a URL is
/// used as-is instead of being sent to a claim endpoint that would reject it.
pub fn resolve_access_url(pasted: &str) -> Result<String, String> {
    let trimmed = pasted.trim();
    if trimmed.starts_with("https://") {
        // Validate the shape now so a typo fails here rather than at sync time.
        accounts_request_parts(trimmed, None)?;
        return Ok(trimmed.to_string());
    }
    claim(trimmed)
}

/// Exchange a one-time setup token for a permanent access URL.
pub fn claim(setup_token: &str) -> Result<String, String> {
    let claim_url = parse::decode_setup_token(setup_token)?;
    let resp = http()?
        .post(&claim_url)
        .header(reqwest::header::CONTENT_LENGTH, "0")
        .send()
        .map_err(|_| NETWORK_ERR.to_string())?;
    match resp.status().as_u16() {
        200 => {
            let url = resp.text().map_err(|_| NETWORK_ERR.to_string())?.trim().to_string();
            if url.starts_with("http") {
                Ok(url)
            } else {
                Err("SimpleFIN returned an unexpected reply while connecting. Generate a fresh setup token and try again.".into())
            }
        }
        403 => Err("That setup token has already been used or has expired. Generate a new one in SimpleFIN Bridge and paste it here.".into()),
        s => Err(format!("SimpleFIN returned an unexpected status ({s}) while connecting. Try again later.")),
    }
}

/// SimpleFIN warns above 45 days and may cap it, so backfills page in windows.
pub const MAX_WINDOW_DAYS: i64 = 45;

/// A span of transactions to ask for, as unix timestamps.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range {
    pub since: i64,
    /// Exclusive upper bound. `None` means "up to now".
    pub until: Option<i64>,
}

impl Range {
    /// The last `days` up to now.
    #[allow(dead_code)] // used by the ignored live test
    pub fn last_days(days: i64) -> Self {
        Range { since: chrono::Utc::now().timestamp() - days * 86_400, until: None }
    }
}

/// Split `https://user:pass@host/simplefin` into the `/accounts` URL, the
/// username and the password.
///
/// Pass `None` for balances and holdings only, or a range to also ask for the
/// transactions posted inside it.
pub fn accounts_request_parts(
    access_url: &str,
    range: Option<Range>,
) -> Result<(String, String, Option<String>), String> {
    let mut url = reqwest::Url::parse(access_url).map_err(|_| BAD_STORED.to_string())?;
    if !url.has_host() {
        return Err(BAD_STORED.into());
    }
    let decode = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_string();
    let user = decode(url.username());
    let pass = url.password().map(decode);
    url.set_username("").ok();
    url.set_password(None).ok();
    let path = format!("{}/accounts", url.path().trim_end_matches('/'));
    url.set_path(&path);
    match range {
        Some(Range { since, until: None }) => url.set_query(Some(&format!("start-date={since}&pending=1"))),
        Some(Range { since, until: Some(until) }) =>
            url.set_query(Some(&format!("start-date={since}&end-date={until}&pending=1"))),
        None => url.set_query(Some("balances-only=1")),
    }
    Ok((url.to_string(), user, pass))
}

/// Fetch balances and holdings only, without asking for transactions.
#[allow(dead_code)] // the cheap call, kept for a balances-only refresh
pub fn fetch_accounts(access_url: &str) -> Result<SfAccountSet, String> {
    fetch(access_url, None)
}

/// Fetch balances, holdings and the transactions posted inside `range`.
pub fn fetch_accounts_in(access_url: &str, range: Range) -> Result<SfAccountSet, String> {
    fetch(access_url, Some(range))
}

fn fetch(access_url: &str, range: Option<Range>) -> Result<SfAccountSet, String> {
    let (url, user, pass) = accounts_request_parts(access_url, range)?;
    let mut req = http()?.get(url);
    if !user.is_empty() {
        req = req.basic_auth(user, pass);
    }
    let resp = req.send().map_err(|_| NETWORK_ERR.to_string())?;
    match resp.status().as_u16() {
        200 => {
            let body = resp.text().map_err(|_| NETWORK_ERR.to_string())?;
            parse::parse_accounts_json(&body)
        }
        402 => Err("Your SimpleFIN subscription needs renewing before Ledgerly can sync.".into()),
        403 => Err("SimpleFIN rejected the saved connection. Disconnect, then connect again with a new setup token.".into()),
        s => Err(format!("SimpleFIN returned an unexpected status ({s}). Try again later.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_credentials_and_builds_accounts_url() {
        let (url, user, pass) =
            accounts_request_parts("https://demo:p%40ss@beta-bridge.simplefin.org/simplefin", None).unwrap();
        assert_eq!(url, "https://beta-bridge.simplefin.org/simplefin/accounts?balances-only=1");
        assert_eq!(user, "demo");
        assert_eq!(pass.as_deref(), Some("p@ss")); // percent-decoded
    }

    #[test]
    fn tolerates_trailing_slash() {
        let (url, _, _) = accounts_request_parts("https://u:p@host/simplefin/", None).unwrap();
        assert_eq!(url, "https://host/simplefin/accounts?balances-only=1");
    }

    #[test]
    fn rejects_invalid_url() {
        assert!(accounts_request_parts("nope", None).is_err());
    }

    #[test]
    fn asking_for_transactions_swaps_balances_only_for_a_start_date() {
        let (url, _, _) = accounts_request_parts("https://u:p@host/simplefin",
            Some(Range { since: 1783768170, until: None })).unwrap();
        assert_eq!(url, "https://host/simplefin/accounts?start-date=1783768170&pending=1");

        let (windowed, _, _) = accounts_request_parts("https://u:p@host/simplefin",
            Some(Range { since: 100, until: Some(200) })).unwrap();
        assert_eq!(windowed, "https://host/simplefin/accounts?start-date=100&end-date=200&pending=1");
    }

    #[test]
    #[ignore = "hits the network"]
    fn live_demo_fetch_with_transactions() {
        let set = fetch_accounts_in("https://demo:demo@beta-bridge.simplefin.org/simplefin",
            Range::last_days(MAX_WINDOW_DAYS)).unwrap();
        let total: usize = set.accounts.iter().map(|a| a.transactions.len()).sum();
        assert!(total > 0, "the demo feed should carry transactions");
        let with_mcc = set.accounts.iter().flat_map(|a| &a.transactions).filter(|t| t.mcc.is_some()).count();
        assert!(with_mcc > 0, "and at least some should carry a merchant code");
    }

    #[test]
    fn resolve_uses_a_pasted_access_url_as_is() {
        // No network call: an https paste is taken directly.
        assert_eq!(
            resolve_access_url("  https://demo:demo@beta-bridge.simplefin.org/simplefin \n").unwrap(),
            "https://demo:demo@beta-bridge.simplefin.org/simplefin"
        );
    }

    #[test]
    fn resolve_rejects_a_malformed_access_url() {
        assert!(resolve_access_url("https://").is_err());
    }

    #[test]
    fn resolve_rejects_garbage_without_calling_the_network() {
        // Not https and not valid base64 → fails in decode_setup_token.
        assert!(resolve_access_url("not a token!!").is_err());
    }

    #[test]
    #[ignore = "hits the network"]
    fn live_demo_fetch() {
        let set = fetch_accounts("https://demo:demo@beta-bridge.simplefin.org/simplefin").unwrap();
        assert!(set.accounts.len() >= 2);
    }
}
