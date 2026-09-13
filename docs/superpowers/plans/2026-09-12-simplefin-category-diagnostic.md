# SimpleFIN Category Diagnostic (Stage 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Settings button that shows the raw JSON SimpleFIN
actually sends for a few real transactions, so we can see whether this
connection carries the free-form `extra` object that holds an institution's own
category.

**Architecture:** A new pure module `simplefin/diagnose.rs` samples transactions
out of a raw `/accounts` body and redacts the money out of them. `client.rs`
gains `fetch_raw`, which returns the unparsed body — `parse.rs` deliberately
drops every field Ledgerly does not model, which is exactly why the existing
fetch path cannot answer this question. A thin Tauri command wires the two
together; the UI is a button and a `<pre>` block in the existing SimpleFIN card.
Nothing is written to the database.

**Tech Stack:** Rust (serde_json, reqwest blocking), Tauri v2 commands, React 19
+ TypeScript, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-09-12-bank-supplied-categories-design.md`

**Why this ships alone:** Stages 2 and 3 of the spec depend on what this
diagnostic reveals. The public SimpleFIN demo sends no `extra` at all, so the
translation table cannot be written against real values until this has been run.
Building stages 2-3 now would mean guessing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/simplefin/diagnose.rs` | **Create.** Pure: sample transactions from a raw body; redact money. No I/O. |
| `src-tauri/src/simplefin/mod.rs` | **Modify.** Register the new module. |
| `src-tauri/src/simplefin/client.rs` | **Modify.** Add `fetch_raw`; refactor `fetch` to use it. |
| `src-tauri/src/commands/simplefin.rs` | **Modify.** Add the `simplefin_diagnose` command and its return type. |
| `src-tauri/src/lib.rs` | **Modify.** Register the command in the invoke handler. |
| `src/domain/types.ts` | **Modify.** Add the `SimplefinSample` type. |
| `src/data/api.ts` | **Modify.** Add the invoke binding. |
| `src/data/queries.ts` | **Modify.** Add the `useSimplefinDiagnose` hook. |
| `src/features/settings/SimplefinCard.tsx` | **Modify.** Button, output panel, two copy controls. |

The two pure functions live together in `diagnose.rs` because they are used
together and only by the diagnostic; splitting them across files would spread
one responsibility over two.

---

### Task 1: Sample transactions out of a raw response

**Files:**
- Create: `src-tauri/src/simplefin/diagnose.rs`
- Modify: `src-tauri/src/simplefin/mod.rs`

- [ ] **Step 1: Create the module file with only the header and imports**

Create `src-tauri/src/simplefin/diagnose.rs`:

```rust
//! Pure helpers for the SimpleFIN diagnostic: pick a few raw transactions out
//! of an `/accounts` response, and redact the money out of them.
//!
//! No I/O, no database. This module exists because `parse.rs` deliberately
//! keeps only the fields Ledgerly models, dropping SimpleFIN's free-form
//! `extra` object — the very thing we are trying to find. Everything here
//! therefore works on untouched `serde_json::Value` trees.

use serde_json::{json, Value};
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/simplefin/mod.rs`, add `pub mod diagnose;` after the existing
module declarations, so the block reads:

```rust
pub mod parse;
pub mod client;
pub mod sync;
pub mod diagnose;
```

- [ ] **Step 3: Write the failing tests**

Append to `src-tauri/src/simplefin/diagnose.rs`:

```rust
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
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd src-tauri
cargo test diagnose
```

Expected: FAIL to compile, with `cannot find function 'sample_transactions' in this scope`.

- [ ] **Step 5: Write the implementation**

Insert into `src-tauri/src/simplefin/diagnose.rs`, between the `use` line and
the `#[cfg(test)]` block:

```rust
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
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd src-tauri
cargo test diagnose
```

Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/simplefin/diagnose.rs src-tauri/src/simplefin/mod.rs
git commit -m "feat(simplefin): sample raw transactions for the category diagnostic"
```

---

### Task 2: Redact the money out of a sample

> **The code below is the starting draft, not what shipped.** Three rounds of
> code review changed the rules substantially. Read
> `src-tauri/src/simplefin/diagnose.rs` for the truth, and commits `d746532`,
> `f36881b`, `b74d8fb` for how it got there. What changed and why:
>
> 1. **Key allowlist → value shape.** Matching only field names we already know
>    (`amount`, `balance`) sailed past `extra.original_amount` — and `extra` is
>    the one subtree reaching the clipboard that nobody has examined.
> 2. **A name match now requires a digit in the value.** `"coffee_shop"`
>    contains `"fee"`, so payees and category text were being destroyed. That is
>    worse than a leak here: Task 7 pastes the redacted sample into the spec as
>    the permanent record, so over-redaction corrupts the answer being collected.
> 3. **Every number outside the keep-list is redacted**, because round money is
>    still money and `{"charge":1200}` was escaping.
> 4. **Array elements inherit their array's key**, closing a leak that fix 2
>    reopened: `{"amounts":["-12.40"]}` had stopped being caught.
>
> Both load-bearing rules are pinned by mutation: deleting `looks_like_money` or
> emptying `KEEP` each turns exactly one test red.

**Files:**
- Modify: `src-tauri/src/simplefin/diagnose.rs`

The sample is real financial data. The reason to copy it is to share a field
name with someone, and nobody needs balances to read a field name.

- [ ] **Step 1: Write the failing tests**

Add these tests inside the existing `mod tests` block in
`src-tauri/src/simplefin/diagnose.rs`:

```rust
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
        // The failure mode that matters: if redaction cannot run, it must not
        // fall back to handing the caller the original, money and all.
        let redacted = redact("not json at all, amount -12.40");
        assert!(!redacted.contains("-12.40"), "leaked on the error path: {redacted}");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd src-tauri
cargo test diagnose
```

Expected: FAIL to compile, with `cannot find function 'redact' in this scope`.

- [ ] **Step 3: Write the implementation**

Add to `src-tauri/src/simplefin/diagnose.rs`, after `sample_transactions`:

```rust
/// Keys whose values must survive redaction. These are what the diagnostic
/// exists to read: `mcc` and the timestamps are numeric, so a rule based on
/// "looks like a number" would destroy exactly the fields we came for.
const KEEP: &[&str] = &["id", "posted", "transacted_at", "mcc", "pending"];

/// Key-name fragments that mean money regardless of the value's shape. This
/// catches an integer count of cents, which the decimal test below would miss.
const MONEY_NAMES: &[&str] =
    &["amount", "balance", "value", "price", "total", "cost", "cents", "fee"];

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

/// Money is a number with a fractional part, or a string that parses as one.
/// A bare integer is not treated as money, because `mcc` ("5812") and the unix
/// timestamps are bare integers and are the point of the exercise.
fn looks_like_money(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_f64().is_some_and(|f| f.fract() != 0.0),
        Value::String(s) => {
            let cleaned: String = s
                .chars()
                .filter(|c| !matches!(c, '$' | ',' | '(' | ')' | ' ' | '+'))
                .collect();
            cleaned.contains('.') && cleaned.parse::<f64>().is_ok()
        }
        _ => false,
    }
}

fn scrub(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                let key = k.to_lowercase();
                if KEEP.contains(&key.as_str()) {
                    continue;
                }
                if MONEY_NAMES.iter().any(|m| key.contains(m)) || looks_like_money(val) {
                    *val = Value::String("***".into());
                } else {
                    scrub(val);
                }
            }
        }
        Value::Array(arr) => arr.iter_mut().for_each(scrub),
        _ => {}
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd src-tauri
cargo test diagnose
```

Expected: PASS. Ended at 23 after three review rounds; see the note above.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/simplefin/diagnose.rs
git commit -m "feat(simplefin): redact money from diagnostic samples"
```

---

### Task 3: Return the raw body from the HTTP client

**Files:**
- Modify: `src-tauri/src/simplefin/client.rs`

`fetch` currently reads the body and immediately hands it to `parse`, discarding
it. The diagnostic needs the body itself.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `src-tauri/src/simplefin/client.rs`:

```rust
    #[test]
    #[ignore = "hits the network"]
    fn live_demo_fetch_raw_returns_the_unparsed_body() {
        let body = fetch_raw(
            "https://demo:demo@beta-bridge.simplefin.org/simplefin",
            Some(Range::last_days(MAX_WINDOW_DAYS)),
        )
        .unwrap();
        assert!(body.contains("\"accounts\""), "should be the raw JSON document");
        assert!(body.contains("\"mcc\""), "and should carry fields verbatim");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src-tauri
cargo test --lib simplefin::client -- --ignored live_demo_fetch_raw
```

Expected: FAIL to compile, with `cannot find function 'fetch_raw' in this scope`.

- [ ] **Step 3: Add `fetch_raw` and route `fetch` through it**

In `src-tauri/src/simplefin/client.rs`, replace the whole existing `fetch`
function with these two functions:

```rust
/// The raw `/accounts` body, unparsed.
///
/// The diagnostic needs this because `parse` keeps only the fields Ledgerly
/// models and drops everything else — including the free-form `extra` object.
pub fn fetch_raw(access_url: &str, range: Option<Range>) -> Result<String, String> {
    let (url, user, pass) = accounts_request_parts(access_url, range)?;
    let mut req = http()?.get(url);
    if !user.is_empty() {
        req = req.basic_auth(user, pass);
    }
    let resp = req.send().map_err(|_| NETWORK_ERR.to_string())?;
    match resp.status().as_u16() {
        200 => resp.text().map_err(|_| NETWORK_ERR.to_string()),
        402 => Err("Your SimpleFIN subscription needs renewing before Ledgerly can sync.".into()),
        403 => Err("SimpleFIN rejected the saved connection. Disconnect, then connect again with a new setup token.".into()),
        s => Err(format!("SimpleFIN returned an unexpected status ({s}). Try again later.")),
    }
}

fn fetch(access_url: &str, range: Option<Range>) -> Result<SfAccountSet, String> {
    let body = fetch_raw(access_url, range)?;
    parse::parse_accounts_json(&body)
}
```

- [ ] **Step 4: Remove the now-wrong `dead_code` allow on `Range::last_days`**

`last_days` is about to be used by the diagnostic command, not only by an
ignored test. In `src-tauri/src/simplefin/client.rs`, delete this line from the
`impl Range` block:

```rust
    #[allow(dead_code)] // used by the ignored live test
```

so the block reads:

```rust
impl Range {
    /// The last `days` up to now.
    pub fn last_days(days: i64) -> Self {
        Range { since: chrono::Utc::now().timestamp() - days * 86_400, until: None }
    }
}
```

- [ ] **Step 5: Run the full Rust suite to verify nothing regressed**

```bash
cd src-tauri
cargo test
```

Expected: PASS. The count should be 170 passing (147 existing + 23 from Tasks 1-2)
passing, with 9 ignored (8 existing network tests plus the one added above).
`fetch` changed shape
but not behaviour, so no existing test should need editing — if one fails, stop
and investigate rather than adjusting the test.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/simplefin/client.rs
git commit -m "refactor(simplefin): expose the raw accounts body as fetch_raw"
```

---

### Task 4: The Tauri command

**Files:**
- Modify: `src-tauri/src/commands/simplefin.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Import the new module**

In `src-tauri/src/commands/simplefin.rs`, change the existing import line:

```rust
use crate::simplefin::{client, sync, SyncReport};
```

to:

```rust
use crate::simplefin::{client, diagnose, sync, SyncReport};
```

- [ ] **Step 2: Add the command**

Add to `src-tauri/src/commands/simplefin.rs`, immediately after the existing
`simplefin_backfill` command:

```rust
/// How far back the diagnostic looks, and how many transactions it shows.
/// Small on both counts: this is a look at the shape of the data, not an
/// export, and a wide ask spends the SimpleFIN politeness budget for nothing.
const DIAGNOSE_DAYS: i64 = 30;
const DIAGNOSE_SAMPLE: usize = 5;

/// Both renderings of the sample. `raw` is shown on screen; `redacted` is what
/// the default copy button puts on the clipboard.
#[derive(Serialize)]
pub struct SimplefinSample {
    pub raw: String,
    pub redacted: String,
}

/// Show what SimpleFIN actually sends, so we can see whether this connection
/// carries the free-form `extra` object that holds an institution's own
/// category.
///
/// Read-only: it takes no database handle and writes nothing.
#[tauri::command]
pub fn simplefin_diagnose() -> Result<SimplefinSample, String> {
    let access_url = access_url()?;
    let body = client::fetch_raw(&access_url, Some(client::Range::last_days(DIAGNOSE_DAYS)))?;
    let raw = diagnose::sample_transactions(&body, DIAGNOSE_SAMPLE)?;
    let redacted = diagnose::redact(&raw);
    Ok(SimplefinSample { raw, redacted })
}
```

- [ ] **Step 3: Register the command**

In `src-tauri/src/lib.rs`, add one line to the invoke handler list, after
`commands::simplefin::simplefin_backfill,`:

```rust
            commands::simplefin::simplefin_diagnose,
```

- [ ] **Step 4: Verify it compiles and the suite still passes**

```bash
cd src-tauri
cargo test
```

Expected: PASS, 170 tests, no warnings about unused functions.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/simplefin.rs src-tauri/src/lib.rs
git commit -m "feat(simplefin): add the read-only simplefin_diagnose command"
```

---

### Task 5: Frontend binding

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/data/api.ts:58-63`
- Modify: `src/data/queries.ts`

- [ ] **Step 1: Add the type**

Append to `src/domain/types.ts`:

```ts
/** Two renderings of the SimpleFIN diagnostic sample: what to show, and what
 *  is safe to put on the clipboard. */
export type SimplefinSample = { raw: string; redacted: string };
```

- [ ] **Step 2: Add the invoke binding**

In `src/data/api.ts`, inside the `simplefin` object, add after the `backfill`
line:

```ts
    diagnose: () => invoke<SimplefinSample>("simplefin_diagnose"),
```

Then add `SimplefinSample` to the existing type import from `../domain/types` at
the top of the file, alongside the other imported types.

- [ ] **Step 3: Add the hook**

Append to `src/data/queries.ts`:

```ts
/** Read-only: it changes nothing, so there is nothing to invalidate. A
 *  mutation rather than a query because it must only run when clicked. */
export function useSimplefinDiagnose() {
  return useMutation({ mutationFn: () => api.simplefin.diagnose() });
}
```

- [ ] **Step 4: Verify types compile and the suite still passes**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` reports no errors; `npm test` PASSES 126 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/data/api.ts src/data/queries.ts
git commit -m "feat(settings): bind the SimpleFIN diagnostic command"
```

---

### Task 6: The Settings UI

**Files:**
- Modify: `src/features/settings/SimplefinCard.tsx`

This is a thin view over a tested command. The repo has no UI tests and this
plan does not invent a testing approach for one card — Task 7 verifies it by
running the app, which is how the rest of this codebase's UI is checked.

- [ ] **Step 1: Extend the imports**

In `src/features/settings/SimplefinCard.tsx`, change the first two import lines
to:

```tsx
import { useState } from "react";
import { useSimplefinStatus, useSimplefinConnect, useSimplefinSync, useSimplefinDisconnect, useSimplefinBackfill, useSimplefinDiagnose } from "../../data/queries";
```

and change the type import to:

```tsx
import type { SyncReport, SimplefinSample } from "../../domain/types";
```

- [ ] **Step 2: Add the hook and state**

Inside `export function SimplefinCard()`, after the existing
`const backfill = useSimplefinBackfill();` line, add:

```tsx
  const diagnose = useSimplefinDiagnose();
  const [sample, setSample] = useState<SimplefinSample | null>(null);
```

- [ ] **Step 3: Add the handler**

Add after the existing `doDisconnect` function, still inside the component:

```tsx
  function doDiagnose() {
    setError(""); setReport(null);
    diagnose.mutate(undefined, {
      onSuccess: setSample,
      onError: (e) => setError(String(e)),
    });
  }
```

- [ ] **Step 4: Add the button and output panel**

In the `status?.connected` branch, replace this block:

```tsx
          {report && <Report r={report} />}
          {error && <div className="notice neg">{error}</div>}
```

with:

```tsx
          {report && <Report r={report} />}

          <details onToggle={(e) => { if (!(e.currentTarget as HTMLDetailsElement).open) setSample(null); }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Raw transaction data
            </summary>
            <div className="grid" style={{ gap: 10, paddingTop: 10 }}>
              <div className="muted">
                Shows exactly what SimpleFIN sends for a few of your recent
                transactions. Nothing is changed or uploaded — this only reads.
              </div>
              <div className="row center">
                <Button variant="secondary" onClick={doDiagnose} loading={diagnose.isPending}>
                  Show raw transaction data
                </Button>
                {sample && (
                  <>
                    <Button variant="secondary"
                      onClick={() => navigator.clipboard.writeText(sample.redacted)}>
                      Copy (amounts hidden)
                    </Button>
                    <Button variant="secondary"
                      onClick={() => navigator.clipboard.writeText(sample.raw)}>
                      Copy with amounts
                    </Button>
                  </>
                )}
              </div>
              {sample && (
                <pre style={{
                  maxHeight: 320, overflow: "auto", fontSize: 12, lineHeight: 1.5,
                  background: "var(--surface-2)", padding: 12, borderRadius: 8,
                  border: "1px solid var(--line)", whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>{sample.raw}</pre>
              )}
            </div>
          </details>

          {error && <div className="notice neg">{error}</div>}
```

- [ ] **Step 5: Confirm the CSS variables used above are declared in both themes**

```bash
grep -n "\-\-surface-2:\|--line:" src/styles.css
```

Expected: four lines — `--surface-2` and `--line` each declared twice, once
under `:root` (around line 24) and once under `:root[data-theme="dark"]`
(around line 59). Both must exist in both blocks, because a colour declared in
only one theme renders wrong in the other. Do not invent a new variable if
something is missing; use the nearest token already declared in both.

- [ ] **Step 6: Verify types compile and the suite still passes**

```bash
npx tsc --noEmit
npm test
```

Expected: `tsc` reports no errors; `npm test` PASSES 126 tests.

- [ ] **Step 7: Commit**

```bash
git add src/features/settings/SimplefinCard.tsx
git commit -m "feat(settings): show the raw SimpleFIN transaction data"
```

---

### Task 7: Run it and read the answer

**Files:** none — this is the verification step, and the reason the whole stage
exists.

- [ ] **Step 1: Start the app**

```bash
npm run tauri dev
```

- [ ] **Step 2: Open Settings → SimpleFIN → Raw transaction data → Show raw transaction data**

Expected: a JSON block listing up to 5 transactions, each tagged with its
account and institution.

- [ ] **Step 3: Verify the redaction actually works before copying anything**

Click **Copy (amounts hidden)**, paste it somewhere, and confirm every `amount`
and `balance` reads `***` while `description`, `payee` and `mcc` are intact.
Do not skip this — the redacted copy is the one intended for sharing.

- [ ] **Step 4: Read the answer and record it**

Look for an `extra` key on the transactions. One of three outcomes:

1. **`extra` carries a category.** Note the exact key path and copy 5-10 real
   category values. These seed the translation table in the stage 2 plan.
2. **`extra` is present but has no category** (a cleaned merchant name, a
   location, an id). Note what it does carry — stage 2 gets redirected to use it.
3. **No `extra` at all.** Stage 2 as specified is dead. The fallback is the
   merchant-name dictionary, which gets its own spec.

- [ ] **Step 5: Write the outcome into the spec**

Add a short `## Stage 1 result` section to
`docs/superpowers/specs/2026-09-12-bank-supplied-categories-design.md` recording
which of the three outcomes occurred, with the redacted sample pasted in. This
is what the stage 2 plan is written against, so it needs to live somewhere
durable rather than in a chat log.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-09-12-bank-supplied-categories-design.md
git commit -m "docs: record what SimpleFIN actually sends for this connection"
```

---

## Done when

- `cargo test` passes 170 tests (147 existing + 23 new), 9 ignored network tests.
- `npm test` passes 126 tests and `npx tsc --noEmit` is clean.
- The diagnostic runs against the real connection and its result is recorded in
  the spec.
- No migration was added, no table was written to, and no existing test was
  edited.

## Not in this plan

Stages 2 and 3 of the spec — reading the bank category, the translation table,
schema v6, and recategorising history. They are written once Task 7 says which
of the three outcomes is real.
