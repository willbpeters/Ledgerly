//! Reading and writing budgeting data. The decisions live in `categorize`;
//! this module only persists them.
use super::categorize::{self, Candidate, Decision, Rule};
use super::{merchants, seed, transfers};
use rusqlite::{params, Connection, OptionalExtension};

/// A transaction as it arrives from a provider, before it has a category.
#[derive(Debug, Clone, PartialEq)]
pub struct IncomingTxn {
    pub external_id: String,
    pub posted: String,
    pub amount: f64,
    pub description: String,
    pub payee: Option<String>,
    pub memo: Option<String>,
    pub mcc: Option<String>,
    pub pending: bool,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct UpsertCounts {
    pub added: usize,
    pub updated: usize,
}

pub fn load_rules(conn: &Connection) -> rusqlite::Result<Vec<Rule>> {
    let mut stmt = conn.prepare(
        "SELECT match_type, pattern, category_id FROM category_rules ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Rule { match_type: r.get(0)?, pattern: r.get(1)?, category_id: r.get(2)? })
    })?;
    rows.collect()
}

/// Resolve a decision to a category id, creating nothing.
fn resolve(conn: &Connection, decision: Decision) -> rusqlite::Result<Option<i64>> {
    Ok(match decision {
        Decision::Rule(id) => Some(id),
        Decision::Builtin(name) => seed::category_id(conn, name)?,
        Decision::Income => seed::category_id(conn, "Income")?,
        Decision::None => None,
    })
}

/// Insert or refresh one account's transactions.
///
/// A row the user has categorised by hand keeps its category: a later sync may
/// correct the amount or the description, but never overrules the person.
pub fn upsert_transactions(
    conn: &Connection,
    account_id: i64,
    txns: &[IncomingTxn],
    rules: &[Rule],
) -> rusqlite::Result<UpsertCounts> {
    let mut counts = UpsertCounts::default();
    // Money in on a card is a refund or a payment, not income, so the decision
    // needs to know what kind of account this is.
    let account_type: String = conn.query_row(
        "SELECT type FROM accounts WHERE id=?1", [account_id], |r| r.get(0),
    )?;
    for t in txns {
        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, category_source FROM bank_transactions WHERE account_id=?1 AND external_id=?2",
                params![account_id, t.external_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        match existing {
            Some((id, source)) => {
                if source == "manual" {
                    conn.execute(
                        "UPDATE bank_transactions SET posted=?1, amount=?2, description=?3,
                           payee=?4, memo=?5, mcc=?6, pending=?7 WHERE id=?8",
                        params![t.posted, t.amount, t.description, t.payee, t.memo, t.mcc, t.pending as i64, id],
                    )?;
                } else {
                    let category = resolve(conn, categorize::decide(&candidate(t, &account_type), rules))?;
                    conn.execute(
                        "UPDATE bank_transactions SET posted=?1, amount=?2, description=?3,
                           payee=?4, memo=?5, mcc=?6, pending=?7, category_id=?8 WHERE id=?9",
                        params![t.posted, t.amount, t.description, t.payee, t.memo, t.mcc, t.pending as i64, category, id],
                    )?;
                }
                counts.updated += 1;
            }
            None => {
                let category = resolve(conn, categorize::decide(&candidate(t, &account_type), rules))?;
                conn.execute(
                    "INSERT INTO bank_transactions
                       (account_id, external_id, posted, amount, description, payee, memo, mcc, pending, category_id, category_source)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'auto')",
                    params![account_id, t.external_id, t.posted, t.amount, t.description,
                            t.payee, t.memo, t.mcc, t.pending as i64, category],
                )?;
                counts.added += 1;
            }
        }
    }
    Ok(counts)
}

fn candidate(t: &IncomingTxn, account_type: &str) -> Candidate {
    Candidate {
        payee: t.payee.clone(),
        description: t.description.clone(),
        mcc: t.mcc.clone(),
        amount: t.amount,
        account_type: account_type.to_string(),
    }
}

/// The newest posting date we hold for an account.
#[allow(dead_code)] // per-account view; the sync uses the global maximum
pub fn newest_posted(conn: &Connection, account_id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT MAX(posted) FROM bank_transactions WHERE account_id=?1",
        [account_id],
        |r| r.get::<_, Option<String>>(0),
    )
}

/// Set a category by hand. Optionally remember the choice as a payee rule and
/// apply it to every other automatically-categorised row from the same payee.
pub fn set_category(
    conn: &Connection,
    txn_id: i64,
    category_id: Option<i64>,
    apply_to_payee: bool,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE bank_transactions SET category_id=?1, category_source='manual', reviewed=1 WHERE id=?2",
        params![category_id, txn_id],
    )?;
    if !apply_to_payee {
        return Ok(1);
    }
    let payee: Option<String> = conn.query_row(
        "SELECT payee FROM bank_transactions WHERE id=?1", [txn_id], |r| r.get(0),
    )?;
    let (Some(payee), Some(category_id)) = (payee.filter(|p| !p.trim().is_empty()), category_id) else {
        return Ok(1);
    };
    conn.execute(
        "INSERT INTO category_rules (match_type, pattern, category_id, created_at)
         VALUES ('payee', ?1, ?2, ?3)
         ON CONFLICT(match_type, pattern) DO UPDATE SET category_id=excluded.category_id",
        params![payee.to_lowercase(), category_id, chrono::Utc::now().to_rfc3339()],
    )?;
    let changed = conn.execute(
        "UPDATE bank_transactions SET category_id=?1
         WHERE category_source='auto' AND payee IS NOT NULL AND lower(payee)=?2",
        params![category_id, payee.to_lowercase()],
    )?;
    Ok(changed + 1)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn account(conn: &Connection, name: &str, type_: &str) -> i64 {
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at,source) VALUES (?1,?2,'USD','2026-01-01','simplefin')",
            params![name, type_],
        ).unwrap();
        conn.last_insert_rowid()
    }
    fn txn(id: &str, amount: f64, payee: &str, mcc: Option<&str>) -> IncomingTxn {
        IncomingTxn {
            external_id: id.into(), posted: "2026-09-01".into(), amount,
            description: format!("{payee} purchase"), payee: Some(payee.into()),
            memo: None, mcc: mcc.map(str::to_string), pending: false,
        }
    }
    fn category_of(conn: &Connection, external_id: &str) -> Option<String> {
        conn.query_row(
            "SELECT c.name FROM bank_transactions t LEFT JOIN categories c ON c.id=t.category_id
             WHERE t.external_id=?1",
            [external_id], |r| r.get::<_, Option<String>>(0),
        ).unwrap()
    }

    #[test]
    fn inserts_and_categorises_from_the_merchant_code() {
        let conn = db::open_in_memory().unwrap();
        let a = account(&conn, "Card", "credit");
        let counts = upsert_transactions(&conn, a, &[
            txn("t1", -85.5, "Local Grocer", Some("5411")),
            txn("t2", -55.5, "John's Fishin Shack", Some("5812")),
        ], &[]).unwrap();
        assert_eq!(counts, UpsertCounts { added: 2, updated: 0 });
        // Pay arrives in a checking account. Money in on a card is a refund
        // or a payment, never income, so this row lives on a cash account.
        let checking = account(&conn, "Checking", "cash");
        upsert_transactions(&conn, checking, &[txn("t3", 2400.0, "ACME Payroll", None)], &[]).unwrap();
        assert_eq!(category_of(&conn, "t1").as_deref(), Some("Groceries"));
        assert_eq!(category_of(&conn, "t2").as_deref(), Some("Dining"));
        assert_eq!(category_of(&conn, "t3").as_deref(), Some("Income"));
    }

    #[test]
    fn a_second_sync_updates_rather_than_duplicating() {
        let conn = db::open_in_memory().unwrap();
        let a = account(&conn, "Card", "credit");
        upsert_transactions(&conn, a, &[txn("t1", -10.0, "Shop", Some("5411"))], &[]).unwrap();
        let mut changed = txn("t1", -12.5, "Shop", Some("5411"));
        changed.pending = false;
        let counts = upsert_transactions(&conn, a, &[changed], &[]).unwrap();
        assert_eq!(counts, UpsertCounts { added: 0, updated: 1 });
        let n: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let amount: f64 = conn.query_row("SELECT amount FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(amount, -12.5);
    }

    #[test]
    fn a_manual_category_survives_a_later_sync() {
        let conn = db::open_in_memory().unwrap();
        let a = account(&conn, "Card", "credit");
        upsert_transactions(&conn, a, &[txn("t1", -20.0, "Shop", Some("5411"))], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        let travel = seed::category_id(&conn, "Travel").unwrap();
        set_category(&conn, id, travel, false).unwrap();

        upsert_transactions(&conn, a, &[txn("t1", -21.0, "Shop", Some("5411"))], &[]).unwrap();
        assert_eq!(category_of(&conn, "t1").as_deref(), Some("Travel"));
        let amount: f64 = conn.query_row("SELECT amount FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(amount, -21.0, "the amount should still refresh");
    }

    #[test]
    fn applying_to_a_payee_writes_a_rule_and_fixes_the_others() {
        let conn = db::open_in_memory().unwrap();
        let a = account(&conn, "Card", "credit");
        upsert_transactions(&conn, a, &[
            txn("t1", -55.5, "John's Fishin Shack", Some("5812")),
            txn("t2", -60.0, "John's Fishin Shack", Some("5812")),
            txn("t3", -20.0, "Someone Else", Some("5812")),
        ], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='t1'", [], |r| r.get(0)).unwrap();
        let shopping = seed::category_id(&conn, "Shopping").unwrap();

        set_category(&conn, id, shopping, true).unwrap();

        assert_eq!(category_of(&conn, "t1").as_deref(), Some("Shopping"));
        assert_eq!(category_of(&conn, "t2").as_deref(), Some("Shopping"), "same payee follows");
        assert_eq!(category_of(&conn, "t3").as_deref(), Some("Dining"), "other payees untouched");

        let rules = load_rules(&conn).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].match_type, "payee");
        assert_eq!(rules[0].pattern, "john's fishin shack");
    }

    #[test]
    fn a_stored_rule_is_used_on_the_next_sync() {
        let conn = db::open_in_memory().unwrap();
        let a = account(&conn, "Card", "credit");
        let shopping = seed::category_id(&conn, "Shopping").unwrap().unwrap();
        conn.execute(
            "INSERT INTO category_rules (match_type,pattern,category_id,created_at)
             VALUES ('payee','fishin shack',?1,'2026-01-01')", [shopping],
        ).unwrap();
        let rules = load_rules(&conn).unwrap();
        upsert_transactions(&conn, a, &[txn("t9", -55.5, "John's Fishin Shack", Some("5812"))], &rules).unwrap();
        assert_eq!(category_of(&conn, "t9").as_deref(), Some("Shopping"));
    }

    #[test]
    fn newest_posted_drives_incremental_syncing() {
        let conn = db::open_in_memory().unwrap();
        let a = account(&conn, "Card", "credit");
        assert_eq!(newest_posted(&conn, a).unwrap(), None);
        let mut older = txn("t1", -1.0, "A", None);
        older.posted = "2026-08-01".into();
        let mut newer = txn("t2", -1.0, "B", None);
        newer.posted = "2026-09-05".into();
        upsert_transactions(&conn, a, &[older, newer], &[]).unwrap();
        assert_eq!(newest_posted(&conn, a).unwrap().as_deref(), Some("2026-09-05"));
    }

    #[test]
    fn clearing_a_category_is_allowed() {
        let conn = db::open_in_memory().unwrap();
        let a = account(&conn, "Card", "credit");
        upsert_transactions(&conn, a, &[txn("t1", -20.0, "Shop", Some("5411"))], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        set_category(&conn, id, None, false).unwrap();
        assert_eq!(category_of(&conn, "t1"), None);
    }

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
}
