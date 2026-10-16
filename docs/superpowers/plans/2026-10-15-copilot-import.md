# Import from Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One import carries the owner's Copilot categories onto matching transactions, adds the history Ledgerly never saw, and learns their merchant habits, so Copilot can be retired.

**Architecture:** A pure planner, `budget/copilot.rs`, turns CSV text plus a snapshot of the database into a `Plan` (matches, additions, skips, new categories, rules). The UI previews that plan; `store::apply_copilot_plan` writes it in one transaction after a backup. Schema v7 adds a `note` column and clears 1970-dated pending rows; the SimpleFIN parser dates pending rows from `transacted_at`; a sync adopts an imported Copilot row instead of duplicating it.

**Tech Stack:** Rust (rusqlite, chrono, serde), React 19 + TanStack Query, `@tauri-apps/plugin-dialog`. Spec: `docs/superpowers/specs/2026-10-15-copilot-import-design.md`.

---

## Before you start

- Baselines: `cd src-tauri; cargo test` → **255 passed, 9 ignored**; `npm test` → **283 passed**; `npx tsc --noEmit` clean.
- Branch: `git checkout -b feature/copilot-import`.
- `git checkout -- src-tauri/Cargo.toml` if it shows modified with no real diff (the Tauri tooling rewrites its line endings).

## Deviation from the spec, decided while planning

**The 1970 pending rows are removed, not re-dated.** Ledgerly never stored
`transacted_at`, so the six rows cannot be repaired in place. They are pending
copies; v7 deletes pending rows dated before 2000, and the next sync re-adds
them with the right date (the parser fix below). A pre-migration backup is
taken first, as for every migration.

## File map

| File | Status | Job |
|---|---|---|
| `src-tauri/src/simplefin/parse.rs` | modify | date a pending row from `transacted_at` |
| `src-tauri/src/db.rs` | modify | v7: `note` column, drop 1970 pending rows |
| `src-tauri/src/models.rs`, `src-tauri/src/commands/budget.rs` | modify | `note` on `BankTransaction` |
| `src-tauri/src/budget/copilot.rs` | create | pure: parse, map, plan |
| `src-tauri/src/budget/store.rs` | modify | apply a plan; sync adopts a Copilot row |
| `src-tauri/src/commands/copilot.rs` | create | `copilot_preview`, `copilot_import` |
| `src-tauri/src/budget/mod.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` | modify | register |
| `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts` | modify | types, calls, hooks |
| `src/features/settings/CopilotImportPanel.tsx` (+ test), `CopilotImportCard.tsx` | create | the card |
| `src/features/settings/Settings.tsx`, `src/features/spending/TransactionList.tsx` | modify | show the card; show notes |

---

### Task 1: Pending rows dated from `transacted_at`

**Files:** Modify `src-tauri/src/simplefin/parse.rs`

- [ ] **Step 1: Failing test** (in its `tests` module)

```rust
    #[test]
    fn a_pending_transaction_with_no_posted_date_uses_when_it_happened() {
        // SimpleFIN sends posted = 0 while a transaction is pending; reading
        // that as an epoch filed six of the owner's rows under 1970-01-01.
        let body = r#"{"errors":[],"accounts":[{"id":"a","name":"Card","currency":"USD",
          "balance":"0","balance-date":1783768170,"org":{"name":"Bank"},"transactions":[
            {"id":"p","posted":0,"transacted_at":1783768170,"amount":"-4.00","description":"Coffee","pending":true}
          ]}]}"#;
        let set = parse_accounts_json(body).unwrap();
        assert_eq!(set.accounts[0].transactions[0].posted, "2026-07-11");
    }
```

Run: `cd src-tauri; cargo test simplefin::parse` — Expected: FAIL (`1970-01-01`).

- [ ] **Step 2: Implement** — in `parse_transaction`, replace the `posted:` line with:

```rust
        posted: posted_date(t),
```

and add above `parse_transaction`:

```rust
/// The posting date, or — while a transaction is still pending and SimpleFIN
/// sends `posted: 0` — the date it happened. An epoch of 0 is not a date.
fn posted_date(t: &Value) -> String {
    let real = |k: &str| t.get(k).filter(|v| v.as_i64().map_or(true, |n| n > 0) && !v.is_null());
    real("posted").or_else(|| real("transacted_at")).map(epoch_to_date).unwrap_or_else(today)
}
```

Run again — Expected: PASS, all `simplefin::parse` tests pass.

- [ ] **Step 3: Commit** — `git commit -am "fix(simplefin): date a pending transaction from when it happened, not 1970"`

---

### Task 2: Schema v7 and `note`

**Files:** Modify `src-tauri/src/db.rs`, `src-tauri/src/models.rs`, `src-tauri/src/commands/budget.rs`

- [ ] **Step 1: Failing tests** (in `db.rs` tests)

```rust
    #[test]
    fn v7_adds_notes_and_drops_pending_rows_dated_1970() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE bank_transactions DROP COLUMN note;
             INSERT INTO accounts (id,name,type,created_at) VALUES (91,'Card','credit','2026-10-01');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,pending)
               VALUES (91,'stale','1970-01-01',-4,'Coffee',1), (91,'real','2026-10-01',-4,'Coffee',0);",
        ).unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();

        assert!(column_exists(&conn, "bank_transactions", "note").unwrap());
        let left: Vec<String> = conn.prepare("SELECT external_id FROM bank_transactions WHERE account_id=91")
            .unwrap().query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(left, vec!["real".to_string()]);
    }
```

Run: `cargo test db::tests::v7` — Expected: FAIL (no column `note`).

- [ ] **Step 2: Implement** in `db.rs`: `const TARGET_VERSION: i64 = 7;` (add "v7 adds notes to bank transactions" to its comment), then beside the v6 helpers:

```rust
/// v7: a note on each bank transaction (Copilot's notes arrive with the import).
const V7_COLUMN: (&str, &str) = ("note", "note TEXT");

fn v7_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    column_exists(conn, "bank_transactions", V7_COLUMN.0)
}

/// Also drops pending rows dated 1970: SimpleFIN sent `posted: 0` for them and
/// an older parser read it as an epoch. They are pending copies — the next sync
/// brings them back with the date they happened.
fn apply_v7(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    add_column_if_missing(&tx, "bank_transactions", V7_COLUMN.0, V7_COLUMN.1)?;
    tx.execute("DELETE FROM bank_transactions WHERE pending = 1 AND posted < '2000-01-01'", [])?;
    tx.commit()
}
```

In `apply_migrations` after the v6 block: `if !v7_is_complete(conn)? { apply_v7(conn)?; }`. In `migration_pending` add `|| !v7_is_complete(conn)?`.

- [ ] **Step 3: `note` on `BankTransaction`** — `models.rs`, after `reviewed`:

```rust
    /// The owner's note; Copilot's notes arrive with the import.
    pub note: Option<String>,
```

`commands/budget.rs`: append `,note` to `TXN_COLUMNS` and `note: r.get(13)?,` to `txn_from_row`.

- [ ] **Step 4:** `cargo test` — Expected: **257 passed**. Commit: `feat(db): v7 adds notes and clears 1970-dated pending rows`.

---

### Task 3: The pure planner

**Files:** Create `src-tauri/src/budget/copilot.rs`; add `pub mod copilot;` to `budget/mod.rs`.

- [ ] **Step 1: Failing tests** — the `tests` module at the end of `copilot.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "\"date\",\"name\",\"amount\",\"status\",\"category\",\"parent category\",\"excluded\",\"tags\",\"type\",\"account\",\"account mask\",\"note\",\"recurring\"";

    fn csv(rows: &[&str]) -> String {
        format!("\u{FEFF}{HEADER}\n{}\n", rows.join("\n"))
    }

    fn row(date: &str, name: &str, amount: &str, category: &str, kind: &str, mask: &str) -> String {
        format!("\"{date}\",\"{name}\",\"{amount}\",\"posted\",\"{category}\",\"\",\"false\",\"\",\"{kind}\",\"Acct\",\"{mask}\",\"\",\"\"")
    }

    fn snap() -> Snapshot {
        Snapshot {
            accounts: vec![AccountRef { id: 1, name: "Card (9849)".into() }],
            txns: vec![
                ExistingTxn { id: 10, account_id: 1, posted: "2026-07-01".into(), amount: -12.5, from_copilot: false },
                ExistingTxn { id: 11, account_id: 1, posted: "2026-07-05".into(), amount: -12.5, from_copilot: false },
            ],
            category_names: vec!["Dining".into(), "Shopping".into(), "Groceries".into(), "Transfer".into(), "Income".into(), "Other".into()],
            rule_patterns: vec![],
        }
    }

    #[test]
    fn a_file_that_is_not_a_copilot_export_is_refused() {
        assert!(parse_csv("date,description,amount\n2026-01-01,x,1\n").unwrap_err().contains("Copilot"));
    }

    #[test]
    fn quoted_fields_and_doubled_quotes_parse() {
        let rows = parse_csv(&csv(&[&row("2026-07-02", "Joe \"\"The\"\" Diner, Inc", "12.50", "Eating Out", "regular", "9849")])).unwrap();
        assert_eq!(rows[0].name, "Joe \"The\" Diner, Inc");
    }

    #[test]
    fn copilots_sign_is_flipped() {
        let rows = parse_csv(&csv(&[&row("2026-07-02", "Cafe", "12.50", "", "regular", ""),
                                    &row("2026-07-02", "Pay", "-100", "", "income", "")])).unwrap();
        assert_eq!((rows[0].amount, rows[1].amount), (-12.5, 100.0));
    }

    #[test]
    fn categories_map_onto_ledgerlys_or_are_created() {
        let r = |cat: &str, kind: &str| CopilotRow { category: cat.into(), kind: kind.into(), ..CopilotRow::default() };
        assert_eq!(category_for(&r("Eating Out", "regular")).as_deref(), Some("Dining"));
        assert_eq!(category_for(&r("Shops", "regular")).as_deref(), Some("Shopping"));
        assert_eq!(category_for(&r("Gifts ", "regular")).as_deref(), Some("Gifts"));
        assert_eq!(category_for(&r("Golf", "internal transfer")).as_deref(), Some("Transfer"));
        assert_eq!(category_for(&r("", "income")).as_deref(), Some("Income"));
        assert_eq!(category_for(&r("", "regular")), None);
    }

    #[test]
    fn a_row_inside_the_span_matches_closest_date_first_and_only_once() {
        let rows = parse_csv(&csv(&[
            &row("2026-07-04", "Diner", "12.50", "Eating Out", "regular", "9849"),
            &row("2026-07-02", "Diner", "12.50", "Eating Out", "regular", "9849"),
        ])).unwrap();
        let p = plan(&rows, &snap());
        let ids: Vec<i64> = p.matches.iter().map(|m| m.txn_id).collect();
        assert_eq!(ids, vec![11, 10]);
        assert_eq!(p.matches[0].category.as_deref(), Some("Dining"));
        assert!(p.additions.is_empty());
    }

    #[test]
    fn an_unmatched_row_inside_the_span_is_skipped_not_added() {
        let rows = parse_csv(&csv(&[&row("2026-07-10", "Mystery", "9.99", "Other", "regular", "9849")])).unwrap();
        let p = plan(&rows, &snap());
        assert!(p.additions.is_empty());
        assert_eq!(p.skipped.len(), 1);
    }

    #[test]
    fn a_row_before_the_span_is_added_to_its_account() {
        let rows = parse_csv(&csv(&[&row("2026-01-10", "Old Diner", "8.00", "Eating Out", "regular", "9849")])).unwrap();
        let p = plan(&rows, &snap());
        assert_eq!(p.additions.len(), 1);
        assert_eq!(p.additions[0].account, Target::Account(1));
        assert_eq!(p.additions[0].amount, -8.0);
        assert!(p.additions[0].external_id.starts_with("copilot:"));
    }

    #[test]
    fn a_row_with_no_known_account_goes_to_copilot_history() {
        let rows = parse_csv(&csv(&[&row("2026-07-02", "Cash", "5.00", "Other", "regular", "")])).unwrap();
        assert_eq!(plan(&rows, &snap()).additions[0].account, Target::History);
    }

    #[test]
    fn pending_and_excluded_rows_are_skipped() {
        let pending = row("2026-01-02", "P", "1", "", "regular", "").replace("\"posted\"", "\"pending\"");
        let excluded = row("2026-01-02", "E", "1", "", "regular", "").replace("\"false\"", "\"true\"");
        let p = plan(&parse_csv(&csv(&[&pending, &excluded])).unwrap(), &snap());
        assert_eq!((p.additions.len(), p.pending_or_excluded), (0, 2));
    }

    #[test]
    fn identical_rows_get_different_stable_ids() {
        let a = row("2026-01-02", "Vending", "1.50", "", "regular", "");
        let rows = parse_csv(&csv(&[&a, &a])).unwrap();
        let first = plan(&rows, &snap());
        let again = plan(&rows, &snap());
        assert_ne!(first.additions[0].external_id, first.additions[1].external_id);
        assert_eq!(first.additions[0].external_id, again.additions[0].external_id);
    }

    #[test]
    fn missing_categories_are_listed_with_investments_as_a_transfer() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Range", "20", "Golf", "regular", ""),
            &row("2026-01-03", "Robinhood", "100", "Investments", "regular", ""),
        ])).unwrap();
        let p = plan(&rows, &snap());
        assert_eq!(p.new_categories, vec![
            NewCategory { name: "Golf".into(), kind: "spending".into() },
            NewCategory { name: "Investments".into(), kind: "transfer".into() },
        ]);
    }

    #[test]
    fn a_payee_used_consistently_becomes_a_rule() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Haggin Oaks", "20", "Golf", "regular", ""),
            &row("2026-01-09", "Haggin Oaks", "25", "Golf", "regular", ""),
            &row("2026-01-03", "Once Only", "5", "Golf", "regular", ""),
            &row("2026-01-04", "Mixed", "5", "Golf", "regular", ""),
            &row("2026-01-05", "Mixed", "5", "Other", "regular", ""),
        ])).unwrap();
        let p = plan(&rows, &snap());
        assert_eq!(p.rules, vec![LearnedRule { pattern: "haggin oaks".into(), category: "Golf".into() }]);
    }

    #[test]
    fn an_existing_rule_is_never_replaced() {
        let rows = parse_csv(&csv(&[
            &row("2026-01-02", "Haggin Oaks", "20", "Golf", "regular", ""),
            &row("2026-01-09", "Haggin Oaks", "25", "Golf", "regular", ""),
        ])).unwrap();
        let mut s = snap();
        s.rule_patterns = vec!["haggin oaks".into()];
        assert!(plan(&rows, &s).rules.is_empty());
    }
}
```

Run: `cargo test budget::copilot` — Expected: compile errors.

- [ ] **Step 2: Implement** (top of `copilot.rs`)

```rust
//! Importing a Copilot Money CSV export. Pure: the caller hands over the CSV
//! text and a snapshot of the database, and gets back a `Plan` it can preview
//! and then apply. See docs/superpowers/specs/2026-10-15-copilot-import-design.md
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

const HEADER: [&str; 13] = [
    "date", "name", "amount", "status", "category", "parent category", "excluded",
    "tags", "type", "account", "account mask", "note", "recurring",
];

/// How far apart Copilot's date and SimpleFIN's may be for the same purchase.
const MATCH_DAYS: i64 = 3;
/// The account that collects rows whose Copilot account no longer exists.
pub const HISTORY_ACCOUNT: &str = "Copilot history";

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CopilotRow {
    pub date: String,
    pub name: String,
    /// Ledgerly's sign: negative is money out (Copilot's is the opposite).
    pub amount: f64,
    pub pending: bool,
    pub category: String,
    pub excluded: bool,
    /// "regular", "income" or "internal transfer".
    pub kind: String,
    pub account: String,
    pub mask: String,
    pub note: Option<String>,
}

pub struct AccountRef { pub id: i64, pub name: String }
pub struct ExistingTxn { pub id: i64, pub account_id: i64, pub posted: String, pub amount: f64, pub from_copilot: bool }
pub struct Snapshot {
    pub accounts: Vec<AccountRef>,
    pub txns: Vec<ExistingTxn>,
    pub category_names: Vec<String>,
    /// Lower-cased payee patterns of rules that already exist.
    pub rule_patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Target { Account(i64), History }

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Match { pub txn_id: i64, pub category: Option<String>, pub note: Option<String> }
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Addition {
    pub external_id: String, pub account: Target, pub posted: String, pub amount: f64,
    pub name: String, pub category: Option<String>, pub note: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Skipped { pub date: String, pub name: String, pub amount: f64, pub account: String }
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewCategory { pub name: String, pub kind: String }
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LearnedRule { pub pattern: String, pub category: String }

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Plan {
    pub matches: Vec<Match>,
    pub additions: Vec<Addition>,
    /// Inside a SimpleFIN span with no same-amount match: listed, not added.
    pub skipped: Vec<Skipped>,
    pub pending_or_excluded: usize,
    pub new_categories: Vec<NewCategory>,
    pub rules: Vec<LearnedRule>,
    /// Copilot account label → the Ledgerly account it maps to.
    pub accounts: Vec<(String, String)>,
}

/// Split CSV text into records: quoted fields, doubled quotes, commas and
/// line breaks inside quotes.
fn records(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let (mut row, mut cell, mut quoted) = (Vec::new(), String::new(), false);
    let mut chars = text.trim_start_matches('\u{FEFF}').chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => { chars.next(); cell.push('"'); }
            (true, '"') => quoted = false,
            (true, c) => cell.push(c),
            (false, '"') => quoted = true,
            (false, ',') => row.push(std::mem::take(&mut cell)),
            (false, '\r') => {}
            (false, '\n') => { row.push(std::mem::take(&mut cell)); rows.push(std::mem::take(&mut row)); }
            (false, c) => cell.push(c),
        }
    }
    if !cell.is_empty() || !row.is_empty() { row.push(cell); rows.push(row); }
    rows
}

pub fn parse_csv(text: &str) -> Result<Vec<CopilotRow>, String> {
    let mut all = records(text).into_iter();
    let header = all.next().unwrap_or_default();
    if header.iter().map(|h| h.trim()).ne(HEADER.iter().copied()) {
        return Err("That file isn't a Copilot export. In Copilot, use Settings → Account → Export your transactions.".into());
    }
    Ok(all
        .filter(|r| r.len() == HEADER.len())
        .map(|r| CopilotRow {
            date: r[0].trim().to_string(),
            name: r[1].trim().to_string(),
            amount: -r[2].trim().parse::<f64>().unwrap_or(0.0),
            pending: r[3].trim() == "pending",
            category: r[4].trim().to_string(),
            excluded: r[6].trim() == "true",
            kind: r[8].trim().to_string(),
            account: r[9].trim().to_string(),
            mask: r[10].trim().to_string(),
            note: Some(r[11].trim().to_string()).filter(|s| !s.is_empty()),
        })
        .collect())
}

/// Copilot names that mean the same as one of Ledgerly's.
const SAME_AS: &[(&str, &str)] = &[
    ("eating out", "Dining"), ("groceries", "Groceries"), ("shops", "Shopping"),
    ("subscriptions", "Subscriptions"), ("entertainment", "Entertainment"),
    ("travel", "Travel"), ("other", "Other"),
];

/// The Ledgerly category name a row belongs in. An internal transfer is always
/// Transfer, whatever its category says.
pub fn category_for(r: &CopilotRow) -> Option<String> {
    if r.kind == "internal transfer" {
        return Some("Transfer".into());
    }
    let name = r.category.trim();
    if !name.is_empty() {
        let lower = name.to_lowercase();
        return Some(SAME_AS.iter().find(|(c, _)| *c == lower).map_or(name.to_string(), |(_, l)| l.to_string()));
    }
    (r.kind == "income").then(|| "Income".to_string())
}

fn day(s: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(|d| d.num_days_from_ce() as i64)
}
use chrono::Datelike;

/// FNV-1a: a stable id without a hashing dependency.
fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

pub fn plan(rows: &[CopilotRow], snap: &Snapshot) -> Plan {
    let mut p = Plan::default();
    let cents = |a: f64| (a * 100.0).round() as i64;

    // Where SimpleFIN's own record of each account starts. Copilot rows from
    // that date on are matched, never added; imported rows do not count.
    let mut span: BTreeMap<i64, String> = BTreeMap::new();
    for t in snap.txns.iter().filter(|t| !t.from_copilot && t.posted.as_str() >= "2000") {
        let e = span.entry(t.account_id).or_insert_with(|| t.posted.clone());
        if t.posted < *e { *e = t.posted.clone(); }
    }

    let account_for = |r: &CopilotRow| -> Target {
        if r.mask.is_empty() { return Target::History; }
        snap.accounts.iter().find(|a| a.name.ends_with(&format!("({})", r.mask)))
            .map_or(Target::History, |a| Target::Account(a.id))
    };

    let mut used: HashSet<i64> = HashSet::new();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut labels: BTreeMap<String, String> = BTreeMap::new();

    for r in rows {
        if r.pending || r.excluded { p.pending_or_excluded += 1; continue; }
        let category = category_for(r);
        let target = account_for(r);
        let label = if r.account.is_empty() { "(no account)".to_string() } else { r.account.clone() };
        labels.entry(label.clone()).or_insert_with(|| match &target {
            Target::Account(id) => snap.accounts.iter().find(|a| a.id == *id).map_or(String::new(), |a| a.name.clone()),
            Target::History => HISTORY_ACCOUNT.to_string(),
        });

        if let Target::Account(id) = target {
            if span.get(&id).is_some_and(|start| r.date >= *start) {
                let Some(d) = day(&r.date) else { continue };
                let best = snap.txns.iter()
                    .filter(|t| t.account_id == id && !t.from_copilot && !used.contains(&t.id) && cents(t.amount) == cents(r.amount))
                    .filter_map(|t| day(&t.posted).map(|td| ((td - d).abs(), t.id)))
                    .filter(|(gap, _)| *gap <= MATCH_DAYS)
                    .min();
                match best {
                    Some((_, txn_id)) => {
                        used.insert(txn_id);
                        p.matches.push(Match { txn_id, category, note: r.note.clone() });
                    }
                    None => p.skipped.push(Skipped { date: r.date.clone(), name: r.name.clone(), amount: r.amount, account: label }),
                }
                continue;
            }
        }

        // Its position among identical rows keeps two same-day vending
        // purchases apart, and gives the same id on every import.
        let key = format!("{}|{}|{}|{}", r.date, r.name, cents(r.amount), r.mask);
        let n = seen.entry(key.clone()).or_insert(0);
        *n += 1;
        p.additions.push(Addition {
            external_id: format!("copilot:{:016x}", fnv(&format!("{key}|{n}"))),
            account: target, posted: r.date.clone(), amount: r.amount,
            name: r.name.clone(), category, note: r.note.clone(),
        });
    }

    // Categories the owner used that Ledgerly does not have yet.
    let have: HashSet<String> = snap.category_names.iter().map(|c| c.to_lowercase()).collect();
    let mut wanted: Vec<String> = p.matches.iter().map(|m| m.category.clone())
        .chain(p.additions.iter().map(|a| a.category.clone())).flatten().collect();
    wanted.sort();
    wanted.dedup();
    p.new_categories = wanted.into_iter().filter(|c| !have.contains(&c.to_lowercase()))
        .map(|name| NewCategory {
            // Money moved into the owner's own investments is not spending.
            kind: if name.eq_ignore_ascii_case("investments") { "transfer" } else { "spending" }.into(),
            name,
        })
        .collect();

    // A payee used at least twice, 90% of the time in one category.
    let mut by_name: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    let cats: Vec<(String, Option<String>)> = rows.iter().filter(|r| !r.pending && !r.excluded)
        .map(|r| (r.name.trim().to_lowercase(), category_for(r))).collect();
    for (name, cat) in &cats {
        if let Some(c) = cat { by_name.entry(name.clone()).or_default().push(c); }
    }
    let existing: HashSet<&str> = snap.rule_patterns.iter().map(String::as_str).collect();
    for (name, used_cats) in by_name {
        if name.is_empty() || used_cats.len() < 2 || existing.contains(name.as_str()) { continue; }
        let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
        for c in &used_cats { *counts.entry(c).or_default() += 1; }
        let (top, n) = counts.into_iter().max_by_key(|(_, n)| *n).unwrap();
        if n * 10 >= used_cats.len() * 9 {
            p.rules.push(LearnedRule { pattern: name, category: top.to_string() });
        }
    }

    p.accounts = labels.into_iter().collect();
    p
}
```

Run: `cargo test budget::copilot` — Expected: **13 passed**. Commit: `feat(budget): plan a Copilot import without touching the database`.

---

### Task 4: Apply a plan; a sync adopts an imported row

**Files:** Modify `src-tauri/src/budget/store.rs`

- [ ] **Step 1: Failing tests** (append to `store.rs` tests)

```rust
    use crate::budget::copilot;

    fn copilot_plan(conn: &Connection, csv: &str) -> copilot::Plan {
        copilot::plan(&copilot::parse_csv(csv).unwrap(), &copilot_snapshot(conn).unwrap())
    }

    const COPILOT_HEADER: &str = "\"date\",\"name\",\"amount\",\"status\",\"category\",\"parent category\",\"excluded\",\"tags\",\"type\",\"account\",\"account mask\",\"note\",\"recurring\"";

    #[test]
    fn applying_a_plan_matches_adds_creates_and_learns() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner")], &[]).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-07-03\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"lunch\",\"\"\n\
            \"2026-01-05\",\"Haggin Oaks\",\"20\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-12\",\"Haggin Oaks\",\"25\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n");
        let plan = copilot_plan(&conn, &csv);

        let counts = apply_copilot_plan(&conn, &plan).unwrap();

        assert_eq!((counts.matched, counts.added), (1, 2));
        assert_eq!(row(&conn, "sf1"), (Some("Dining".into()), "manual".into(), true));
        let note: Option<String> = conn.query_row("SELECT note FROM bank_transactions WHERE external_id='sf1'", [], |r| r.get(0)).unwrap();
        assert_eq!(note.as_deref(), Some("lunch"));
        assert!(seed::category_id(&conn, "Golf").unwrap().is_some());
        let history: i64 = conn.query_row("SELECT count(*) FROM accounts WHERE name='Copilot history'", [], |r| r.get(0)).unwrap();
        assert_eq!(history, 1);
        let rules: i64 = conn.query_row("SELECT count(*) FROM category_rules WHERE pattern='haggin oaks'", [], |r| r.get(0)).unwrap();
        assert_eq!(rules, 1);

        // Running it again changes nothing.
        let again = copilot_plan(&conn, &csv);
        apply_copilot_plan(&conn, &again).unwrap();
        let total: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 3);
    }

    #[test]
    fn an_import_never_overrides_a_category_chosen_in_ledgerly() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        set_category(&conn, id, seed::category_id(&conn, "Groceries").unwrap(), false).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\"2026-07-03\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n");

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        assert_eq!(row(&conn, "sf1").0.as_deref(), Some("Groceries"));
    }

    #[test]
    fn a_sync_adopts_an_imported_row_instead_of_duplicating_it() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf-new", "2026-07-02", -1.0, "Zqx")], &[]).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\"2026-01-05\",\"Old Diner\",\"8\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n");
        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        // "Import 2 years" later brings SimpleFIN's own copy of that purchase.
        upsert_transactions(&conn, card, &[payee_txn("sf-old", "2026-01-06", -8.0, "Old Diner Inc")], &[]).unwrap();

        let rows: i64 = conn.query_row("SELECT count(*) FROM bank_transactions WHERE amount=-8", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        assert_eq!(row(&conn, "sf-old").0.as_deref(), Some("Dining"), "the owner's category survives");
    }
```

Run: `cargo test budget::store` — Expected: compile errors.

- [ ] **Step 2: Implement** in `store.rs` (import `super::copilot`):

```rust
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct CopilotCounts { pub matched: usize, pub added: usize, pub categories: usize, pub rules: usize }

/// What the planner needs to know about the database.
pub fn copilot_snapshot(conn: &Connection) -> rusqlite::Result<copilot::Snapshot> {
    let accounts = conn.prepare("SELECT id, name FROM accounts")?
        .query_map([], |r| Ok(copilot::AccountRef { id: r.get(0)?, name: r.get(1)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let txns = conn.prepare("SELECT id, account_id, posted, amount, external_id FROM bank_transactions")?
        .query_map([], |r| Ok(copilot::ExistingTxn {
            id: r.get(0)?, account_id: r.get(1)?, posted: r.get(2)?, amount: r.get(3)?,
            from_copilot: r.get::<_, String>(4)?.starts_with("copilot:"),
        }))?
        .collect::<rusqlite::Result<_>>()?;
    let category_names = conn.prepare("SELECT name FROM categories")?
        .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let rule_patterns = conn.prepare("SELECT pattern FROM category_rules WHERE match_type='payee'")?
        .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(copilot::Snapshot { accounts, txns, category_names, rule_patterns })
}

fn category_named(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM categories WHERE lower(name)=lower(?1)", [name], |r| r.get(0)).optional()
}

/// Write a plan: all of it or none of it.
pub fn apply_copilot_plan(conn: &Connection, plan: &copilot::Plan) -> rusqlite::Result<CopilotCounts> {
    let tx = conn.unchecked_transaction()?;
    let mut counts = CopilotCounts::default();

    for (i, c) in plan.new_categories.iter().enumerate() {
        let sort: i64 = tx.query_row("SELECT COALESCE(MAX(sort),0)+10 FROM categories", [], |r| r.get(0))?;
        counts.categories += tx.execute(
            "INSERT OR IGNORE INTO categories (name,kind,colour,sort,is_builtin) VALUES (?1,?2,?3,?4,0)",
            params![c.name, c.kind, format!("chart-{}", i % 6 + 1), sort],
        )?;
    }

    let mut history: Option<i64> = None;
    for a in &plan.additions {
        let account_id = match a.account {
            copilot::Target::Account(id) => id,
            copilot::Target::History => match history {
                Some(id) => id,
                None => {
                    let found: Option<i64> = tx.query_row(
                        "SELECT id FROM accounts WHERE name=?1 AND source='manual'", [copilot::HISTORY_ACCOUNT], |r| r.get(0),
                    ).optional()?;
                    let id = match found {
                        Some(id) => id,
                        None => {
                            tx.execute(
                                "INSERT INTO accounts (name,type,currency,created_at,source) VALUES (?1,'cash','USD',?2,'manual')",
                                params![copilot::HISTORY_ACCOUNT, chrono::Utc::now().to_rfc3339()],
                            )?;
                            tx.last_insert_rowid()
                        }
                    };
                    history = Some(id);
                    id
                }
            },
        };
        let category = match &a.category { Some(n) => category_named(&tx, n)?, None => None };
        tx.execute(
            "INSERT INTO bank_transactions
               (account_id,external_id,posted,amount,description,payee,category_id,category_source,reviewed,note)
             VALUES (?1,?2,?3,?4,?5,?5,?6,'manual',1,?7)
             ON CONFLICT(account_id,external_id) DO UPDATE SET
               category_id=excluded.category_id, note=excluded.note",
            params![account_id, a.external_id, a.posted, a.amount, a.name, category, a.note],
        )?;
        counts.added += 1;
    }

    for m in &plan.matches {
        let category = match &m.category { Some(n) => category_named(&tx, n)?, None => None };
        // A category the owner already chose in Ledgerly wins.
        tx.execute(
            "UPDATE bank_transactions SET category_id=?1, category_source='manual', reviewed=1
             WHERE id=?2 AND category_source='auto'",
            params![category, m.txn_id],
        )?;
        tx.execute("UPDATE bank_transactions SET note=COALESCE(note, ?1) WHERE id=?2", params![m.note, m.txn_id])?;
        counts.matched += 1;
    }

    for r in &plan.rules {
        if let Some(id) = category_named(&tx, &r.category)? {
            counts.rules += tx.execute(
                "INSERT OR IGNORE INTO category_rules (match_type,pattern,category_id,created_at) VALUES ('payee',?1,?2,?3)",
                params![r.pattern, id, chrono::Utc::now().to_rfc3339()],
            )?;
        }
    }

    // The learned rules apply at once to every automatic row.
    recategorise_all(&tx)?;
    tx.commit()?;
    Ok(counts)
}
```

And in `upsert_transactions`, in the `None =>` (insert) branch, **before** the `INSERT`, adopt an imported Copilot copy:

```rust
            None => {
                // An older purchase the Copilot import already added: take it
                // over rather than adding a second copy, keeping the owner's
                // category and note.
                let adopted: Option<i64> = conn.query_row(
                    "SELECT id FROM bank_transactions
                     WHERE account_id=?1 AND external_id LIKE 'copilot:%'
                       AND CAST(ROUND(amount*100) AS INTEGER) = CAST(ROUND(?2*100) AS INTEGER)
                       AND ABS(julianday(posted) - julianday(?3)) <= 3
                     ORDER BY ABS(julianday(posted) - julianday(?3)) LIMIT 1",
                    params![account_id, t.amount, t.posted],
                    |r| r.get(0),
                ).optional()?;
                if let Some(id) = adopted {
                    conn.execute(
                        "UPDATE bank_transactions SET external_id=?1, posted=?2, amount=?3, description=?4,
                           payee=?5, memo=?6, mcc=?7, pending=?8 WHERE id=?9",
                        params![t.external_id, t.posted, t.amount, t.description, t.payee, t.memo, t.mcc, t.pending as i64, id],
                    )?;
                    counts.updated += 1;
                    continue;
                }
                // …the existing insert, unchanged…
```

Run: `cargo test` — Expected: **273 passed**. Commit: `feat(budget): apply a Copilot import; a sync adopts imported rows`.

---

### Task 5: Commands

**Files:** Create `src-tauri/src/commands/copilot.rs`; register in `commands/mod.rs` (`pub mod copilot;`) and `lib.rs`.

```rust
//! Import from Copilot: a dry-run preview, then the import itself.
use crate::backup::{self, naming::Kind, snapshot, BackupState};
use crate::budget::{copilot, store};
use crate::db::Db;
use tauri::Manager;

fn plan_from(conn: &rusqlite::Connection, path: &str) -> Result<copilot::Plan, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Couldn't read that file: {e}"))?;
    let rows = copilot::parse_csv(&text)?;
    let snap = store::copilot_snapshot(conn).map_err(|e| e.to_string())?;
    Ok(copilot::plan(&rows, &snap))
}

#[tauri::command]
pub async fn copilot_preview(app: tauri::AppHandle, path: String) -> Result<copilot::Plan, String> {
    super::off_main_thread(move || {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        plan_from(&conn, &path)
    }).await
}

/// Backs up first, then writes the whole import in one transaction.
#[tauri::command]
pub async fn copilot_import(app: tauri::AppHandle, path: String) -> Result<store::CopilotCounts, String> {
    super::off_main_thread(move || {
        let state = app.state::<BackupState>();
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let plan = plan_from(&conn, &path)?;
        let safety = snapshot::attempt(&conn, &state.paths, Kind::Manual, backup::now());
        state.record(&safety);
        if let Some(e) = safety.error {
            return Err(format!("Didn't import, because the backup before it failed: {e}"));
        }
        store::apply_copilot_plan(&conn, &plan).map_err(|e| e.to_string())
    }).await
}
```

`lib.rs` handler list: `commands::copilot::copilot_preview, commands::copilot::copilot_import,`.

Run `cargo test` (273) and commit: `feat(copilot): preview and import commands`.

---

### Task 6: The Settings card

**Files:** `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts`, create `src/features/settings/CopilotImportPanel.tsx` + `.test.tsx`, `CopilotImportCard.tsx`; modify `Settings.tsx`, `TransactionList.tsx`.

- [ ] **Types** (`types.ts`): add `note: string | null;` to `BankTransaction`, and

```ts
export interface CopilotPlan {
  matches: { txn_id: number; category: string | null; note: string | null }[];
  additions: { external_id: string; posted: string; amount: number; name: string; category: string | null }[];
  skipped: { date: string; name: string; amount: number; account: string }[];
  pending_or_excluded: number;
  new_categories: { name: string; kind: string }[];
  rules: { pattern: string; category: string }[];
  accounts: [string, string][];
}
export interface CopilotCounts { matched: number; added: number; categories: number; rules: number }
```

Fix fixtures TypeScript names with `note: null`.

- [ ] **API / hooks**: `api.copilot = { preview: (path) => invoke<CopilotPlan>("copilot_preview", { path }), import: (path) => invoke<CopilotCounts>("copilot_import", { path }) }`; hooks `useCopilotPreview()` (mutation) and `useCopilotImport()` (mutation; on success invalidate `["bankTxns"]`, categories, rules, accounts, `["backup"]`).

- [ ] **Panel test** (`CopilotImportPanel.test.tsx`):

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CopilotImportPanel } from "./CopilotImportPanel";
import type { CopilotPlan } from "../../domain/types";

const plan: CopilotPlan = {
  matches: [{ txn_id: 1, category: "Dining", note: null }],
  additions: [{ external_id: "copilot:a", posted: "2025-01-01", amount: -8, name: "Old Diner", category: "Dining" }],
  skipped: [{ date: "2026-07-10", name: "Mystery", amount: -9.99, account: "Adv SafeBalance Banking" }],
  pending_or_excluded: 2,
  new_categories: [{ name: "Golf", kind: "spending" }],
  rules: [{ pattern: "haggin oaks", category: "Golf" }],
  accounts: [["Adv SafeBalance Banking", "Card (9849)"], ["(no account)", "Copilot history"]],
};
const base = { plan: null, result: null, busy: false, onChoose: vi.fn(), onImport: vi.fn() };

describe("CopilotImportPanel", () => {
  it("only offers to choose a file before a preview", () => {
    render(<CopilotImportPanel {...base} />);
    expect(screen.getByRole("button", { name: /Choose Copilot export/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
  });

  it("previews what will happen", () => {
    render(<CopilotImportPanel {...base} plan={plan} />);
    expect(screen.getByText(/1 matched/)).toBeInTheDocument();
    expect(screen.getByText(/1 added as history/)).toBeInTheDocument();
    expect(screen.getByText(/Golf/)).toBeInTheDocument();
    expect(screen.getByText(/Mystery/)).toBeInTheDocument();
    expect(screen.getByText(/Card \(9849\)/)).toBeInTheDocument();
  });

  it("imports from the preview", () => {
    const onImport = vi.fn();
    render(<CopilotImportPanel {...base} plan={plan} onImport={onImport} />);
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(onImport).toHaveBeenCalled();
  });

  it("reports the result", () => {
    render(<CopilotImportPanel {...base} result={{ matched: 250, added: 1795, categories: 9, rules: 40 }} />);
    expect(screen.getByText(/250 matched/)).toBeInTheDocument();
  });
});
```

- [ ] **Panel** (`CopilotImportPanel.tsx`): a `Card` titled "Import from Copilot" that shows, before a plan, one paragraph explaining the export path (Copilot → Settings → Account → Export your transactions) and a **Choose Copilot export…** button; with a plan, the lines `{matches} matched`, `{additions} added as history`, `{pending_or_excluded} pending or excluded, skipped`, the new categories joined by ", ", `{rules} payee rules learned`, the account mapping as `Copilot name → Ledgerly name` lines, the skipped rows (date, name, amount) in a `<details>`, and an **Import** button (`loading={busy}`); with a result, `"{matched} matched, {added} added, {categories} categories created, {rules} rules learned. A backup was taken first."`.

- [ ] **Card** (`CopilotImportCard.tsx`): `open({ title: "Choose your Copilot export", filters: [{ name: "Copilot export", extensions: ["csv"] }] })`, then `preview.mutate(path)`; Import calls `importer.mutate(path)`; errors go to a toast.

- [ ] **Settings**: render `<CopilotImportCard />` after `<SimplefinCard />`.

- [ ] **Notes in the list**: in `TransactionList.tsx`, under the payee line add `{t.note && <div className="cell-secondary">{t.note}</div>}`.

- [ ] Verify `npx tsc --noEmit`, `npm test` (≥ 287), commit `feat(settings): Import from Copilot`.

---

### Task 7: Import the owner's export, then record

- [ ] Launch with **Ledgerly (test)**; the v7 migration runs (pre-migration backup).
- [ ] Settings → **Import from Copilot** → choose `Downloads\transactions (2).csv` → check the preview against the dry run (~250 matched, ~1,795 added, ~29 skipped) → **Import**.
- [ ] Check Spending: old months (2024–2025) show spending; Golf, Car, Date night exist as categories; To review is smaller.
- [ ] Docs: HANDOFF (feature + gotcha "Copilot rows have `external_id` starting `copilot:`; a sync adopts them"), TODO 9b ticked. Merge, push, delete the branch.

---

## Addendum: Remove and "deleted in Copilot" (spec addendum, 2026-10-15)

### Task 8: `removed` flag (v8) and remove/restore — `db.rs`, `models.rs`, `store.rs`, `commands/budget.rs`, `lib.rs`
- Tests first: v8 adds `removed` (default 0, idempotent, in `migration_pending`); `set_removed(&[id], true)` then a sync of the same row leaves it removed; `set_removed(.., false)` restores; `mark_transfer_pairs` ignores removed rows; `list_to_review` leaves removed rows out.
- Implement: `V8_COLUMN = ("removed", "removed INTEGER NOT NULL DEFAULT 0")`, `apply_v8` via `add_column_if_missing`; `BankTransaction.removed`, `TXN_COLUMNS` gains `removed` (index 14); `store::set_removed(conn, ids, removed) -> usize`; `AND removed=0` in `mark_transfer_pairs` and `list_to_review`; command `bank_transactions_set_removed(ids, removed)`.

### Task 9: the plan finds rows deleted in Copilot — `budget/copilot.rs`, `store.rs`, `commands/copilot.rs`
- `ExistingTxn` gains `label`, `pending`, `removed`; `Plan` gains `not_in_copilot: Vec<NotInCopilot { txn_id, date, name, amount, account }>`.
- Tests first: an unmatched Ledgerly row inside its account's Copilot dates is listed; one in the last three days of that range is not; pending, removed and imported rows are not; an account no Copilot row maps to is not looked at.
- `apply_copilot_plan(conn, plan, remove: &[i64])` sets `removed=1` for ids that are in `plan.not_in_copilot`, inside the same transaction; test that an id not offered is ignored. `copilot_import(path, remove_ids)`.

### Task 10: UI — `types.ts`, `api.ts`, `queries.ts`, `spending.ts`, `TransactionList.tsx`, `Spending.tsx`, `CopilotImportPanel.tsx`, `CopilotImportCard.tsx`
- Tests first: `fromVisibleAccounts` leaves removed rows out; `TransactionList` shows Remove when `onRemove` is given and Restore when `onRestore` is; the import panel lists `not_in_copilot` rows checked by default, unticking one drops it from what `onImport` receives.
- Spending: Remove asks with `askToConfirm`; "Show removed (n)" lists the month's removed rows with Restore.
