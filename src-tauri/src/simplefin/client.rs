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

/// Split `https://user:pass@host/simplefin` into
/// (`https://host/simplefin/accounts?balances-only=1`, user, pass).
pub fn accounts_request_parts(access_url: &str) -> Result<(String, String, Option<String>), String> {
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
    url.set_query(Some("balances-only=1"));
    Ok((url.to_string(), user, pass))
}

/// Fetch every account (balances + holdings, no transactions).
pub fn fetch_accounts(access_url: &str) -> Result<SfAccountSet, String> {
    let (url, user, pass) = accounts_request_parts(access_url)?;
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
            accounts_request_parts("https://demo:p%40ss@beta-bridge.simplefin.org/simplefin").unwrap();
        assert_eq!(url, "https://beta-bridge.simplefin.org/simplefin/accounts?balances-only=1");
        assert_eq!(user, "demo");
        assert_eq!(pass.as_deref(), Some("p@ss")); // percent-decoded
    }

    #[test]
    fn tolerates_trailing_slash() {
        let (url, _, _) = accounts_request_parts("https://u:p@host/simplefin/").unwrap();
        assert_eq!(url, "https://host/simplefin/accounts?balances-only=1");
    }

    #[test]
    fn rejects_invalid_url() {
        assert!(accounts_request_parts("nope").is_err());
    }

    #[test]
    #[ignore = "hits the network"]
    fn live_demo_fetch() {
        let set = fetch_accounts("https://demo:demo@beta-bridge.simplefin.org/simplefin").unwrap();
        assert!(set.accounts.len() >= 2);
    }
}
