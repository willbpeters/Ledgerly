//! Pure helpers for the SimpleFIN diagnostic: pick a few raw transactions out
//! of an `/accounts` response, and redact the money out of them.
//!
//! No I/O, no database. This module exists because `parse.rs` deliberately
//! keeps only the fields Ledgerly models, dropping SimpleFIN's free-form
//! `extra` object — the very thing we are trying to find. Everything here
//! therefore works on untouched `serde_json::Value` trees.

use serde_json::{json, Value};

/// The raw JSON of up to `n` transactions, pretty-printed, each tagged with the
/// account and institution it came from.
///
/// Transactions are passed through untouched — unknown fields included — which
/// is the entire purpose: `parse.rs` would drop them. Sampling proceeds
/// round-robin across accounts (every account gives up its first transaction
/// before any account gives up its second) so a chatty account cannot crowd
/// out a second institution, then keeps topping up until it reaches `n` or
/// every account runs dry.
pub fn sample_transactions(body: &str, n: usize) -> Result<String, String> {
    let root: Value = serde_json::from_str(body).map_err(|_| {
        "SimpleFIN sent a response Ledgerly couldn't read. Try again in a minute.".to_string()
    })?;

    let mut out: Vec<Value> = Vec::new();
    if let Some(accounts) = root.get("accounts").and_then(Value::as_array) {
        // Round-robin: every account gives up its first transaction before any
        // account gives up its second, so a chatty account cannot crowd out a
        // second institution. Banks differ in what they enrich, and seeing only
        // one of them defeats the diagnostic.
        for take in 0..n {
            let mut progressed = false;
            for a in accounts {
                if out.len() >= n {
                    break;
                }
                let name = a.get("name").and_then(Value::as_str).unwrap_or("Account");
                let org = a
                    .get("org")
                    .and_then(|o| o.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown institution");
                let picked = a
                    .get("transactions")
                    .and_then(Value::as_array)
                    .and_then(|arr| arr.get(take));
                if let Some(t) = picked {
                    out.push(json!({
                        "account": name,
                        "institution": org,
                        "transaction": t,
                    }));
                    progressed = true;
                }
            }
            // Stop when the sample is full, or when a whole pass found nothing
            // left to take. The `n = 0` case never enters the loop at all,
            // since the range `0..0` is empty.
            if out.len() >= n || !progressed {
                break;
            }
        }
    }

    Ok(serde_json::to_string_pretty(&json!({ "sampled": out.len(), "transactions": out }))
        .expect("a Value tree always serializes"))
}

/// Keys whose values must survive redaction. `mcc` and the timestamps are
/// numeric, so a rule based on "looks like a number" would destroy exactly the
/// fields we came for; `sampled` is this module's own row count rather than
/// anything the bank sent.
const KEEP: &[&str] = &["id", "posted", "transacted_at", "mcc", "pending", "sampled"];

/// Key-name fragments that mean money. They only fire on a value containing a
/// digit, so an English word that happens to contain one of them ("coffee"
/// contains "fee") does not eat a category name.
///
/// Known gap: a bare numeric string under a key matching nothing here (say
/// `{"charge":"1200"}`) still gets through. Closing it would also redact a
/// numeric category code, which is a thing we want to see, and the unredacted
/// copy exists for the cases this misses.
const MONEY_NAMES: &[&str] = &[
    "amount", "balance", "value", "price", "total", "cost", "cents", "fee",
    "charge", "debit", "credit", "sum", "paid", "due", "interest",
];

/// What the caller gets when redaction cannot run. It deliberately does not
/// include the input: falling back to the original would leak exactly what this
/// function exists to hide.
const REDACTION_FAILED: &str =
    "Couldn't redact this sample, so it is not shown here. Use \"Copy with amounts\" if you need it.";

/// Replace every money value with `***`, leaving field names, payees, merchant
/// codes and the contents of any unknown object such as `extra` intact.
///
/// Redaction is driven by the *shape* of the value as well as the name of the
/// key, because the whole premise of this diagnostic is that nobody knows what
/// is inside `extra`. A rule keyed only on names we already know would sail
/// past `extra.original_amount` or `extra.running_balance` — and `extra` is
/// precisely the subtree that reaches the clipboard unexamined.
///
/// Note that account balances never reach this function at all: the sample
/// emits only the account name, the institution and the transaction body. Do
/// not "helpfully" add balances to the sample.
pub fn redact(pretty_json: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<Value>(pretty_json) else {
        return REDACTION_FAILED.to_string();
    };
    scrub(&mut v);
    serde_json::to_string_pretty(&v).unwrap_or_else(|_| REDACTION_FAILED.to_string())
}

/// A string is money when, after stripping currency punctuation, it parses as
/// a decimal number. Bare integers are deliberately not handled here: on their
/// own they are ambiguous — `mcc` is "5812" — so the caller decides them.
fn looks_like_money(s: &str) -> bool {
    let cleaned: String = s
        .chars()
        .filter(|c| !matches!(c, '$' | ',' | '(' | ')' | ' ' | '+'))
        .collect();
    cleaned.contains('.') && cleaned.parse::<f64>().is_ok()
}

/// Any number outside `KEEP` counts as money — `extra` is unknown by
/// definition, and money that happens to be round is still money. A matching
/// key name is not enough on its own: "coffee_shop" contains "fee", and
/// "value" is the commonest wrapper key there is. Requiring a digit lets
/// category text through — surfacing that text is the entire point of the
/// diagnostic.
fn is_money(key: &str, v: &Value) -> bool {
    match v {
        Value::Number(_) => true,
        Value::String(s) => {
            looks_like_money(s)
                || (MONEY_NAMES.iter().any(|m| key.contains(m))
                    && s.chars().any(|c| c.is_ascii_digit()))
        }
        _ => false,
    }
}

fn scrub(v: &mut Value) {
    scrub_under("", v)
}

fn scrub_under(key: &str, v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let k = k.to_lowercase();
                if KEEP.contains(&k.as_str()) {
                    // A scalar under one of these keys is a field we came for.
                    // A container is not, and could be hiding anything.
                    if val.is_object() || val.is_array() {
                        scrub_under(&k, val);
                    }
                    continue;
                }
                if is_money(&k, val) {
                    *val = Value::String("***".into());
                } else {
                    scrub_under(&k, val);
                }
            }
        }
        // Elements inherit the array's key, so {"amounts": ["-12.40"]} is
        // judged exactly as {"amount": "-12.40"} would be.
        Value::Array(arr) => {
            for el in arr.iter_mut() {
                if is_money(key, el) {
                    *el = Value::String("***".into());
                } else {
                    scrub_under(key, el);
                }
            }
        }
        _ => {}
    }
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
        // Without round-robin, account a1's three transactions would fill a
        // sample of 3 and the second institution would never be seen — which
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

    #[test]
    fn fills_up_from_a_single_account_when_it_is_the_only_one() {
        // The common case: one bank connected. The sample must still reach `n`
        // rather than stopping at some per-account ceiling, or a thin sample
        // reads as "my bank sends nothing".
        let body = r#"{"accounts":[{"id":"a","name":"Solo","org":{"name":"Only Bank"},
          "transactions":[{"id":"1"},{"id":"2"},{"id":"3"},{"id":"4"},{"id":"5"},{"id":"6"}]}]}"#;
        let v = parsed(&sample_transactions(body, 5).unwrap());
        assert_eq!(v["sampled"], 5);
    }

    #[test]
    fn samples_everything_available_when_asked_for_more_than_exists() {
        let v = parsed(&sample_transactions(BODY, 99).unwrap());
        assert_eq!(v["sampled"], 4); // three on Everyday, one on Savings
    }

    #[test]
    fn returns_nothing_when_asked_for_nothing() {
        let v = parsed(&sample_transactions(BODY, 0).unwrap());
        assert_eq!(v["sampled"], 0);
    }

    #[test]
    fn tolerates_shapes_simplefin_should_never_send() {
        // Untrusted third-party JSON: degrade to an empty sample, never panic.
        for body in [
            r#"{"accounts":"not an array"}"#,
            r#"{"accounts":[1,2,3]}"#,
            r#"{"accounts":[{"name":"A","transactions":"not an array"}]}"#,
        ] {
            let v = parsed(&sample_transactions(body, 5).unwrap());
            assert_eq!(v["sampled"], 0, "body was {body}");
        }
    }

    #[test]
    fn says_so_when_an_account_carries_no_institution() {
        let body = r#"{"accounts":[{"name":"A","transactions":[{"id":"1"}]}]}"#;
        let v = parsed(&sample_transactions(body, 5).unwrap());
        assert_eq!(v["transactions"][0]["institution"], "Unknown institution");
    }

    #[test]
    fn leaves_no_amount_from_the_fixture_behind() {
        // Asserting that "***" appears somewhere would pass against a redactor
        // that caught one field and missed four. Name every amount instead.
        let redacted = redact(&sample_transactions(BODY, 5).unwrap());
        for leaked in ["12.40", "88.00", "9.99", "2000.00"] {
            assert!(!redacted.contains(leaked), "{leaked} leaked: {redacted}");
        }
        assert!(redacted.contains("***"));
    }

    #[test]
    fn keeps_everything_needed_to_identify_a_field() {
        let redacted = redact(&sample_transactions(BODY, 5).unwrap());
        assert!(redacted.contains("extra"));
        assert!(redacted.contains("Coffee Shops"));
        assert!(redacted.contains("5812"), "the merchant code is the point");
        assert!(redacted.contains("Blue Bottle"));
        assert!(redacted.contains("1788306430"), "timestamps must survive");
    }

    #[test]
    fn redacts_money_inside_fields_nobody_has_seen_before() {
        // The case a key allowlist misses, and the reason this matters: `extra`
        // is the one subtree reaching the clipboard that nobody has examined.
        let body = r#"{"accounts":[{"name":"A","org":{"name":"B"},"transactions":[
          {"id":"t","mcc":"5411","posted":1788306430,
           "extra":{"original_amount":"-42.75","running_balance":9876.54,
                    "amount_cents":4275,"category":"Groceries"}}]}]}"#;
        let redacted = redact(&sample_transactions(body, 5).unwrap());
        assert!(!redacted.contains("42.75"), "unknown money key leaked: {redacted}");
        assert!(!redacted.contains("9876.54"), "unknown money key leaked: {redacted}");
        assert!(!redacted.contains("4275"), "integer cents leaked: {redacted}");
        assert!(redacted.contains("Groceries"), "the category must survive");
        assert!(redacted.contains("5411"), "the merchant code must survive");
    }

    #[test]
    fn redacts_money_at_any_depth() {
        let nested = r#"{"a":{"b":[{"amount":"-5.00","balance":"9.99"}]}}"#;
        let redacted = redact(nested);
        assert!(!redacted.contains("5.00"), "{redacted}");
        assert!(!redacted.contains("9.99"), "{redacted}");
    }

    #[test]
    fn never_returns_unredacted_text_when_it_cannot_parse() {
        // If redaction cannot run, it must not fall back to handing the caller
        // the original, money and all.
        let redacted = redact("not json at all, amount -12.40");
        assert!(!redacted.contains("-12.40"), "leaked on the error path: {redacted}");
    }

    #[test]
    fn redacts_money_under_a_key_name_that_matches_nothing() {
        // Every other fixture's money sits under a key the name list already
        // catches, so without this the shape rule could be deleted in silence.
        // Both values here are strings under keys matching nothing, so only
        // the shape rule can catch them.
        let redacted = redact(r#"{"extra":{"settled":"-42.75","cleared_at_rate":"9876.54"}}"#);
        assert!(!redacted.contains("42.75"), "{redacted}");
        assert!(!redacted.contains("9876.54"), "{redacted}");
    }

    #[test]
    fn redacts_money_held_in_an_array() {
        // Arrays carry no key of their own, so elements inherit the array's.
        let redacted = redact(r#"{"extra":{"splits":[12.40,900],"amounts":["-12.40",1200]}}"#);
        for leaked in ["12.4", "900", "1200"] {
            assert!(!redacted.contains(leaked), "{leaked} leaked: {redacted}");
        }
    }

    #[test]
    fn keeps_a_list_of_category_names() {
        // The fix above must not over-tighten into eating category lists.
        let redacted = redact(r#"{"extra":{"tags":["Food","Coffee"]}}"#);
        assert!(redacted.contains("Food"), "{redacted}");
        assert!(redacted.contains("Coffee"), "{redacted}");
    }

    #[test]
    fn keeps_category_text_sitting_under_a_money_ish_key() {
        // "coffee" contains "fee"; "value" is the commonest wrapper key there
        // is. Eating these would answer the diagnostic's question wrongly.
        let redacted = redact(
            r#"{"extra":{"value":"Groceries","coffee_shop":"Blue Bottle","total_category":"Food"}}"#,
        );
        assert!(redacted.contains("Groceries"), "{redacted}");
        assert!(redacted.contains("Blue Bottle"), "{redacted}");
        assert!(redacted.contains("Food"), "{redacted}");
    }

    #[test]
    fn redacts_money_that_happens_to_be_round() {
        let redacted = redact(r#"{"extra":{"settled":1200,"interest":250}}"#);
        assert!(!redacted.contains("1200"), "{redacted}");
        assert!(!redacted.contains("250"), "{redacted}");
    }

    #[test]
    fn looks_inside_containers_under_kept_keys() {
        // `extra` is unknown by definition, so a container under a kept key
        // could be hiding anything.
        let redacted = redact(r#"{"extra":{"id":{"amount":"-12.40"}}}"#);
        assert!(!redacted.contains("12.40"), "{redacted}");
    }
}
