//! Pure helpers for the SimpleFIN diagnostic: pick a few raw transactions out
//! of an `/accounts` response, and redact the money out of them.
//!
//! No I/O, no database. This module exists because `parse.rs` deliberately
//! keeps only the fields Ledgerly models, dropping SimpleFIN's free-form
//! `extra` object — the very thing we are trying to find. Everything here
//! therefore works on untouched `serde_json::Value` trees.

use serde_json::{json, Value};

/// At most this many transactions are taken from any single account, so a
/// chatty first account cannot crowd out a second institution. Banks differ in
/// what they enrich, and seeing only one of them defeats the diagnostic.
const PER_ACCOUNT: usize = 2;

/// The raw JSON of up to `n` transactions, pretty-printed, each tagged with the
/// account and institution it came from.
///
/// Transactions are passed through untouched — unknown fields included — which
/// is the entire purpose: `parse.rs` would drop them.
pub fn sample_transactions(body: &str, n: usize) -> Result<String, String> {
    let root: Value = serde_json::from_str(body).map_err(|_| {
        "SimpleFIN sent a response Ledgerly couldn't read. Try again in a minute.".to_string()
    })?;

    let mut out: Vec<Value> = Vec::new();
    if let Some(accounts) = root.get("accounts").and_then(Value::as_array) {
        // Two passes: one transaction from each account first, then top up.
        // This guarantees every account appears before any account repeats.
        for take in 1..=PER_ACCOUNT {
            for a in accounts {
                if out.len() >= n {
                    break;
                }
                let name = a.get("name").and_then(Value::as_str).unwrap_or("Account");
                let org = a
                    .get("org")
                    .and_then(|o| o.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let txns = a.get("transactions").and_then(Value::as_array);
                if let Some(t) = txns.and_then(|arr| arr.get(take - 1)) {
                    out.push(json!({
                        "account": name,
                        "institution": org,
                        "transaction": t,
                    }));
                }
            }
        }
    }

    serde_json::to_string_pretty(&json!({ "sampled": out.len(), "transactions": out }))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two accounts: the first carries an `extra` object of the kind we are
    /// hunting for, the second carries none. Both must be represented.
    const BODY: &str = r#"{
      "errors": [],
      "accounts": [
        {
          "id": "a1", "name": "Everyday", "org": {"name": "Big Bank"},
          "balance": "1200.00", "available-balance": "1150.00",
          "transactions": [
            {"id":"t1","posted":1788306430,"amount":"-12.40","description":"COFFEE",
             "payee":"Blue Bottle","mcc":"5812",
             "extra":{"category":"Food and Drink > Coffee Shops"}},
            {"id":"t2","posted":1788306431,"amount":"-88.00","description":"GROCER",
             "payee":"Local Grocer","mcc":"5411",
             "extra":{"category":"Groceries"}},
            {"id":"t3","posted":1788306432,"amount":"-9.99","description":"STREAM",
             "payee":"Netflix","mcc":null}
          ]
        },
        {
          "id": "a2", "name": "Savings", "org": {"name": "Other Bank"},
          "balance": "5000.00",
          "transactions": [
            {"id":"t9","posted":1788306440,"amount":"2000.00","description":"Pay day!",
             "payee":"You","mcc":null}
          ]
        }
      ]
    }"#;

    fn parsed(s: &str) -> Value {
        serde_json::from_str(s).expect("sample output should be valid JSON")
    }

    #[test]
    fn keeps_fields_ledgerly_does_not_model() {
        // The whole point: `extra` survives, because we never went through parse.rs.
        let out = sample_transactions(BODY, 5).unwrap();
        assert!(out.contains("extra"), "the extra object must survive sampling");
        assert!(out.contains("Coffee Shops"), "and its contents must survive too");
    }

    #[test]
    fn tags_each_transaction_with_where_it_came_from() {
        let v = parsed(&sample_transactions(BODY, 5).unwrap());
        let first = &v["transactions"][0];
        assert_eq!(first["account"], "Everyday");
        assert_eq!(first["institution"], "Big Bank");
        assert_eq!(first["transaction"]["id"], "t1");
    }

    #[test]
    fn takes_from_more_than_one_account() {
        // Without a per-account cap, account a1's three transactions would fill
        // a sample of 3 and the second institution would never be seen — which
        // is the case that matters, since banks differ in what they enrich.
        let v = parsed(&sample_transactions(BODY, 3).unwrap());
        let accounts: Vec<&str> = v["transactions"].as_array().unwrap()
            .iter().map(|t| t["account"].as_str().unwrap()).collect();
        assert!(accounts.contains(&"Savings"), "got {accounts:?}");
    }

    #[test]
    fn caps_the_sample_at_the_requested_size() {
        let v = parsed(&sample_transactions(BODY, 2).unwrap());
        assert_eq!(v["sampled"], 2);
        assert_eq!(v["transactions"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn reports_zero_when_there_are_no_transactions() {
        let body = r#"{"accounts":[{"id":"a","name":"Empty","transactions":[]}]}"#;
        let v = parsed(&sample_transactions(body, 5).unwrap());
        assert_eq!(v["sampled"], 0);
    }

    #[test]
    fn survives_a_response_with_no_accounts_key_at_all() {
        let v = parsed(&sample_transactions(r#"{"errors":[]}"#, 5).unwrap());
        assert_eq!(v["sampled"], 0);
    }

    #[test]
    fn rejects_a_body_that_is_not_json() {
        assert!(sample_transactions("<html>nope</html>", 5).is_err());
    }
}
