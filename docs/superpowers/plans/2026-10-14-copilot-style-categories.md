# Copilot-style Categories and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sort SimpleFIN transactions the way Copilot does — transfers recognised, known merchants categorised, everything new waiting in a To review list — using only what SimpleFIN actually sends (a clean `payee`).

**Architecture:** Two new pure Rust modules hold the knowledge: `budget/merchants.rs` (word lists and matching) and `budget/transfers.rs` (pairing equal-and-opposite amounts across the owner's accounts). `categorize::decide()` gains rungs that call the first; `store.rs` gains a pair pass, a whole-history re-sort and review writes. Schema v6 adds `bank_transactions.reviewed` and runs the re-sort once, inside one transaction. The Spending screen gets a Month / To review switch and leaves investment accounts out.

**Tech Stack:** Rust (rusqlite, chrono), React 19 + TanStack Query, Vitest + Testing Library. Spec: `docs/superpowers/specs/2026-10-14-copilot-style-categories-design.md`.

---

## Before you start

- Baselines: `cd src-tauri; cargo test` → **220 passed, 9 ignored**. `npm test` → **278 passed**. `npx tsc --noEmit` clean.
- Work on a branch: `git checkout -b feature/copilot-categories`.
- Never call the browser's `confirm()` — use `askToConfirm` from `src/ui/confirm.ts`.
- A new migration must also go into `db::migration_pending` (HANDOFF gotcha).
- Comments explain *why*; the owner is newer to coding.

## Deviations from the spec, decided while planning

- **Keywords "air" and "inn" are dropped.** As whole words they still catch
  too much ("Hot Air", "Holiday Inn Express" is fine but "Inn" alone is not
  safe); the named airlines and hotels cover the owner's data.
- **The merchant match is longest-phrase-wins**, not list order, so "uber eats"
  (Dining) beats "uber" (Transport) and "amazon prime" beats "amazon".
- **Approve takes a list of ids**, so "Mark all reviewed" approves exactly the
  rows on screen (investment and hidden accounts excluded) rather than every
  unreviewed row in the database.
- **The "76" fuel brand is dropped**: a bare number matches too much.

## File map

| File | Status | Job |
|---|---|---|
| `src-tauri/src/budget/merchants.rs` | create | normalise text; P2P, transfer-wording and merchant lists |
| `src-tauri/src/budget/transfers.rs` | create | pure pairing of equal-and-opposite legs |
| `src-tauri/src/budget/mod.rs` | modify | register both |
| `src-tauri/src/budget/categorize.rs` | modify | new ladder rungs, `account_type` on `Candidate` |
| `src-tauri/src/budget/store.rs` | modify | account type into decisions, pair pass, re-sort, review writes |
| `src-tauri/src/models.rs` | modify | `BankTransaction.reviewed` |
| `src-tauri/src/db.rs` | modify | schema v6 |
| `src-tauri/src/simplefin/sync.rs` | modify | pair pass after a sync |
| `src-tauri/src/commands/budget.rs` | modify | list `reviewed`, to-review list, approve |
| `src-tauri/src/lib.rs` | modify | register commands |
| `src/domain/types.ts` | modify | `reviewed` |
| `src/domain/spending.ts` (+ test) | modify | leave investment accounts out |
| `src/data/api.ts`, `src/data/queries.ts` | modify | review calls and hooks |
| `src/features/spending/TransactionList.tsx` (+ new test) | modify | unreviewed dot, ✓ button |
| `src/features/spending/Spending.tsx` | modify | Month / To review switch |

---

### Task 1: Merchant, transfer and P2P wording (pure)

**Files:**
- Create: `src-tauri/src/budget/merchants.rs`
- Modify: `src-tauri/src/budget/mod.rs`

- [ ] **Step 1: Register the module**

In `src-tauri/src/budget/mod.rs` add `pub mod merchants;` beside the other `pub mod` lines.

- [ ] **Step 2: Write the failing tests**

`src-tauri/src/budget/merchants.rs`:

```rust
//! What a transaction's words say about it. SimpleFIN sends no category and,
//! for the owner's banks, no merchant code — but its `payee` is a clean brand
//! name ("Target", "Chick-fil-A"), which is enough to go on.
//!
//! Pure: no database, no network.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalising_drops_case_apostrophes_and_punctuation() {
        assert_eq!(normalise("Trader Joe's"), "trader joes");
        assert_eq!(normalise("Chick-fil-A"), "chick fil a");
        assert_eq!(normalise("  PG&E   Bill "), "pg e bill");
        assert_eq!(normalise("Raising Cane’s"), "raising canes");
    }

    #[test]
    fn known_merchants_map_to_their_category() {
        assert_eq!(merchant_category(Some("Target"), "TARGET 00012"), Some("Shopping"));
        assert_eq!(merchant_category(Some("Trader Joe's"), ""), Some("Groceries"));
        assert_eq!(merchant_category(Some("Chick-fil-A"), ""), Some("Dining"));
        assert_eq!(merchant_category(Some("Spotify"), ""), Some("Subscriptions"));
        assert_eq!(merchant_category(Some("Allegiant Air"), ""), Some("Travel"));
    }

    #[test]
    fn a_merchant_must_match_whole_words() {
        assert_eq!(merchant_category(Some("Targeted Ads Inc"), ""), None);
    }

    #[test]
    fn the_longest_match_wins() {
        assert_eq!(merchant_category(Some("Uber Eats"), ""), Some("Dining"));
        assert_eq!(merchant_category(Some("Uber"), ""), Some("Transport"));
        assert_eq!(merchant_category(Some("Amazon Prime"), ""), Some("Subscriptions"));
    }

    #[test]
    fn keywords_catch_what_the_list_does_not() {
        assert_eq!(merchant_category(Some("Bob's Burger Shack"), ""), Some("Dining"));
        assert_eq!(merchant_category(Some("Haggin Oaks Golf Complex"), ""), Some("Entertainment"));
        assert_eq!(merchant_category(None, "SKY HARBOR PARKING 22"), Some("Transport"));
    }

    #[test]
    fn a_merchant_name_beats_a_keyword() {
        // "store" is a Shopping keyword; Apple's App Store is a subscription.
        assert_eq!(merchant_category(Some("Apple"), "APPLE.COM/BILL STORE"), Some("Subscriptions"));
    }

    #[test]
    fn an_unknown_payee_has_no_category() {
        assert_eq!(merchant_category(Some("Zqx Holdings"), "ZQX 1234"), None);
    }

    #[test]
    fn money_sent_to_people_is_recognised() {
        assert!(is_person_to_person(Some("Transfer to Apple Pay"), ""));
        assert!(is_person_to_person(Some("Transfer to Venmo"), ""));
        assert!(is_person_to_person(None, "ZELLE PAYMENT TO JANE"));
        assert!(!is_person_to_person(Some("Apple"), ""));
    }

    #[test]
    fn transfer_wording_is_recognised() {
        assert!(is_transfer_wording(Some("Credit Card Payment"), "Robinhood Credit Card payment"));
        assert!(is_transfer_wording(Some("Automatic Payment"), "AUTOMATIC PAYMENT - THANK"));
        assert!(is_transfer_wording(Some("Chase Credit Card"), "CHASE CREDIT CRD DES:AUTOPAY ID:X"));
        assert!(is_transfer_wording(Some("Payment"), "Payment"));
        assert!(is_transfer_wording(Some("Gold Payment"), "Gold Card payment"));
        assert!(is_transfer_wording(Some("Robinhood"), "Robinhood CCB DES:Payment"));
        assert!(is_transfer_wording(Some("Transfer to Checking"), ""));
    }

    #[test]
    fn ordinary_purchases_are_not_transfer_wording() {
        assert!(!is_transfer_wording(Some("Target"), "TARGET 00012"));
        // "Payment" must be the whole payee, not any payee mentioning one.
        assert!(!is_transfer_wording(Some("Payment Processing Fees LLC"), ""));
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri; cargo test budget::merchants`
Expected: compile errors — `normalise`, `merchant_category`, … not found.

- [ ] **Step 4: Implement** (above the tests block)

```rust
/// Lower-case, apostrophes removed, every other non-alphanumeric run turned
/// into one space, trimmed. "Trader Joe's" and "TRADER JOES" then compare equal.
pub fn normalise(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for ch in s.chars() {
        if ch == '\'' || ch == '’' {
            continue;
        }
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
            space = false;
        } else if !space && !out.is_empty() {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

/// Does `phrase` appear in `text` as whole words? Both already normalised.
fn has_phrase(text: &str, phrase: &str) -> bool {
    !phrase.is_empty() && format!(" {text} ").contains(&format!(" {phrase} "))
}

/// Money sent to people. Never filed as a transfer or a purchase: a split
/// dinner is Dining and rent is Rent, and only the owner knows which.
const PERSON_TO_PERSON: &[&str] = &["apple pay", "apple cash", "venmo", "zelle", "cash app", "paypal"];

/// Wording that means money moving between the owner's own accounts.
const TRANSFER_PHRASES: &[&str] = &[
    "credit card payment", "card payment", "automatic payment", "autopay",
    "payment thank you", "credit crd", "transfer to checking", "transfer to savings",
    "transfer from", "online transfer",
];

/// Payees that are a transfer only when they are the *whole* payee. "Payment"
/// alone is how the Robinhood card labels a payment received; a payee merely
/// containing the word is not. The brokerages are the owner's own accounts —
/// checked against their data on 2026-10-14, every "Robinhood" row there was a
/// card payment or a move between their accounts.
const TRANSFER_PAYEES: &[&str] = &[
    "payment", "gold payment", "robinhood", "robinhood money", "fidelity", "schwab", "vanguard",
];

/// Known merchants, by category. Seeded from the owner's top payees and common
/// US chains; the review list and payee rules exist to correct the rest.
const MERCHANTS: &[(&str, &[&str])] = &[
    ("Groceries", &[
        "trader joes", "costco", "safeway", "whole foods", "kroger", "aldi", "sprouts",
        "raleys", "winco", "save mart", "grocery outlet", "smart final",
    ]),
    ("Dining", &[
        "chick fil a", "in n out", "in n out burger", "taco bell", "panda express",
        "raising canes", "starbucks", "mcdonalds", "chipotle", "menchies",
        "menchies frozen yogurt", "doordash", "uber eats", "dutch bros", "subway",
        "wendys", "jack in the box", "dominos", "pizza hut", "panera bread", "five guys",
    ]),
    ("Shopping", &["target", "amazon", "walmart", "best buy", "home depot", "lowes", "ikea", "ebay", "etsy"]),
    ("Transport", &["uber", "lyft"]),
    ("Fuel", &["shell", "chevron", "arco", "exxon", "valero"]),
    ("Travel", &[
        "allegiant air", "southwest", "southwest airlines", "delta", "delta air lines",
        "united airlines", "alaska airlines", "american airlines", "jetblue", "airbnb",
        "marriott", "hilton", "hyatt", "expedia",
    ]),
    ("Subscriptions", &[
        "spotify", "netflix", "hulu", "disney plus", "youtube premium", "apple", "icloud",
        "anthropic", "openai", "chatgpt", "amazon prime", "audible",
    ]),
    ("Utilities", &["pg e", "smud", "comcast", "xfinity", "at t", "verizon", "t mobile"]),
    ("Health", &["cvs", "walgreens", "kaiser"]),
    ("Entertainment", &["amc", "regal", "steam", "ticketmaster"]),
];

/// Single words that point at a category when no merchant matched.
const KEYWORDS: &[(&str, &[&str])] = &[
    ("Dining", &["burger", "taco", "pizza", "grill", "cafe", "coffee", "restaurant"]),
    ("Travel", &["airline", "airlines", "hotel"]),
    ("Entertainment", &["golf"]),
    ("Transport", &["parking", "toll"]),
    ("Fees", &["fee", "interest charge"]),
    ("Shopping", &["store", "shop"]),
];

fn texts(payee: Option<&str>, description: &str) -> (String, String) {
    (payee.map(normalise).unwrap_or_default(), normalise(description))
}

pub fn is_person_to_person(payee: Option<&str>, description: &str) -> bool {
    let (p, d) = texts(payee, description);
    PERSON_TO_PERSON.iter().any(|w| has_phrase(&p, w) || has_phrase(&d, w))
}

pub fn is_transfer_wording(payee: Option<&str>, description: &str) -> bool {
    let (p, d) = texts(payee, description);
    TRANSFER_PAYEES.iter().any(|w| p == *w)
        || TRANSFER_PHRASES.iter().any(|w| has_phrase(&p, w) || has_phrase(&d, w))
}

/// The longest phrase from `lists` found in `text`, with its category.
fn longest(lists: &[(&'static str, &[&'static str])], text: &str) -> Option<(&'static str, usize)> {
    lists
        .iter()
        .flat_map(|(cat, words)| words.iter().map(move |w| (*cat, *w)))
        .filter(|(_, w)| has_phrase(text, w))
        .map(|(cat, w)| (cat, w.len()))
        .max_by_key(|(_, len)| *len)
}

/// A built-in category name for a known merchant or keyword, or `None`.
/// Merchants beat keywords; the payee is tried before the description, which
/// is noisier ("APPLE.COM/BILL STORE").
pub fn merchant_category(payee: Option<&str>, description: &str) -> Option<&'static str> {
    let (p, d) = texts(payee, description);
    for lists in [MERCHANTS, KEYWORDS] {
        for text in [&p, &d] {
            if let Some((cat, _)) = longest(lists, text) {
                return Some(cat);
            }
        }
    }
    None
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri; cargo test budget::merchants`
Expected: **10 passed**.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/budget
git commit -m "feat(budget): recognise merchants, transfers and payments to people by name"
```

---

### Task 2: Transfer pairs (pure)

**Files:**
- Create: `src-tauri/src/budget/transfers.rs`
- Modify: `src-tauri/src/budget/mod.rs` (`pub mod transfers;`)

- [ ] **Step 1: Write the failing tests**

`src-tauri/src/budget/transfers.rs`:

```rust
//! Pairing money that left one of the owner's accounts with the same amount
//! arriving in another — a card autopay, savings to brokerage — so both sides
//! are filed as a transfer even when the wording says nothing.
//!
//! Pure: the caller decides which rows are eligible (automatic, not a payment
//! to a person) and writes the result.

#[cfg(test)]
mod tests {
    use super::*;

    fn leg(id: i64, account_id: i64, posted: &str, amount: f64) -> Leg {
        Leg { id, account_id, posted: posted.into(), amount }
    }

    #[test]
    fn a_card_payment_pairs_with_the_payment_received() {
        let legs = vec![
            leg(1, 10, "2026-10-12", -40.59), // Bank of America: "Chase Credit Card"
            leg(2, 20, "2026-10-11", 40.59),  // Chase: "Automatic Payment"
        ];
        assert_eq!(pair(&legs), vec![1, 2]);
    }

    #[test]
    fn amounts_a_cent_apart_do_not_pair() {
        assert!(pair(&[leg(1, 10, "2026-10-12", -40.59), leg(2, 20, "2026-10-12", 40.58)]).is_empty());
    }

    #[test]
    fn the_same_account_does_not_pair_with_itself() {
        // A refund of a purchase is not a transfer.
        assert!(pair(&[leg(1, 10, "2026-10-12", -25.00), leg(2, 10, "2026-10-13", 25.00)]).is_empty());
    }

    #[test]
    fn legs_more_than_five_days_apart_do_not_pair() {
        assert!(pair(&[leg(1, 10, "2026-10-01", -100.0), leg(2, 20, "2026-10-07", 100.0)]).is_empty());
        assert_eq!(pair(&[leg(1, 10, "2026-10-01", -100.0), leg(2, 20, "2026-10-06", 100.0)]), vec![1, 2]);
    }

    #[test]
    fn each_leg_pairs_once_closest_date_first() {
        let legs = vec![
            leg(1, 10, "2026-10-01", -50.0),
            leg(2, 20, "2026-10-04", 50.0),
            leg(3, 30, "2026-10-02", 50.0),
        ];
        // 1 pairs with 3 (one day) rather than 2 (three days); 2 is left alone.
        assert_eq!(pair(&legs), vec![1, 3]);
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri; cargo test budget::transfers`
Expected: compile errors — `Leg`, `pair` not found.

- [ ] **Step 3: Implement** (above the tests block)

```rust
use chrono::NaiveDate;

/// How far apart, in days, the two sides of a transfer may post. Card
/// payments and ACH moves settle in one to three business days.
pub const PAIR_WINDOW_DAYS: i64 = 5;

#[derive(Debug, Clone, PartialEq)]
pub struct Leg {
    pub id: i64,
    pub account_id: i64,
    /// YYYY-MM-DD
    pub posted: String,
    /// Negative is money out.
    pub amount: f64,
}

/// The ids of every leg that pairs, ascending. A pair is one leg out and one
/// leg in, equal to the cent, in different accounts, within
/// `PAIR_WINDOW_DAYS`. Each leg pairs at most once, closest dates first.
pub fn pair(legs: &[Leg]) -> Vec<i64> {
    let cents = |a: f64| (a * 100.0).round() as i64;
    let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();

    let mut candidates: Vec<(i64, i64, i64)> = Vec::new(); // (gap, out id, in id)
    for out in legs.iter().filter(|l| cents(l.amount) < 0) {
        for inc in legs.iter().filter(|l| cents(l.amount) == -cents(out.amount)) {
            if inc.account_id == out.account_id {
                continue;
            }
            let (Some(a), Some(b)) = (day(&out.posted), day(&inc.posted)) else { continue };
            let gap = (a - b).num_days().abs();
            if gap <= PAIR_WINDOW_DAYS {
                candidates.push((gap, out.id, inc.id));
            }
        }
    }
    candidates.sort();

    let mut used = std::collections::BTreeSet::new();
    for (_, out, inc) in candidates {
        if !used.contains(&out) && !used.contains(&inc) {
            used.insert(out);
            used.insert(inc);
        }
    }
    used.into_iter().collect()
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri; cargo test budget::transfers`
Expected: **5 passed**.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/budget
git commit -m "feat(budget): pair equal and opposite amounts between your own accounts"
```

---

### Task 3: The new ladder

**Files:**
- Modify: `src-tauri/src/budget/categorize.rs`

- [ ] **Step 1: Give the test helper an account type**

In the `tests` module, change `candidate(...)` to build `account_type: "cash".into(),` as its last field, so the nine existing tests keep their meaning (money in on a cash account is still Income).

- [ ] **Step 2: Write the failing tests** (append to the `tests` module)

```rust
    fn on(account_type: &str, payee: &str, description: &str, amount: f64) -> Candidate {
        Candidate {
            payee: Some(payee.into()),
            description: description.into(),
            mcc: None,
            amount,
            account_type: account_type.into(),
        }
    }

    #[test]
    fn a_known_merchant_is_categorised_without_a_merchant_code() {
        assert_eq!(decide(&on("credit", "Target", "TARGET 0001", -25.0), &[]), Decision::Builtin("Shopping"));
    }

    #[test]
    fn a_payee_rule_beats_a_known_merchant() {
        let rules = vec![rule("payee", "costco", 9)];
        assert_eq!(decide(&on("credit", "Costco", "", -80.0), &rules), Decision::Rule(9));
    }

    #[test]
    fn transfer_wording_files_a_transfer() {
        let c = on("credit", "Automatic Payment", "AUTOMATIC PAYMENT - THANK", 40.59);
        assert_eq!(decide(&c, &[]), Decision::Builtin("Transfer"));
    }

    #[test]
    fn money_to_a_person_is_left_for_the_owner_even_when_it_says_transfer() {
        let c = on("cash", "Transfer to Apple Pay", "", -30.0);
        assert_eq!(decide(&c, &[]), Decision::None);
    }

    #[test]
    fn money_in_on_a_credit_card_is_not_income() {
        assert_eq!(decide(&on("credit", "Zqx Holdings", "", 19.99), &[]), Decision::None);
        assert_eq!(decide(&on("cash", "Zqx Holdings", "", 19.99), &[]), Decision::Income);
    }
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri; cargo test budget::categorize`
Expected: compile error — no field `account_type` on `Candidate`.

- [ ] **Step 4: Implement**

Add the field to `Candidate`:

```rust
    /// "cash", "credit" or "brokerage". Money in on a card is a refund or a
    /// payment, never income.
    pub account_type: String,
```

Change `use super::mcc;` to `use super::{mcc, merchants};` and replace the body of `decide` from step 4 onwards (everything after the description-rules block) with:

```rust
    // 4. Money sent to a person: only the owner knows what it was for, so no
    //    rung below may call it a transfer or a purchase.
    if merchants::is_person_to_person(c.payee.as_deref(), &c.description) {
        return Decision::None;
    }
    // 5. Money moving between the owner's own accounts.
    if merchants::is_transfer_wording(c.payee.as_deref(), &c.description) {
        return Decision::Builtin("Transfer");
    }
    // 6. The built-in merchant-code map. Most banks here send no code, so this
    //    rarely fires, but it is right when it does.
    if let Some(code) = c.mcc.as_deref() {
        if let Some(name) = mcc::category_for(code) {
            return Decision::Builtin(name);
        }
    }
    // 7. A known merchant or keyword.
    if let Some(name) = merchants::merchant_category(c.payee.as_deref(), &c.description) {
        return Decision::Builtin(name);
    }
    // 8. Money in, with nothing else to go on — but only on a cash account.
    if c.amount > 0.0 && c.account_type != "credit" {
        return Decision::Income;
    }
    Decision::None
}
```

Update the doc comment on `decide` to: "Decide a category. User rules first, then payments to people (left alone), transfer wording, the merchant-code map, known merchants, and finally money in on a cash account as Income. Manual categories are honoured by the caller, which simply does not ask about them."

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri; cargo test budget::categorize`
Expected: all pass (the nine existing plus five new).

`store.rs` will not compile yet (its `candidate()` builds a `Candidate` without `account_type`) — Task 4 fixes it. If running the whole suite now, expect that error.

- [ ] **Step 6: Commit** (together with Task 4, which makes the crate compile again)

---

### Task 4: Account type into decisions; pair pass; re-sort; review writes

**Files:**
- Modify: `src-tauri/src/budget/store.rs`, `src-tauri/src/models.rs`

- [ ] **Step 1: `BankTransaction.reviewed`**

In `src-tauri/src/models.rs`, add to `BankTransaction` after `category_source`:

```rust
    /// False until the owner has looked at it: approved it, or chosen a category.
    pub reviewed: bool,
```

- [ ] **Step 2: Write the failing tests** (append to `store.rs`'s `tests` module)

```rust
    fn category_named(conn: &Connection, id: Option<i64>) -> Option<String> {
        id.and_then(|id| conn.query_row("SELECT name FROM categories WHERE id=?1", [id], |r| r.get(0)).ok())
    }

    fn row(conn: &Connection, ext: &str) -> (Option<String>, String, bool) {
        let (cat, source, reviewed): (Option<i64>, String, i64) = conn.query_row(
            "SELECT category_id, category_source, reviewed FROM bank_transactions WHERE external_id=?1",
            [ext], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        (category_named(conn, cat), source, reviewed != 0)
    }

    fn payee_txn(ext: &str, posted: &str, amount: f64, payee: &str) -> IncomingTxn {
        IncomingTxn {
            external_id: ext.into(), posted: posted.into(), amount,
            description: payee.to_uppercase(), payee: Some(payee.into()),
            memo: None, mcc: None, pending: false,
        }
    }

    #[test]
    fn money_in_on_a_card_is_not_income_when_synced() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("r1", "2026-10-01", 12.0, "Zqx Holdings")], &[]).unwrap();
        assert_eq!(row(&conn, "r1").0, None);
    }

    #[test]
    fn a_new_transaction_arrives_unreviewed() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Target")], &[]).unwrap();
        assert_eq!(row(&conn, "t1"), (Some("Shopping".into()), "auto".into(), false));
    }

    #[test]
    fn matched_legs_across_accounts_become_transfers() {
        let conn = db::open_in_memory().unwrap();
        let bank = account(&conn, "Checking", "cash");
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, bank, &[payee_txn("out", "2026-10-12", -40.59, "Zqx Holdings")], &[]).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("in", "2026-10-11", 40.59, "Zqx Holdings")], &[]).unwrap();

        assert_eq!(mark_transfer_pairs(&conn, "2026-01-01").unwrap(), 2);
        assert_eq!(row(&conn, "out").0.as_deref(), Some("Transfer"));
        assert_eq!(row(&conn, "in").0.as_deref(), Some("Transfer"));
    }

    #[test]
    fn payments_to_people_and_manual_rows_never_pair() {
        let conn = db::open_in_memory().unwrap();
        let bank = account(&conn, "Checking", "cash");
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, bank, &[payee_txn("venmo", "2026-10-12", -20.0, "Transfer to Venmo")], &[]).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("refund", "2026-10-12", 20.0, "Zqx Holdings")], &[]).unwrap();
        upsert_transactions(&conn, bank, &[payee_txn("mine", "2026-10-12", -33.0, "Zqx Holdings")], &[]).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("other", "2026-10-12", 33.0, "Zqx Holdings")], &[]).unwrap();
        let mine: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='mine'", [], |r| r.get(0)).unwrap();
        set_category(&conn, mine, None, false).unwrap();

        assert_eq!(mark_transfer_pairs(&conn, "2026-01-01").unwrap(), 0);
    }

    #[test]
    fn the_re_sort_updates_automatic_rows_and_leaves_manual_ones() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card", "credit");
        // Rows written as an older build would have left them: no category.
        for (ext, payee) in [("a", "Target"), ("m", "Costco")] {
            conn.execute(
                "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee)
                 VALUES (?1,?2,'2026-10-01',-10,?3,?3)",
                params![card, ext, payee],
            ).unwrap();
        }
        let m: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='m'", [], |r| r.get(0)).unwrap();
        set_category(&conn, m, None, false).unwrap();

        recategorise_all(&conn).unwrap();

        assert_eq!(row(&conn, "a").0.as_deref(), Some("Shopping"));
        assert_eq!(row(&conn, "m").0, None, "a manual choice is never re-decided");
    }

    #[test]
    fn choosing_a_category_marks_the_row_reviewed() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Zqx Holdings")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        let dining = seed::category_id(&conn, "Dining").unwrap();
        set_category(&conn, id, dining, false).unwrap();
        assert_eq!(row(&conn, "t1"), (Some("Dining".into()), "manual".into(), true));
    }

    #[test]
    fn approving_marks_reviewed_and_locks_the_category() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Target")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();

        assert_eq!(approve(&conn, &[id]).unwrap(), 1);
        assert_eq!(row(&conn, "t1"), (Some("Shopping".into()), "manual".into(), true));
    }

    #[test]
    fn a_later_sync_does_not_unreview_a_row() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Target")], &[]).unwrap();
        conn.execute("UPDATE bank_transactions SET reviewed=1", []).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.5, "Target")], &[]).unwrap();
        assert!(row(&conn, "t1").2);
    }
```

These need the v6 column, so they fail until Task 5 too — that is expected; the compile errors come first.

- [ ] **Step 3: Implement**

At the top of `store.rs`, change the imports to:

```rust
use super::categorize::{self, Candidate, Decision, Rule};
use super::{merchants, seed, transfers};
use rusqlite::{params, Connection, OptionalExtension};
```

In `upsert_transactions`, look the account type up once, before the loop:

```rust
    // Money in on a card is a refund or a payment, not income, so the decision
    // needs to know what kind of account this is.
    let account_type: String = conn.query_row(
        "SELECT type FROM accounts WHERE id=?1", [account_id], |r| r.get(0),
    )?;
```

and pass it: both `categorize::decide(&candidate(t), rules)` calls become `categorize::decide(&candidate(t, &account_type), rules)`. Replace `fn candidate`:

```rust
fn candidate(t: &IncomingTxn, account_type: &str) -> Candidate {
    Candidate {
        payee: t.payee.clone(),
        description: t.description.clone(),
        mcc: t.mcc.clone(),
        amount: t.amount,
        account_type: account_type.to_string(),
    }
}
```

In `set_category`, change the first `UPDATE` to also mark the row reviewed:

```rust
        "UPDATE bank_transactions SET category_id=?1, category_source='manual', reviewed=1 WHERE id=?2",
```

Add these functions after `set_category`:

```rust
/// File as Transfer every automatic row, posted on or after `since`, that has
/// an equal-and-opposite partner in another of the owner's accounts. Payments
/// to people never pair: a friend repaying dinner is not a transfer.
/// Returns how many rows it marked.
pub fn mark_transfer_pairs(conn: &Connection, since: &str) -> rusqlite::Result<usize> {
    let Some(transfer) = seed::category_id(conn, "Transfer")? else { return Ok(0) };
    let mut stmt = conn.prepare(
        "SELECT id, account_id, posted, amount, payee, description FROM bank_transactions
         WHERE category_source='auto' AND posted >= ?1",
    )?;
    let legs: Vec<transfers::Leg> = stmt
        .query_map([since], |r| {
            Ok((
                transfers::Leg { id: r.get(0)?, account_id: r.get(1)?, posted: r.get(2)?, amount: r.get(3)? },
                r.get::<_, Option<String>>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, payee, description)| !merchants::is_person_to_person(payee.as_deref(), description))
        .map(|(leg, _, _)| leg)
        .collect();
    let ids = transfers::pair(&legs);
    for id in &ids {
        conn.execute("UPDATE bank_transactions SET category_id=?1 WHERE id=?2", params![transfer, id])?;
    }
    Ok(ids.len())
}

/// Re-decide every automatic row from what is already stored, then pair
/// transfers across all of history. No network: payee, description, amount
/// and account type are all on hand. Manual rows are never touched.
pub fn recategorise_all(conn: &Connection) -> rusqlite::Result<usize> {
    let rules = load_rules(conn)?;
    let mut stmt = conn.prepare(
        "SELECT b.id, b.payee, b.description, b.mcc, b.amount, a.type
         FROM bank_transactions b JOIN accounts a ON a.id = b.account_id
         WHERE b.category_source='auto'",
    )?;
    let rows: Vec<(i64, Candidate)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, Candidate {
                payee: r.get(1)?, description: r.get(2)?, mcc: r.get(3)?,
                amount: r.get(4)?, account_type: r.get(5)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (id, c) in &rows {
        let category = resolve(conn, categorize::decide(c, &rules))?;
        conn.execute("UPDATE bank_transactions SET category_id=?1 WHERE id=?2", params![category, id])?;
    }
    mark_transfer_pairs(conn, "0000-01-01")?;
    Ok(rows.len())
}

/// Accept rows as they are: reviewed, and their category made manual so a
/// later change to the merchant lists can never move something the owner
/// already accepted. Returns how many rows changed.
pub fn approve(conn: &Connection, ids: &[i64]) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for id in ids {
        changed += conn.execute(
            "UPDATE bank_transactions SET reviewed=1, category_source='manual' WHERE id=?1",
            [id],
        )?;
    }
    Ok(changed)
}
```

- [ ] **Step 4: Compile** (tests need Task 5's column)

Run: `cd src-tauri; cargo test budget:: --no-run`
Expected: compiles. Running them now fails with "no such column: reviewed" — Task 5.

---

### Task 5: Schema v6 — the `reviewed` column and the one-time re-sort

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write the failing tests** (in `db.rs`'s `tests` module)

```rust
    #[test]
    fn v6_re_sorts_existing_rows_and_reviews_only_the_categorised_ones() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        // Undo v6 to stand in for a v5 database with rows from an older build.
        conn.execute_batch(
            "ALTER TABLE bank_transactions DROP COLUMN reviewed;
             INSERT INTO accounts (id,name,type,created_at) VALUES (90,'Card','credit','2026-10-01');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee)
               VALUES (90,'shop','2026-10-01',-10,'TARGET','Target'),
                      (90,'mystery','2026-10-02',-10,'ZQX','Zqx Holdings');",
        ).unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();

        let get = |ext: &str| -> (Option<String>, i64) {
            conn.query_row(
                "SELECT c.name, b.reviewed FROM bank_transactions b
                 LEFT JOIN categories c ON c.id=b.category_id WHERE b.external_id=?1",
                [ext], |r| Ok((r.get(0)?, r.get(1)?)),
            ).unwrap()
        };
        assert_eq!(get("shop"), (Some("Shopping".into()), 1));
        assert_eq!(get("mystery"), (None, 0), "only what is still uncategorised waits for review");
        assert!(!migration_pending(&conn).unwrap());
    }

    #[test]
    fn v6_run_twice_changes_nothing() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        apply_migrations(&conn).unwrap();
        assert!(column_exists(&conn, "bank_transactions", "reviewed").unwrap());
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri; cargo test db::tests::v6`
Expected: FAIL — no column `reviewed` to drop / migration not applied.

- [ ] **Step 3: Implement**

Set `const TARGET_VERSION: i64 = 6;` and extend its doc comment's version list with "v6 adds `reviewed` to bank transactions and re-sorts them once."

Add, beside the v5 helpers:

```rust
/// v6: bank transactions can be reviewed, as in Copilot.
const V6_COLUMN: (&str, &str) = ("reviewed", "reviewed INTEGER NOT NULL DEFAULT 0");

fn v6_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    column_exists(conn, "bank_transactions", V6_COLUMN.0)
}

/// Adds the column, re-sorts every automatic row with the new rules, then
/// marks reviewed exactly the rows that ended up with a category — the owner
/// chose to review only what is still uncategorised. One transaction, so an
/// interruption leaves the old schema or the finished one, never a column with
/// nothing marked (which would bury every transaction in the review list).
fn apply_v6(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    add_column_if_missing(&tx, "bank_transactions", V6_COLUMN.0, V6_COLUMN.1)?;
    crate::budget::store::recategorise_all(&tx)?;
    tx.execute("UPDATE bank_transactions SET reviewed = (category_id IS NOT NULL)", [])?;
    tx.commit()
}
```

In `apply_migrations`, after the v5 block:

```rust
    if !v6_is_complete(conn)? {
        apply_v6(conn)?;
    }
```

In `migration_pending`, add `|| !v6_is_complete(conn)?` after the v5 check.

- [ ] **Step 4: Run all Rust tests**

Run: `cd src-tauri; cargo test`
Expected: all pass — 220 + 10 merchants + 5 transfers + 5 ladder + 8 store + 2 db = **250 passed**. Any other test that builds a `BankTransaction` literal needs `reviewed: false` added.

- [ ] **Step 5: Commit Tasks 3–5**

```bash
git add src-tauri/src
git commit -m "feat(budget): sort by merchant and transfer, review flag, one-time re-sort (v6)"
```

---

### Task 6: Pair transfers after every sync; review commands

**Files:**
- Modify: `src-tauri/src/simplefin/sync.rs`, `src-tauri/src/commands/budget.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Pair after a sync**

In `sync::apply`, after the account loop and before `remove_unshared`, add:

```rust
    // Transfers can only be paired once every account is in: the two sides
    // of a card payment arrive in different accounts. Only recent rows are
    // looked at, so the cost stays flat as history grows.
    let since = (chrono::Local::now().date_naive() - chrono::Duration::days(60))
        .format("%Y-%m-%d")
        .to_string();
    if let Err(e) = crate::budget::store::mark_transfer_pairs(conn, &since) {
        report.errors.push(format!("Matching transfers: {e}"));
    }
```

- [ ] **Step 2: List `reviewed`; the to-review list; approve**

In `commands/budget.rs`, `list_transactions`: add `reviewed` to the SELECT after `category_source`, and `reviewed: r.get::<_, i64>(12)? != 0,` to the struct. Then factor the row mapping so a second query can reuse it:

```rust
const TXN_COLUMNS: &str = "id,account_id,external_id,posted,amount,description,payee,memo,mcc,pending,
                           category_id,category_source,reviewed";

fn txn_from_row(r: &rusqlite::Row) -> rusqlite::Result<BankTransaction> {
    Ok(BankTransaction {
        id: r.get(0)?, account_id: r.get(1)?, external_id: r.get(2)?, posted: r.get(3)?,
        amount: r.get(4)?, description: r.get(5)?, payee: r.get(6)?, memo: r.get(7)?,
        mcc: r.get(8)?, pending: r.get::<_, i64>(9)? != 0,
        category_id: r.get(10)?, category_source: r.get(11)?,
        reviewed: r.get::<_, i64>(12)? != 0,
    })
}

pub fn list_transactions(conn: &Connection, from: &str, to: &str)
    -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE posted >= ?1 AND posted <= ?2
         ORDER BY posted DESC, id DESC"
    ))?;
    let rows = stmt.query_map([from, to], txn_from_row)?;
    rows.collect()
}

/// Every transaction the owner has not looked at yet, any month, newest first.
pub fn list_to_review(conn: &Connection) -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE reviewed = 0
         ORDER BY posted DESC, id DESC"
    ))?;
    let rows = stmt.query_map([], txn_from_row)?;
    rows.collect()
}

#[tauri::command]
pub fn bank_transactions_to_review(db: tauri::State<Db>) -> Result<Vec<BankTransaction>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list_to_review(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bank_transactions_approve(db: tauri::State<Db>, ids: Vec<i64>) -> Result<usize, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::approve(&conn, &ids).map_err(|e| e.to_string())
}
```

Add a test to the module's `tests`:

```rust
    #[test]
    fn the_review_list_holds_only_unreviewed_rows() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO accounts (name,type,currency,created_at) VALUES ('C','credit','USD','2026-01-01')", []).unwrap();
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,reviewed)
             VALUES (1,'new','2026-10-02',-5,'x',0), (1,'seen','2026-10-01',-5,'y',1);",
        ).unwrap();
        let ids: Vec<String> = list_to_review(&conn).unwrap().into_iter().map(|t| t.external_id).collect();
        assert_eq!(ids, vec!["new".to_string()]);
    }
```

- [ ] **Step 3: Register the commands**

In `lib.rs`'s `generate_handler!`, after `commands::budget::bank_transaction_set_category,`, add:

```rust
            commands::budget::bank_transactions_to_review,
            commands::budget::bank_transactions_approve,
```

- [ ] **Step 4: Run all Rust tests**

Run: `cd src-tauri; cargo test`
Expected: **251 passed**.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "feat(budget): pair transfers after each sync, review list and approve"
```

---

### Task 7: Frontend — types, investment filter, calls, hooks

**Files:**
- Modify: `src/domain/types.ts`, `src/domain/spending.ts`, `src/domain/spending.test.ts`, `src/data/api.ts`, `src/data/queries.ts`

- [ ] **Step 1: Type**

In `BankTransaction` in `src/domain/types.ts`, add after `category_source`:

```ts
  /** False until the owner has approved it or chosen a category. */
  reviewed: boolean;
```

Fix any test fixture that builds a `BankTransaction` literal by adding `reviewed: true` (TypeScript will list them).

- [ ] **Step 2: Failing test for the investment filter** (in `spending.test.ts`'s `fromVisibleAccounts` block)

```ts
  it("leaves investment accounts out, as Copilot does", () => {
    const brokerage = { ...accounts[0], id: 3, type: "brokerage" as const, hidden: false };
    const rows = [txn(1, 1), txn(3, 3)].map((t, i) => ({ ...t, id: i + 1 }));
    expect(fromVisibleAccounts(rows, [accounts[0], brokerage]).map((t) => t.id)).toEqual([1]);
  });
```

(`txn(id, accountId)` and `accounts` are the block's existing helpers; if the helper's arguments differ, build the two rows inline with `account_id: 1` and `account_id: 3`.)

Run: `npx vitest run src/domain/spending.test.ts` — Expected: FAIL (the brokerage row is kept).

- [ ] **Step 3: Implement the filter**

Replace `fromVisibleAccounts` in `src/domain/spending.ts`:

```ts
/**
 * Transactions that count toward spending: not in a hidden account, and not in
 * an investment account.
 *
 * Hiding an account takes it out of every total, and spending is a total.
 * Investment accounts are left out the way Copilot leaves them out: interest
 * and trades are not spending or income. A transaction whose account is not in
 * the list at all is kept rather than dropped: the account list may still be
 * loading, and quietly losing money off the screen is the worse failure.
 */
export function fromVisibleAccounts(txns: BankTransaction[], accounts: Account[]): BankTransaction[] {
  const excluded = new Set(accounts.filter((a) => a.hidden || a.type === "brokerage").map((a) => a.id));
  return txns.filter((t) => !excluded.has(t.account_id));
}
```

Run the test again — Expected: PASS.

- [ ] **Step 4: Calls and hooks**

In `src/data/api.ts`, inside `bankTransactions: { … }` add:

```ts
    toReview: () => invoke<BankTransaction[]>("bank_transactions_to_review"),
    approve: (ids: number[]) => invoke<number>("bank_transactions_approve", { ids }),
```

In `src/data/queries.ts`, add to `budgetKeys`: `toReview: ["bankTxns", "toReview"] as const,` and after `useBankTransactionRange`:

```ts
export const useBankTransactionsToReview = () =>
  useQuery({ queryKey: budgetKeys.toReview, queryFn: api.bankTransactions.toReview });

export function useApproveTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.bankTransactions.approve(ids),
    onSuccess: () => invalidateSpending(qc),
  });
}
```

(`invalidateSpending` refetches every `["bankTxns", …]` query, the review list included.)

- [ ] **Step 5: Verify and commit**

Run: `npx tsc --noEmit` (clean) and `npm test` (all pass).

```bash
git add src/domain src/data
git commit -m "feat(spending): leave investment accounts out; review calls and hooks"
```

---

### Task 8: Review in the transaction list and on the Spending screen

**Files:**
- Modify: `src/features/spending/TransactionList.tsx`, `src/features/spending/Spending.tsx`
- Create: `src/features/spending/TransactionList.test.tsx`

- [ ] **Step 1: Failing tests**

`src/features/spending/TransactionList.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { TransactionList } from "./TransactionList";
import type { Account, BankTransaction, Category } from "../../domain/types";

const category: Category = { id: 1, name: "Shopping", kind: "spending", colour: "chart-2", sort: 70, is_builtin: true };
const account = { id: 1, name: "Card", hidden: false, type: "credit" } as Account;
const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 7, account_id: 1, external_id: "t", posted: "2026-10-01", amount: -9, description: "TARGET",
  payee: "Target", memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: false, ...over,
});

function renderList(props: Partial<Parameters<typeof TransactionList>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TransactionList transactions={[txn()]} categories={[category]} accounts={[account]}
        colourOf={() => "#000"} {...props} />
    </QueryClientProvider>,
  );
}

describe("TransactionList review", () => {
  it("marks a row that has not been reviewed", () => {
    renderList();
    expect(screen.getByTitle("To review")).toBeInTheDocument();
  });

  it("shows no mark once reviewed", () => {
    renderList({ transactions: [txn({ reviewed: true })] });
    expect(screen.queryByTitle("To review")).toBeNull();
  });

  it("approves a row from its tick button", () => {
    const onApprove = vi.fn();
    renderList({ onApprove });
    fireEvent.click(screen.getByRole("button", { name: "Approve Target" }));
    expect(onApprove).toHaveBeenCalledWith(7);
  });

  it("has no tick buttons when approving is not offered", () => {
    renderList();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});
```

Run: `npx vitest run src/features/spending/TransactionList.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Implement in `TransactionList.tsx`**

Add an optional prop to the signature and type:

```tsx
export function TransactionList({ transactions, categories, accounts, colourOf, onApprove }: {
  transactions: BankTransaction[];
  categories: Category[];
  accounts: Account[];
  colourOf: (token: string) => string;
  /** Offered on the To review list: accept a row as it is. */
  onApprove?: (id: number) => void;
}) {
```

After the `{t.category_source === "manual" && (…)}` marker inside the category cell, add:

```tsx
                    {!t.reviewed && (
                      <span title="To review" aria-label="To review" style={{
                        width: 6, height: 6, borderRadius: 3, background: "var(--accent)", flexShrink: 0,
                      }} />
                    )}
```

Add a header cell `{onApprove && <th />}` after the Amount header, and after the amount `<td>` in each row:

```tsx
                {onApprove && (
                  <td>
                    <button className="btn btn-ghost btn-sm" aria-label={`Approve ${t.payee ?? t.description}`}
                      title="Looks right" onClick={() => onApprove(t.id)}>✓</button>
                  </td>
                )}
```

Run the test — Expected: **4 passed**.

- [ ] **Step 3: The Month / To review switch in `Spending.tsx`**

Imports: add `useBankTransactionsToReview, useApproveTransactions` to the queries import, and `Segmented` to the components import.

State and data, after the existing hooks:

```tsx
  const [view, setView] = useState<"month" | "review">("month");
  const { data: allToReview = [] } = useBankTransactionsToReview();
  const toReview = fromVisibleAccounts(allToReview, allAccounts);
  const approve = useApproveTransactions();
```

Wrap the month stepper row so the switch sits at its start:

```tsx
      <div className="row center between" style={{ gap: 16 }}>
        <Segmented<"month" | "review"> value={view} onChange={setView} items={[
          { value: "month", label: "Month" },
          { value: "review", label: `To review (${toReview.length})` },
        ]} />
        {view === "month" && (
          <div className="row center" style={{ gap: 8 }}>
            {/* the existing ‹ month › Today controls, unchanged */}
          </div>
        )}
        {view === "month" && focus != null && (
          <Button variant="secondary" size="sm" onClick={() => setFocus(null)}>Showing one category · clear</Button>
        )}
      </div>
```

Then, directly after that row, the review view replaces the rest of the page:

```tsx
      {view === "review" ? (
        <Card
          title="To review"
          subtitle="Check the category on each new transaction. Changing one counts as reviewing it."
          actions={toReview.length > 0 && (
            <Button size="sm" loading={approve.isPending}
              onClick={() => approve.mutate(toReview.map((t) => t.id))}>
              Mark all reviewed
            </Button>
          )}
        >
          {toReview.length === 0 ? (
            <EmptyState title="All caught up" body="New transactions land here after each sync." />
          ) : (
            <TransactionList transactions={toReview} categories={categories} accounts={accounts}
              colourOf={colourOf} onApprove={(id) => approve.mutate([id])} />
          )}
        </Card>
      ) : (
        <>
          {/* the existing stat grid, Categories card, Transactions card and transfer note, unchanged */}
        </>
      )}
```

- [ ] **Step 4: Verify and commit**

Run: `npx tsc --noEmit` (clean) and `npm test` (all pass).

```bash
git add src/features/spending
git commit -m "feat(spending): To review list with approve and mark all reviewed"
```

---

### Task 9: Check in the running app, then record it

- [ ] **Step 1: Run it** — double-click **Ledgerly (test)**. The v6 migration runs at launch (a `pre-migration` backup is taken first; it appears in Settings → Backups).
- [ ] **Step 2: Check, with the owner:**
  1. Spending shows **To review (n)**, where n is roughly the transactions still uncategorised.
  2. Target, Costco, Chick-fil-A and the other top payees carry categories.
  3. Card autopays and Robinhood moves show as Transfer and drop out of Spent/Income.
  4. "Transfer to Apple Pay" / Venmo are uncategorised and in To review.
  5. ✓ removes a row from the list; changing a category does too; Mark all reviewed empties it.
  6. Robinhood interest and crypto rows are gone from Spending once those accounts are set to Brokerage.
- [ ] **Step 3: Record** — in `docs/HANDOFF.md`, under "What's built", extend the Spending bullet with the review list, merchant recognition and transfer pairing (with the spec path); under "Gotchas" note that a new merchant goes in `budget/merchants.rs` and that categorising now happens in `decide()` with the order person-to-person → transfer → MCC → merchant → income. In `docs/TODO.md`, tick item 9 ("Bank-supplied categories") as replaced by this design.
- [ ] **Step 4: Commit, merge, push**

```bash
git add docs
git commit -m "docs: record Copilot-style categories and review"
git checkout master
git merge --ff-only feature/copilot-categories
git push origin master
git branch -d feature/copilot-categories
```
