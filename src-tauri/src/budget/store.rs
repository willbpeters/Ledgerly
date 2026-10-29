//! Reading and writing budgeting data. The decisions live in `categorize`;
//! this module only persists them.
use super::categorize::{self, Candidate, Decision, Rule};
use super::{copilot, merchants, seed, transfers};
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

/// Resolve a decision to a category id.
///
/// The sorter speaks Tally's old category names, so each is mapped onto
/// whatever the owner has ("Dining" onto "Eating Out"). No match leaves the
/// row uncategorised for To review: a spending category is never made here.
/// Only income and internal transfer, which mirror Copilot's own transaction
/// types, are made the first time a row needs one.
fn resolve(conn: &Connection, decision: Decision) -> rusqlite::Result<Option<i64>> {
    Ok(match decision {
        Decision::Rule(id) => Some(id),
        Decision::Builtin(name) => seed::sorter_category(conn, name)?,
        Decision::Income => Some(seed::system_category(conn, seed::SystemKind::Income)?),
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
    // One category for the whole row ends any split: the pieces would
    // otherwise go on counting beside it.
    // It is all one transaction, so a refused category leaves the pieces be.
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM bank_transaction_splits WHERE txn_id=?1", [txn_id])?;
    tx.execute(
        "UPDATE bank_transactions SET category_id=?1, category_source='manual', reviewed=1 WHERE id=?2",
        params![category_id, txn_id],
    )?;
    let changed = apply_payee_rule(&tx, txn_id, category_id, apply_to_payee)?;
    tx.commit()?;
    Ok(changed)
}

/// The "apply to this payee" half of `set_category`: remember the choice as a
/// rule and re-file the payee's other automatic rows. Returns rows changed,
/// counting the one the owner chose.
fn apply_payee_rule(
    conn: &Connection,
    txn_id: i64,
    category_id: Option<i64>,
    apply_to_payee: bool,
) -> rusqlite::Result<usize> {
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

/// One piece of a split, as the owner entered it. The amount carries the
/// transaction's sign: a purchase splits into negative pieces.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct NewSplit {
    pub category_id: Option<i64>,
    pub amount: f64,
    pub note: Option<String>,
}

fn cents(x: f64) -> i64 {
    (x * 100.0).round() as i64
}

fn dollars(cents: i64) -> String {
    format!("${}.{:02}", cents.abs() / 100, cents.abs() % 100)
}

/// Split a transaction across categories, or unsplit it with no pieces.
///
/// The pieces must add up to the transaction to the cent, and there must be at
/// least two, none of them zero. A split row's own category is emptied and
/// made manual, which is what keeps a sync, a re-sort and transfer pairing
/// away from it: all of them touch only automatic rows. The Copilot import
/// checks for pieces itself, since Copilot's category wins over manual ones.
/// Unsplitting leaves the row uncategorised for the owner to choose. All of it
/// happens in one transaction; a refused split changes nothing.
///
/// Rust checks the count, that no piece is zero, and the sum, but not the signs:
/// the editor gives every piece the transaction's sign, and Undo may send an
/// opposite-sign uncategorised piece to put back a gap a sync left.
pub fn set_splits(conn: &Connection, txn_id: i64, pieces: &[NewSplit]) -> Result<(), String> {
    let amount: f64 = conn
        .query_row("SELECT amount FROM bank_transactions WHERE id=?1", [txn_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That transaction no longer exists.".to_string())?;
    if !pieces.is_empty() {
        if pieces.len() < 2 {
            return Err("Split it into at least two pieces.".into());
        }
        if pieces.iter().any(|p| cents(p.amount) == 0) {
            return Err("Every piece needs an amount.".into());
        }
        let sum: i64 = pieces.iter().map(|p| cents(p.amount)).sum();
        if sum != cents(amount) {
            return Err(format!(
                "The pieces add up to {}, but the transaction is {}.",
                dollars(sum), dollars(cents(amount)),
            ));
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let write = || -> rusqlite::Result<()> {
        tx.execute("DELETE FROM bank_transaction_splits WHERE txn_id=?1", [txn_id])?;
        for (i, p) in pieces.iter().enumerate() {
            // Stored to the cent, as they were checked, so sums never drift by a hair.
            let stored = cents(p.amount) as f64 / 100.0;
            tx.execute(
                "INSERT INTO bank_transaction_splits (txn_id, category_id, amount, note, sort)
                 VALUES (?1,?2,?3,?4,?5)",
                params![txn_id, p.category_id, stored, p.note, i as i64],
            )?;
        }
        tx.execute(
            "UPDATE bank_transactions SET category_id=NULL, category_source='manual', reviewed=1 WHERE id=?1",
            [txn_id],
        )?;
        Ok(())
    };
    write().map_err(|e| {
        let text = e.to_string();
        if text.contains("FOREIGN KEY") { "That category no longer exists.".to_string() } else { text }
    })?;
    tx.commit().map_err(|e| e.to_string())
}

/// File as an internal transfer every automatic row, posted on or after
/// `since`, that has an equal-and-opposite partner in another of the owner's
/// accounts. Payments to people never pair: a friend repaying dinner is not a
/// transfer. Returns how many rows it marked.
#[cfg_attr(not(test), allow(dead_code))]
pub fn mark_transfer_pairs(conn: &Connection, since: &str) -> rusqlite::Result<usize> {
    pair_transfers(conn, since, None)
}

/// `mark_transfer_pairs`, but marking only rows posted on or before `until`
/// when it is given. Every leg still counts in the pairing, so a pair that
/// straddles `until` keeps its earlier leg a transfer.
fn pair_transfers(conn: &Connection, since: &str, until: Option<&str>) -> rusqlite::Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, account_id, posted, amount, payee, description FROM bank_transactions
         WHERE category_source='auto' AND removed=0 AND posted >= ?1",
    )?;
    let legs: Vec<transfers::Leg> = stmt
        .query_map(params![since], |r| {
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
    let ids: Vec<i64> = transfers::pair(&legs).into_iter()
        .filter(|id| until.is_none_or(|u| legs.iter().any(|l| l.id == *id && l.posted.as_str() <= u)))
        .collect();
    if ids.is_empty() {
        return Ok(0);
    }
    // Looked up (or made) only now, so a database with no pairs never gains it.
    let transfer = seed::system_category(conn, seed::SystemKind::Transfer)?;
    for id in &ids {
        conn.execute("UPDATE bank_transactions SET category_id=?1 WHERE id=?2", params![transfer, id])?;
    }
    Ok(ids.len())
}

/// Re-decide every automatic row from what is already stored, then pair
/// transfers across all of history. No network: payee, description, amount
/// and account type are all on hand. Manual rows are never touched.
pub fn recategorise_all(conn: &Connection) -> rusqlite::Result<usize> {
    recategorise_until(conn, None)
}

/// `recategorise_all`, but only for rows posted on or before `until` when it
/// is given: the Copilot import never reaches past its export's newest day.
fn recategorise_until(conn: &Connection, until: Option<&str>) -> rusqlite::Result<usize> {
    let rules = load_rules(conn)?;
    let mut stmt = conn.prepare(
        "SELECT b.id, b.payee, b.description, b.mcc, b.amount, a.type
         FROM bank_transactions b JOIN accounts a ON a.id = b.account_id
         WHERE b.category_source='auto' AND (?1 IS NULL OR b.posted <= ?1)",
    )?;
    let rows: Vec<(i64, Candidate)> = stmt
        .query_map([until], |r| {
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
    pair_transfers(conn, "0000-01-01", until)?;
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

/// Remove rows from Spending and budgets (the owner was paid back), or restore
/// them. A flag, not a delete: a sync updates a removed row but never clears
/// the flag, so it does not come back. Returns how many rows changed.
pub fn set_removed(conn: &Connection, ids: &[i64], removed: bool) -> rusqlite::Result<usize> {
    let mut changed = 0;
    for id in ids {
        changed += conn.execute(
            "UPDATE bank_transactions SET removed=?1 WHERE id=?2",
            params![removed as i64, id],
        )?;
    }
    Ok(changed)
}

/// The parts of a row an action in Spending can change. The frontend keeps a
/// copy from before the action; handing it back here is Undo.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct RowState {
    pub id: i64,
    pub category_id: Option<i64>,
    pub category_source: String,
    pub reviewed: bool,
    pub removed: bool,
}

/// Undo: put rows back exactly as they were, in one transaction.
pub fn restore_rows(conn: &Connection, states: &[RowState]) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut changed = 0;
    for s in states {
        // The column has a CHECK, but a clear error beats a constraint failure.
        if s.category_source != "auto" && s.category_source != "manual" {
            return Err(rusqlite::Error::InvalidParameterName(format!("category_source {}", s.category_source)));
        }
        // A row that has been split since keeps no category of its own: its pieces
        // carry them, and sync, re-sort and transfer pairing skip it only
        // because it is manual. So an older category and source are not put
        // back on it; only reviewed and removed are.
        changed += tx.execute(
            "UPDATE bank_transactions SET
                category_id = CASE WHEN EXISTS (SELECT 1 FROM bank_transaction_splits WHERE txn_id = ?5) THEN NULL ELSE ?1 END,
                category_source = CASE WHEN EXISTS (SELECT 1 FROM bank_transaction_splits WHERE txn_id = ?5) THEN 'manual' ELSE ?2 END,
                reviewed=?3, removed=?4
             WHERE id=?5",
            params![s.category_id, s.category_source, s.reviewed as i64, s.removed as i64, s.id],
        )?;
    }
    tx.commit()?;
    Ok(changed)
}

#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct CopilotCounts { pub matched: usize, pub added: usize, pub categories: usize, pub rules: usize, pub removed: usize }

/// What the Copilot planner needs to know about the database.
pub fn copilot_snapshot(conn: &Connection) -> rusqlite::Result<copilot::Snapshot> {
    let accounts = conn.prepare("SELECT id, name FROM accounts")?
        .query_map([], |r| Ok(copilot::AccountRef { id: r.get(0)?, name: r.get(1)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let txns = conn.prepare(
        "SELECT id, account_id, posted, amount, external_id, COALESCE(name, payee, description), pending, removed,
                description
         FROM bank_transactions",
    )?
        .query_map([], |r| {
            let external_id: String = r.get(4)?;
            Ok(copilot::ExistingTxn {
                id: r.get(0)?, account_id: r.get(1)?, posted: r.get(2)?, amount: r.get(3)?,
                from_copilot: external_id.starts_with("copilot:"),
                external_id,
                label: r.get(5)?,
                pending: r.get::<_, i64>(6)? != 0,
                removed: r.get::<_, i64>(7)? != 0,
                description: r.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let categories = conn.prepare("SELECT id, name FROM categories ORDER BY sort, id")?
        .query_map([], |r| Ok(copilot::CategoryInfo { id: r.get(0)?, name: r.get(1)? }))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(copilot::Snapshot { accounts, txns, categories })
}

/// Fold `from` into `to`: its transactions, split pieces, rules and budgets
/// move to `to`, then `from` is deleted. Where `to` already has a budget for
/// the same month, `to`'s own is kept. All of it or none of it.
pub fn merge_category(conn: &Connection, from: i64, to: i64) -> rusqlite::Result<()> {
    if from == to {
        return Ok(());
    }
    conn.execute_batch("SAVEPOINT merge_category")?;
    let run = || -> rusqlite::Result<()> {
        conn.execute("UPDATE bank_transactions SET category_id=?2 WHERE category_id=?1", params![from, to])?;
        conn.execute("UPDATE bank_transaction_splits SET category_id=?2 WHERE category_id=?1", params![from, to])?;
        // A rule is unique by (match_type, pattern), whatever its category,
        // so changing only the category can never clash.
        conn.execute("UPDATE category_rules SET category_id=?2 WHERE category_id=?1", params![from, to])?;
        // `IS` so two all-months (NULL) budgets clash too, which UNIQUE misses.
        conn.execute(
            "DELETE FROM budgets WHERE category_id=?1
               AND EXISTS (SELECT 1 FROM budgets t WHERE t.category_id=?2 AND t.month IS budgets.month)",
            params![from, to],
        )?;
        conn.execute("UPDATE budgets SET category_id=?2 WHERE category_id=?1", params![from, to])?;
        conn.execute("DELETE FROM categories WHERE id=?1", [from])?;
        Ok(())
    };
    match run() {
        Ok(()) => conn.execute_batch("RELEASE merge_category"),
        Err(e) => {
            conn.execute_batch("ROLLBACK TO merge_category; RELEASE merge_category")?;
            Err(e)
        }
    }
}

/// A category's id by name ignoring case, the exact spelling first.
fn category_id_like(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT id FROM categories WHERE lower(name)=lower(?1) ORDER BY name<>?1, id LIMIT 1",
        [name], |r| r.get(0),
    ).optional()
}

/// Give Tally's category `from` Copilot's name `to`: merged into `to` if that
/// exists as another category, otherwise renamed, keeping its id. A name that
/// differs only in case is renamed to Copilot's spelling.
fn merge_into_name(conn: &Connection, from: &str, to: &str) -> rusqlite::Result<()> {
    let Some(from_id) = category_id_like(conn, from)? else { return Ok(()) };
    let exact: Option<i64> = conn.query_row(
        "SELECT id FROM categories WHERE name=?1 AND id<>?2", params![to, from_id], |r| r.get(0),
    ).optional()?;
    let other = match exact {
        Some(id) => Some(id),
        None => conn.query_row(
            "SELECT id FROM categories WHERE lower(name)=lower(?1) AND id<>?2 ORDER BY id LIMIT 1",
            params![to, from_id], |r| r.get(0),
        ).optional()?,
    };
    match other {
        Some(to_id) => {
            merge_category(conn, from_id, to_id)?;
            // The one kept takes Copilot's exact spelling.
            conn.execute("UPDATE categories SET name=?2 WHERE id=?1", params![to_id, to]).map(|_| ())
        }
        None => conn.execute("UPDATE categories SET name=?2 WHERE id=?1", params![from_id, to]).map(|_| ()),
    }
}

/// Whether the import keeps a category: the export uses its name, or it is a
/// system category and the export has rows of that kind.
fn wanted_by_export(export: &[String]) -> impl Fn(&str) -> bool {
    let used: std::collections::HashSet<String> = export.iter().map(|n| n.to_lowercase()).collect();
    let kinds: Vec<seed::SystemKind> = export.iter().filter_map(|n| copilot::system_kind(n)).collect();
    move |name: &str| {
        used.contains(&name.to_lowercase()) || copilot::system_kind(name).is_some_and(|k| kinds.contains(&k))
    }
}

/// Tally's categories become exactly Copilot's: delete every category the
/// export doesn't want, whatever holds it. Its rows become uncategorised and
/// go back to To review; its split pieces become uncategorised (ON DELETE SET
/// NULL); its rules and budgets go with it. Then every automatic row is
/// sorted again into what is left, as a bank sync would, which also pairs
/// transfers into Internal transfer afresh. Returns the names that went.
fn drop_unwanted_categories(conn: &Connection, export: &[String]) -> rusqlite::Result<Vec<String>> {
    let wanted = wanted_by_export(export);
    let all: Vec<(i64, String)> = conn.prepare("SELECT id, name FROM categories ORDER BY sort, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut names = Vec::new();
    for (id, name) in all.into_iter().filter(|(_, n)| !wanted(n)) {
        conn.execute("UPDATE bank_transactions SET category_source='auto', reviewed=0 WHERE category_id=?1", [id])?;
        conn.execute("DELETE FROM categories WHERE id=?1", [id])?;
        names.push(name);
    }
    recategorise_until(conn, None)?;
    Ok(names)
}

/// Remove every category, to start sorting again from nothing. Every row
/// becomes uncategorised and goes back to To review; split pieces become
/// uncategorised; rules and budgets go with their categories. No transaction
/// is deleted. All of it or none of it. Returns how many categories went.
pub fn clear_categories(conn: &Connection) -> rusqlite::Result<usize> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE bank_transactions SET category_id=NULL, category_source='auto', reviewed=0 WHERE category_id IS NOT NULL",
        [],
    )?;
    let deleted = tx.execute("DELETE FROM categories", [])?;
    tx.commit()?;
    Ok(deleted)
}

/// Put the categories in Copilot's order — the export's, most used first,
/// then the system ones, then the rest as they were — and give each its own
/// colour token in that order, wrapping only past the twelfth.
fn order_categories(conn: &Connection, export: &[String]) -> rusqlite::Result<()> {
    let all: Vec<(i64, String)> = conn.prepare("SELECT id, name FROM categories ORDER BY sort, id")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut order: Vec<i64> = Vec::with_capacity(all.len());
    let mut push = |id: i64| if !order.contains(&id) { order.push(id) };
    for name in export.iter().filter(|n| copilot::system_kind(n).is_none()) {
        if let Some((id, _)) = all.iter().find(|(_, n)| n.eq_ignore_ascii_case(name)) { push(*id); }
    }
    for (id, _) in all.iter().filter(|(_, n)| copilot::system_kind(n).is_some()) { push(*id); }
    for (id, _) in &all { push(*id); }
    for (i, id) in order.iter().enumerate() {
        conn.execute(
            "UPDATE categories SET colour=?1, sort=?2 WHERE id=?3",
            params![format!("cat-{}", i % seed::COLOURS + 1), (i as i64 + 1) * 10, id],
        )?;
    }
    Ok(())
}

/// The category a Copilot name lands in. Transfer and Income are the system
/// categories, found or made by kind; anything else must already exist.
fn category_named(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    if let Some(kind) = copilot::system_kind(name) {
        return seed::system_category(conn, kind).map(Some);
    }
    category_id_like(conn, name)
}

/// The manual account that holds rows whose Copilot account no longer exists.
/// It carries bank transactions only, so its balance stays zero.
fn history_account(conn: &Connection) -> rusqlite::Result<i64> {
    let found: Option<i64> = conn.query_row(
        "SELECT id FROM accounts WHERE name=?1 AND source='manual'",
        [copilot::HISTORY_ACCOUNT],
        |r| r.get(0),
    ).optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO accounts (name,type,currency,created_at,source) VALUES (?1,'cash','USD',?2,'manual')",
        params![copilot::HISTORY_ACCOUNT, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Write a Copilot plan: all of it or none of it, so that afterwards Tally
/// holds what Copilot holds, up to the cutoff, in exactly Copilot's
/// categories. Every Copilot row is matched or added; every Tally row Copilot
/// doesn't have (`plan.not_in_copilot`) is removed, restorably.
///
/// Copilot wins for every row it covers, except a split row (Copilot can't
/// express one). Nothing dated after `plan.cutoff` is changed, apart from a
/// category merge renaming what it points at or a deleted category leaving it
/// uncategorised, and no transaction is deleted.
///
/// Any category the export doesn't use goes, even while it holds rows
/// (uncategorised, back to To review), splits or budgets.
pub fn apply_copilot_plan(conn: &Connection, plan: &copilot::Plan) -> rusqlite::Result<CopilotCounts> {
    if plan.cutoff.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName(NO_POSTED.into()));
    }
    let tx = conn.unchecked_transaction()?;
    let newest_before: i64 = tx.query_row("SELECT COALESCE(MAX(id),0) FROM categories", [], |r| r.get(0))?;
    apply_merges(&tx, plan)?;
    let mut counts = write_plan(&tx, plan)?;
    drop_unwanted_categories(&tx, &plan.export_categories)?;
    order_categories(&tx, &plan.export_categories)?;
    // Every category made here, the system ones included.
    counts.categories = tx.query_row(
        "SELECT count(*) FROM categories WHERE id > ?1", [newest_before], |r| r.get::<_, i64>(0),
    )? as usize;
    tx.commit()?;
    Ok(counts)
}

/// Why an export with nothing posted in it is refused.
pub const NO_POSTED: &str = "This Copilot export has no posted transactions, so there's nothing to match.";

/// What importing `rows` would do, without doing it. The planner works from a
/// snapshot; what the re-sort and tidying leave behind is found by running
/// the import for real in a transaction that is then rolled back.
pub fn copilot_preview(conn: &Connection, rows: &[copilot::CopilotRow]) -> Result<copilot::Plan, String> {
    let snap = copilot_snapshot(conn).map_err(|e| e.to_string())?;
    let mut plan = copilot::plan(rows, &snap);
    if plan.cutoff.is_empty() {
        return Err(NO_POSTED.into());
    }
    dry_run(conn, &mut plan).map_err(|e| e.to_string())?;
    Ok(plan)
}

/// Run the import, read back `recategorised`, `deletions` and
/// `uncategorised`, and roll it all back.
fn dry_run(conn: &Connection, plan: &mut copilot::Plan) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let categorised: Vec<i64> = tx.prepare(
        "SELECT id FROM bank_transactions WHERE category_id IS NOT NULL AND removed=0",
    )?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    apply_merges(&tx, plan)?;
    let category_of = |id: i64| -> rusqlite::Result<Option<i64>> {
        tx.query_row("SELECT category_id FROM bank_transactions WHERE id=?1", [id], |r| r.get(0))
    };
    let before: Vec<(i64, Option<i64>)> = plan.matches.iter()
        .map(|m| Ok((m.txn_id, category_of(m.txn_id)?)))
        .collect::<rusqlite::Result<_>>()?;
    write_plan(&tx, plan)?;
    let mut recategorised = 0;
    for (id, was) in before {
        if category_of(id)? != was { recategorised += 1; }
    }
    plan.recategorised = recategorised;
    plan.deletions = drop_unwanted_categories(&tx, &plan.export_categories)?;
    // Rows that had a category, are still in Spending, and have none now.
    let mut uncategorised = 0;
    for id in categorised {
        let lost: bool = tx.query_row(
            "SELECT category_id IS NULL AND removed=0
                    AND NOT EXISTS (SELECT 1 FROM bank_transaction_splits s WHERE s.txn_id = b.id)
             FROM bank_transactions b WHERE id=?1",
            [id], |r| r.get(0),
        )?;
        if lost { uncategorised += 1; }
    }
    plan.uncategorised = uncategorised;
    drop(tx); // rolled back
    Ok(())
}

/// Tally's old names and spellings give way to Copilot's first, so everything
/// after lands in Copilot's.
fn apply_merges(conn: &Connection, plan: &copilot::Plan) -> rusqlite::Result<()> {
    for (from, to) in &plan.merges {
        merge_into_name(conn, from, to)?;
    }
    Ok(())
}

/// The import from new categories to the re-sort, with merges already done.
/// Counts are of rows actually changed, so importing the same file again
/// counts nothing.
fn write_plan(tx: &Connection, plan: &copilot::Plan) -> rusqlite::Result<CopilotCounts> {
    let mut counts = CopilotCounts::default();
    let cutoff = plan.cutoff.as_str();

    for c in &plan.new_categories {
        let sort: i64 = tx.query_row("SELECT COALESCE(MAX(sort),0)+10 FROM categories", [], |r| r.get(0))?;
        tx.execute(
            "INSERT OR IGNORE INTO categories (name,kind,colour,sort,is_builtin) VALUES (?1,?2,?3,?4,0)",
            params![c.name, c.kind, seed::next_colour(&tx)?, sort],
        )?;
    }
    // What the owner was paid back for never counts as spending, even in an
    // Excluded category they made themselves.
    tx.execute("UPDATE categories SET kind='transfer' WHERE lower(name)=lower(?1)", [copilot::EXCLUDED])?;
    // Copilot decides what counts as spending: a category it excludes whole
    // doesn't count here either, and one it counts does again. Its system
    // categories, Investments and an income category the owner made are left
    // as they are.
    for name in &plan.export_categories {
        if copilot::system_kind(name).is_some() || name.eq_ignore_ascii_case(copilot::EXCLUDED)
            || name.eq_ignore_ascii_case("investments") {
            continue;
        }
        let kind = if plan.not_counted.contains(name) { "transfer" } else { "spending" };
        tx.execute(
            "UPDATE categories SET kind=?1 WHERE lower(name)=lower(?2) AND kind NOT IN ('income', ?1)",
            params![kind, name],
        )?;
    }

    let mut history: Option<i64> = None;
    for a in &plan.additions {
        let account_id = match a.account {
            copilot::Target::Account(id) => id,
            copilot::Target::History => match history {
                Some(id) => id,
                None => {
                    let id = history_account(&tx)?;
                    history = Some(id);
                    id
                }
            },
        };
        let category = match &a.category { Some(n) => category_named(tx, n)?, None => None };
        // A row Copilot left uncategorised waits in To review, as there. The
        // owner's own note stays when Copilot has none. Copilot has it, so a
        // copy removed in Tally comes back. `name` keeps Copilot's name once a
        // bank sync takes the row over.
        counts.added += tx.execute(
            "INSERT INTO bank_transactions
               (account_id,external_id,posted,amount,description,payee,name,category_id,category_source,reviewed,note)
             VALUES (?1,?2,?3,?4,?5,?5,?5,?6,'manual',?6 IS NOT NULL,?7)
             ON CONFLICT(account_id,external_id) DO UPDATE SET
               category_id=excluded.category_id, note=COALESCE(excluded.note, bank_transactions.note),
               name=excluded.name, removed=0
             WHERE NOT EXISTS (SELECT 1 FROM bank_transaction_splits s WHERE s.txn_id = bank_transactions.id)
               AND bank_transactions.posted <= ?8
               AND (bank_transactions.category_id IS NOT excluded.category_id
                    OR bank_transactions.note IS NOT COALESCE(excluded.note, bank_transactions.note)
                    OR bank_transactions.name IS NOT excluded.name
                    OR bank_transactions.removed <> 0)",
            params![account_id, a.external_id, a.posted, a.amount, a.name, category, a.note, cutoff],
        )?;
    }

    for m in &plan.matches {
        let category = match &m.category { Some(n) => category_named(tx, n)?, None => None };
        // Copilot's category wins over one chosen in Tally; no category in
        // Copilot means uncategorised and back in To review. A split row keeps
        // its pieces: Copilot can't express a split.
        counts.matched += tx.execute(
            "UPDATE bank_transactions SET category_id=?1, category_source='manual', reviewed=(?1 IS NOT NULL)
             WHERE id=?2 AND posted <= ?3
               AND NOT EXISTS (SELECT 1 FROM bank_transaction_splits s WHERE s.txn_id = bank_transactions.id)
               AND (category_id IS NOT ?1 OR category_source <> 'manual' OR reviewed <> (?1 IS NOT NULL))",
            params![category, m.txn_id, cutoff],
        )?;
        tx.execute(
            "UPDATE bank_transactions SET note=?1 WHERE id=?2 AND posted <= ?3 AND note IS NULL AND ?1 IS NOT NULL",
            params![m.note, m.txn_id, cutoff],
        )?;
        // Copilot's name shows in place of the bank's, as it did in Copilot.
        tx.execute(
            "UPDATE bank_transactions SET name=?1 WHERE id=?2 AND posted <= ?3 AND name IS NOT ?1",
            params![m.name, m.txn_id, cutoff],
        )?;
    }

    // Rules follow Copilot too, replacing a payee's existing rule.
    for r in &plan.rules {
        if let Some(id) = category_named(tx, &r.category)? {
            counts.rules += tx.execute(
                "INSERT INTO category_rules (match_type,pattern,category_id,created_at)
                 VALUES ('payee',?1,?2,?3)
                 ON CONFLICT(match_type,pattern) DO UPDATE SET category_id=excluded.category_id
                 WHERE category_rules.category_id <> excluded.category_id",
                params![r.pattern, id, chrono::Utc::now().to_rfc3339()],
            )?;
        }
    }

    // Tally matches Copilot: what Copilot doesn't have is removed, restorably.
    let gone: Vec<i64> = plan.not_in_copilot.iter().map(|n| n.txn_id).collect();
    counts.removed = set_removed(tx, &gone, true)?;

    // The learned rules apply at once to every automatic row up to the cutoff.
    recategorise_until(tx, Some(cutoff))?;
    Ok(counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    /// A database holding Tally's old built-in categories, which the sorter's
    /// names still come from.
    fn seeded() -> Connection {
        let conn = db::open_in_memory().unwrap();
        seed::test_categories(&conn);
        conn
    }

    #[test]
    fn the_sorter_files_dining_under_the_owners_eating_out() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO categories (name,kind) VALUES ('Eating Out','spending')", []).unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[txn("t1", -12.0, "Local Diner", Some("5812"))], &[]).unwrap();
        assert_eq!(category_of(&conn, "t1").as_deref(), Some("Eating Out"));
    }

    #[test]
    fn with_no_matching_category_the_row_waits_uncategorised() {
        let conn = db::open_in_memory().unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[txn("t1", -12.0, "Local Diner", Some("5812"))], &[]).unwrap();
        assert_eq!(category_of(&conn, "t1"), None);
        let categories: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(categories, 0, "the sorter never makes a spending category");
    }

    #[test]
    fn money_in_makes_the_income_category_on_first_need() {
        let conn = db::open_in_memory().unwrap();
        let bank = account(&conn, "Checking", "cash");
        upsert_transactions(&conn, bank, &[
            txn("p1", 1500.0, "Zqx Holdings", None),
            txn("p2", 1500.0, "Zqx Holdings Two", None),
        ], &[]).unwrap();
        assert_eq!(category_of(&conn, "p1").as_deref(), Some("Income"));
        assert_eq!(category_of(&conn, "p2").as_deref(), Some("Income"));
        let n: i64 = conn.query_row("SELECT count(*) FROM categories WHERE kind='income'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn transfer_pairing_works_with_no_categories_at_all() {
        let conn = db::open_in_memory().unwrap();
        let bank = account(&conn, "Checking", "cash");
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, bank, &[payee_txn("out", "2026-10-12", -40.59, "Zqx Holdings")], &[]).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("in", "2026-10-11", 40.59, "Zqx Holdings")], &[]).unwrap();

        assert_eq!(mark_transfer_pairs(&conn, "2026-01-01").unwrap(), 2);
        assert_eq!(category_of(&conn, "out").as_deref(), Some("Internal transfer"));
        assert_eq!(category_of(&conn, "in").as_deref(), Some("Internal transfer"));
        let kind: String = conn.query_row("SELECT kind FROM categories WHERE name='Internal transfer'", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "transfer");
    }

    #[test]
    fn transfer_pairing_with_nothing_to_pair_makes_no_category() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(mark_transfer_pairs(&conn, "2026-01-01").unwrap(), 0);
        let n: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn a_copilot_internal_transfer_lands_in_the_system_category() {
        let conn = db::open_in_memory().unwrap();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-01-05\",\"To savings\",\"-200\",\"posted\",\"\",\"\",\"false\",\"\",\"internal transfer\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-06\",\"Payroll\",\"900\",\"posted\",\"\",\"\",\"false\",\"\",\"income\",\"\",\"\",\"\",\"\"\n");
        let plan = copilot_plan(&conn, &csv);
        assert!(plan.new_categories.is_empty(), "transfer and income are never offered as new spending");

        apply_copilot_plan(&conn, &plan).unwrap();

        let kinds: Vec<(String, String)> = conn.prepare("SELECT name, kind FROM categories ORDER BY name").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(kinds, vec![
            ("Income".to_string(), "income".to_string()),
            ("Internal transfer".to_string(), "transfer".to_string()),
        ]);
    }

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
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("r1", "2026-10-01", 12.0, "Zqx Holdings")], &[]).unwrap();
        assert_eq!(row(&conn, "r1").0, None);
    }

    #[test]
    fn a_new_transaction_arrives_unreviewed() {
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Target")], &[]).unwrap();
        assert_eq!(row(&conn, "t1"), (Some("Shopping".into()), "auto".into(), false));
    }

    #[test]
    fn matched_legs_across_accounts_become_transfers() {
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
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
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Zqx Holdings")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        let dining = seed::category_id(&conn, "Dining").unwrap();
        set_category(&conn, id, dining, false).unwrap();
        assert_eq!(row(&conn, "t1"), (Some("Dining".into()), "manual".into(), true));
    }

    #[test]
    fn approving_marks_reviewed_and_locks_the_category() {
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Target")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();

        assert_eq!(approve(&conn, &[id]).unwrap(), 1);
        assert_eq!(row(&conn, "t1"), (Some("Shopping".into()), "manual".into(), true));
    }

    #[test]
    fn a_later_sync_does_not_unreview_a_row() {
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Target")], &[]).unwrap();
        conn.execute("UPDATE bank_transactions SET reviewed=1", []).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.5, "Target")], &[]).unwrap();
        assert!(row(&conn, "t1").2);
    }

    fn removed(conn: &Connection, ext: &str) -> bool {
        conn.query_row("SELECT removed FROM bank_transactions WHERE external_id=?1", [ext], |r| r.get::<_, i64>(0)).unwrap() != 0
    }

    #[test]
    fn a_removed_transaction_stays_removed_through_a_sync_until_restored() {
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -30.0, "Target")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();

        assert_eq!(set_removed(&conn, &[id], true).unwrap(), 1);
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -30.0, "Target")], &[]).unwrap();
        assert!(removed(&conn, "t1"), "a sync must not bring it back");

        set_removed(&conn, &[id], false).unwrap();
        assert!(!removed(&conn, "t1"));
    }

    #[test]
    fn undo_puts_a_row_back_exactly_as_it_was() {
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-01", -9.0, "Target")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        let shopping = seed::category_id(&conn, "Shopping").unwrap();
        let before = RowState { id, category_id: shopping, category_source: "auto".into(), reviewed: false, removed: false };

        // Approve, change the category and remove it — then undo all of that.
        approve(&conn, &[id]).unwrap();
        set_category(&conn, id, seed::category_id(&conn, "Dining").unwrap(), false).unwrap();
        set_removed(&conn, &[id], true).unwrap();
        assert_eq!(restore_rows(&conn, &[before]).unwrap(), 1);

        assert_eq!(row(&conn, "t1"), (Some("Shopping".into()), "auto".into(), false));
        assert!(!removed(&conn, "t1"));
    }

    #[test]
    fn undoing_an_earlier_action_never_gives_a_split_row_a_category() {
        let conn = seeded();
        let (_, id) = costco(&conn);
        let groceries = seed::category_id(&conn, "Groceries").unwrap();
        // How the row looked before it was split: an automatic category, unreviewed.
        let before = RowState { id, category_id: groceries, category_source: "auto".into(), reviewed: false, removed: true };
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        assert_eq!(restore_rows(&conn, &[before]).unwrap(), 1);

        assert_eq!(row(&conn, "c1"), (None, "manual".into(), false), "still a split row; reviewed restored");
        assert!(removed(&conn, "c1"), "removed restored");
        assert_eq!(splits_of(&conn, "c1").len(), 2, "the pieces are untouched");
    }

    #[test]
    fn undo_refuses_a_source_that_is_not_auto_or_manual() {
        let conn = seeded();
        let bad = RowState { id: 1, category_id: None, category_source: "bogus".into(), reviewed: false, removed: false };
        assert!(restore_rows(&conn, &[bad]).is_err());
    }

    #[test]
    fn removed_rows_never_pair_as_transfers() {
        let conn = seeded();
        let bank = account(&conn, "Checking", "cash");
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, bank, &[payee_txn("out", "2026-10-12", -40.0, "Zqx Holdings")], &[]).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("in", "2026-10-12", 40.0, "Zqx Holdings")], &[]).unwrap();
        let out: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='out'", [], |r| r.get(0)).unwrap();
        set_removed(&conn, &[out], true).unwrap();

        assert_eq!(mark_transfer_pairs(&conn, "2026-01-01").unwrap(), 0);
    }

    fn splits_of(conn: &Connection, ext: &str) -> Vec<(Option<String>, f64)> {
        conn.prepare(
            "SELECT c.name, s.amount FROM bank_transaction_splits s
             JOIN bank_transactions b ON b.id = s.txn_id
             LEFT JOIN categories c ON c.id = s.category_id
             WHERE b.external_id=?1 ORDER BY s.sort",
        ).unwrap()
            .query_map([ext], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
            .map(|r| r.unwrap()).collect()
    }

    fn piece(conn: &Connection, category: Option<&str>, amount: f64) -> NewSplit {
        NewSplit { category_id: category.and_then(|n| seed::category_id(conn, n).unwrap()), amount, note: None }
    }

    /// One $85.50 Costco trip on a card; returns (card, transaction id).
    fn costco(conn: &Connection) -> (i64, i64) {
        let card = account(conn, "Card", "credit");
        upsert_transactions(conn, card, &[payee_txn("c1", "2026-10-03", -85.5, "Costco")], &[]).unwrap();
        let id = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='c1'", [], |r| r.get(0)).unwrap();
        (card, id)
    }

    #[test]
    fn a_split_stores_its_pieces_and_empties_the_rows_own_category() {
        let conn = seeded();
        let (_, id) = costco(&conn);

        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        assert_eq!(splits_of(&conn, "c1"), vec![(Some("Groceries".into()), -60.0), (Some("Shopping".into()), -25.5)]);
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true), "a split row is the owner's, and reviewed");
    }

    #[test]
    fn a_split_must_add_up_to_the_transaction() {
        let conn = seeded();
        let (_, id) = costco(&conn);

        let err = set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, None, -25.0)]).unwrap_err();

        assert_eq!(err, "The pieces add up to $85.00, but the transaction is $85.50.");
        assert!(splits_of(&conn, "c1").is_empty(), "a refused split writes nothing");
        assert_eq!(row(&conn, "c1").1, "auto");
    }

    #[test]
    fn a_split_needs_two_pieces_each_with_an_amount() {
        let conn = seeded();
        let (_, id) = costco(&conn);

        assert_eq!(
            set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -85.5)]).unwrap_err(),
            "Split it into at least two pieces.",
        );
        assert_eq!(
            set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -85.5), piece(&conn, None, 0.0)]).unwrap_err(),
            "Every piece needs an amount.",
        );
        assert_eq!(
            set_splits(&conn, 99_999, &[]).unwrap_err(),
            "That transaction no longer exists.",
        );
    }

    #[test]
    fn splitting_again_replaces_the_pieces() {
        let conn = seeded();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        set_splits(&conn, id, &[piece(&conn, Some("Dining"), -80.0), piece(&conn, None, -5.5)]).unwrap();

        assert_eq!(splits_of(&conn, "c1"), vec![(Some("Dining".into()), -80.0), (None, -5.5)]);
    }

    #[test]
    fn unsplitting_removes_the_pieces_and_leaves_the_row_uncategorised() {
        let conn = seeded();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        set_splits(&conn, id, &[]).unwrap();

        assert!(splits_of(&conn, "c1").is_empty());
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true));
    }

    #[test]
    fn a_later_sync_and_a_re_sort_leave_a_split_alone() {
        let conn = seeded();
        let (card, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        upsert_transactions(&conn, card, &[payee_txn("c1", "2026-10-03", -85.5, "Costco")], &[]).unwrap();
        recategorise_all(&conn).unwrap();

        assert_eq!(splits_of(&conn, "c1").len(), 2);
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true));
    }

    #[test]
    fn deleting_the_account_deletes_the_pieces() {
        let conn = seeded();
        let (card, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        conn.execute("DELETE FROM accounts WHERE id=?1", [card]).unwrap();

        let n: i64 = conn.query_row("SELECT count(*) FROM bank_transaction_splits", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn deleting_a_category_leaves_its_piece_uncategorised() {
        let conn = seeded();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        conn.execute("DELETE FROM categories WHERE name='Groceries'", []).unwrap();

        assert_eq!(splits_of(&conn, "c1"), vec![(None, -60.0), (Some("Shopping".into()), -25.5)]);
    }

    #[test]
    fn choosing_one_category_ends_a_split() {
        let conn = seeded();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        set_category(&conn, id, seed::category_id(&conn, "Groceries").unwrap(), false).unwrap();

        assert!(splits_of(&conn, "c1").is_empty());
        assert_eq!(row(&conn, "c1").0.as_deref(), Some("Groceries"));
    }

    #[test]
    fn a_refused_category_leaves_the_split_in_place() {
        let conn = seeded();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        assert!(set_category(&conn, id, Some(99_999), false).is_err());

        assert_eq!(splits_of(&conn, "c1").len(), 2, "a failed change keeps the pieces");
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true));
    }

    #[test]
    fn a_split_that_fails_part_way_changes_nothing() {
        let conn = seeded();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();
        let gone = NewSplit { category_id: Some(99_999), amount: -5.5, note: None };

        let err = set_splits(&conn, id, &[piece(&conn, Some("Dining"), -80.0), gone]).unwrap_err();

        assert_eq!(err, "That category no longer exists.");
        assert_eq!(splits_of(&conn, "c1"), vec![(Some("Groceries".into()), -60.0), (Some("Shopping".into()), -25.5)]);
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true));
    }

    #[test]
    fn pieces_are_stored_to_the_cent() {
        let conn = seeded();
        let (_, id) = costco(&conn);

        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.004), piece(&conn, Some("Shopping"), -25.496)]).unwrap();

        assert_eq!(splits_of(&conn, "c1"), vec![(Some("Groceries".into()), -60.0), (Some("Shopping".into()), -25.5)]);
    }

    #[test]
    fn a_refund_splits_into_positive_pieces() {
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("r1", "2026-10-04", 30.0, "Costco")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='r1'", [], |r| r.get(0)).unwrap();

        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), 20.0), piece(&conn, Some("Shopping"), 10.0)]).unwrap();

        assert_eq!(splits_of(&conn, "r1"), vec![(Some("Groceries".into()), 20.0), (Some("Shopping".into()), 10.0)]);
    }

    #[test]
    fn three_pieces_that_add_up_to_the_cent_save() {
        let conn = seeded();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("t1", "2026-10-05", -100.0, "Costco")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='t1'", [], |r| r.get(0)).unwrap();

        set_splits(&conn, id, &[
            piece(&conn, Some("Groceries"), -33.33),
            piece(&conn, Some("Shopping"), -33.33),
            piece(&conn, None, -33.34),
        ]).unwrap();

        assert_eq!(splits_of(&conn, "t1").len(), 3);
    }

    use crate::budget::copilot;

    fn copilot_plan(conn: &Connection, csv: &str) -> copilot::Plan {
        copilot_preview(conn, &copilot::parse_csv(csv).unwrap()).unwrap()
    }

    fn copilot_row(date: &str, name: &str, amount: &str, category: &str, kind: &str, mask: &str) -> String {
        format!("\"{date}\",\"{name}\",\"{amount}\",\"posted\",\"{category}\",\"\",\"false\",\"\",\"{kind}\",\"Adv\",\"{mask}\",\"\",\"\"")
    }
    fn export(rows: &[String]) -> String {
        format!("{COPILOT_HEADER}\n{}\n", rows.join("\n"))
    }
    fn id_of(conn: &Connection, ext: &str) -> i64 {
        conn.query_row("SELECT id FROM bank_transactions WHERE external_id=?1", [ext], |r| r.get(0)).unwrap()
    }
    fn file_under(conn: &Connection, ext: &str, category: &str) {
        conn.execute(
            "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name=?2) WHERE external_id=?1",
            params![ext, category],
        ).unwrap();
    }
    /// Everything an import could change, to compare before and after.
    fn dump(conn: &Connection) -> Vec<Vec<rusqlite::types::Value>> {
        let mut out = Vec::new();
        for sql in [
            "SELECT * FROM categories ORDER BY id",
            "SELECT * FROM bank_transactions ORDER BY id",
            "SELECT * FROM bank_transaction_splits ORDER BY id",
            "SELECT * FROM category_rules ORDER BY id",
            "SELECT * FROM budgets ORDER BY id",
            "SELECT * FROM accounts ORDER BY id",
        ] {
            let mut stmt = conn.prepare(sql).unwrap();
            let n = stmt.column_count();
            let rows: Vec<Vec<rusqlite::types::Value>> = stmt
                .query_map([], |r| (0..n).map(|i| r.get(i)).collect()).unwrap()
                .map(|r| r.unwrap()).collect();
            out.extend(rows);
        }
        out
    }

    #[test]
    fn a_matched_row_copilot_left_uncategorised_goes_back_to_to_review() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner")], &[]).unwrap();
        set_category(&conn, id_of(&conn, "sf1"), seed::category_id(&conn, "Groceries").unwrap(), false).unwrap();
        let csv = export(&[copilot_row("2026-07-02", "Zqx Diner", "12.50", "", "regular", "9849")]);
        let plan = copilot_plan(&conn, &csv);
        assert_eq!(plan.recategorised, 1);

        apply_copilot_plan(&conn, &plan).unwrap();

        assert_eq!(row(&conn, "sf1"), (None, "manual".into(), false));
        assert_eq!(copilot_plan(&conn, &csv).recategorised, 0, "already uncategorised: no change");
    }

    #[test]
    fn a_second_import_changes_nothing_at_all() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        let other = account(&conn, "Brokerage", "cash");
        upsert_transactions(&conn, card, &[
            payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner"),
            payee_txn("late", "2026-08-01", -50.0, "Zqx Air"),
        ], &[]).unwrap();
        // Copilot doesn't cover this account; the learned rule re-sorts it
        // out of Travel, which must then go in the same import.
        upsert_transactions(&conn, other, &[payee_txn("golf", "2026-03-01", -40.0, "Haggin Oaks")], &[]).unwrap();
        file_under(&conn, "golf", "Travel");
        file_under(&conn, "late", "Health");
        let csv = export(&[
            copilot_row("2026-07-02", "Zqx Diner", "12.50", "Eating Out", "regular", "9849"),
            copilot_row("2026-01-06", "Haggin Oaks", "20", "Golf", "regular", ""),
            copilot_row("2026-01-07", "Haggin Oaks", "25", "Golf", "regular", ""),
        ]);
        let plan = copilot_plan(&conn, &csv);
        assert!(plan.deletions.contains(&"Travel".to_string()), "the preview sees the re-sort empty it");
        apply_copilot_plan(&conn, &plan).unwrap();
        assert_eq!(seed::category_id(&conn, "Travel").unwrap(), None);
        assert_eq!(row(&conn, "golf").0.as_deref(), Some("Golf"));
        let before = dump(&conn);

        let again = copilot_plan(&conn, &csv);
        assert!(again.merges.is_empty() && again.deletions.is_empty() && again.new_categories.is_empty());
        let counts = apply_copilot_plan(&conn, &again).unwrap();

        assert_eq!(counts, CopilotCounts::default(), "nothing changed, so nothing counted");
        assert_eq!(dump(&conn), before);
    }

    #[test]
    fn a_transfer_pair_straddling_the_cutoff_stays_paired() {
        let conn = seeded();
        let bank = account(&conn, "Checking", "cash");
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, bank, &[payee_txn("out", "2026-07-03", 300.0, "Zqx Holdings")], &[]).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("in", "2026-07-04", -300.0, "Zqx Holdings")], &[]).unwrap();
        assert_eq!(mark_transfer_pairs(&conn, "2026-01-01").unwrap(), 2);
        let late_before = snapshot_of(&conn, "in");
        // The export ends 07-03: one leg on the cutoff, one after it.
        let csv = export(&[copilot_row("2026-07-03", "Elsewhere", "1", "Other", "regular", "")]);

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        assert_eq!(row(&conn, "out").0.as_deref(), Some("Internal transfer"), "re-sorted, then paired again");
        // Only the rename of Tally's old Transfer reaches the later leg.
        let mut expected = late_before;
        assert_eq!(expected.1.as_deref(), Some("Transfer"));
        expected.1 = Some("Internal transfer".into());
        assert_eq!(snapshot_of(&conn, "in"), expected);
    }

    #[test]
    fn a_re_import_keeps_the_owners_note_when_copilot_has_none() {
        let conn = seeded();
        let csv = export(&[copilot_row("2026-01-05", "Old Diner", "8", "Eating Out", "regular", "")]);
        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();
        conn.execute("UPDATE bank_transactions SET note='with Sam'", []).unwrap();
        // Copilot has since moved it, with still no note of its own.
        let moved = export(&[copilot_row("2026-01-05", "Old Diner", "8", "Golf", "regular", "")]);

        apply_copilot_plan(&conn, &copilot_plan(&conn, &moved)).unwrap();

        let (note, category): (Option<String>, String) = conn.query_row(
            "SELECT b.note, c.name FROM bank_transactions b JOIN categories c ON c.id=b.category_id", [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!((note.as_deref(), category.as_str()), (Some("with Sam"), "Golf"));
    }

    #[test]
    fn an_export_with_nothing_posted_is_refused() {
        let conn = seeded();
        let empty = copilot::parse_csv(&export(&[])).unwrap();
        assert_eq!(copilot_preview(&conn, &empty).unwrap_err(), NO_POSTED);
        let pending = copilot_row("2026-01-05", "P", "8", "Other", "regular", "").replace("\"posted\"", "\"pending\"");
        let all_pending = copilot::parse_csv(&export(&[pending])).unwrap();
        assert_eq!(copilot_preview(&conn, &all_pending).unwrap_err(), NO_POSTED);
        assert!(apply_copilot_plan(&conn, &copilot::Plan::default()).is_err());
    }

    #[test]
    fn a_category_takes_copilots_exact_spelling() {
        let conn = seeded();
        conn.execute("INSERT INTO categories (name,kind) VALUES ('golf','spending')", []).unwrap();
        let golf = seed::category_id(&conn, "golf").unwrap().unwrap();
        let csv = export(&[copilot_row("2026-01-05", "Range", "8", "Golf", "regular", "")]);
        let plan = copilot_plan(&conn, &csv);
        assert!(plan.merges.contains(&("golf".to_string(), "Golf".to_string())));

        apply_copilot_plan(&conn, &plan).unwrap();

        assert_eq!(seed::category_id(&conn, "Golf").unwrap(), Some(golf));
        assert_eq!(seed::category_id(&conn, "golf").unwrap(), None);
    }

    #[test]
    fn a_row_an_earlier_import_added_and_copilot_dropped_can_be_removed_not_deleted() {
        let conn = seeded();
        let first = export(&[
            copilot_row("2026-01-05", "Paid back", "40", "Eating Out", "regular", ""),
            copilot_row("2026-01-09", "Kept", "8", "Eating Out", "regular", ""),
        ]);
        apply_copilot_plan(&conn, &copilot_plan(&conn, &first)).unwrap();
        let second = export(&[
            copilot_row("2026-01-01", "Older", "3", "Eating Out", "regular", ""),
            copilot_row("2026-01-09", "Kept", "8", "Eating Out", "regular", ""),
        ]);
        let plan = copilot_plan(&conn, &second);
        assert_eq!(plan.not_in_copilot.len(), 1);
        assert!(plan.not_in_copilot[0].earlier_export);
        let gone = plan.not_in_copilot[0].txn_id;

        apply_copilot_plan(&conn, &plan).unwrap();

        let (removed, total): (i64, i64) = conn.query_row(
            "SELECT (SELECT removed FROM bank_transactions WHERE id=?1), (SELECT count(*) FROM bank_transactions)",
            [gone], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!((removed, total), (1, 3), "flagged removed, never deleted");
    }

    #[test]
    fn a_category_copilot_doesnt_use_goes_and_the_preview_says_which() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        let other = account(&conn, "Brokerage", "cash");
        upsert_transactions(&conn, card, &[
            payee_txn("sf1", "2026-07-01", -12.5, "Zqx Diner"),
            payee_txn("poker", "2026-07-05", -20.0, "Zqx Poker Night"),
        ], &[]).unwrap();
        upsert_transactions(&conn, other, &[payee_txn("sub", "2026-07-06", -9.0, "Zqx Stream")], &[]).unwrap();
        conn.execute("INSERT INTO categories (name,kind) VALUES ('Poker','spending')", []).unwrap();
        // Chosen by hand, so the re-sort leaves them where they are.
        set_category(&conn, id_of(&conn, "poker"), seed::category_id(&conn, "Poker").unwrap(), false).unwrap();
        set_category(&conn, id_of(&conn, "sub"), seed::category_id(&conn, "Subscriptions").unwrap(), false).unwrap();
        let csv = export(&[
            copilot_row("2026-07-01", "Zqx Diner", "12.50", "Eating Out", "regular", "9849"),
            copilot_row("2026-07-20", "Later", "3", "Eating Out", "regular", "9849"),
        ]);
        let plan = copilot_plan(&conn, &csv);
        assert!(plan.deletions.contains(&"Poker".to_string()));
        assert!(plan.deletions.contains(&"Subscriptions".to_string()));
        assert_eq!(plan.uncategorised, 1, "the row in an account Copilot doesn't have");

        apply_copilot_plan(&conn, &plan).unwrap();

        assert_eq!(seed::category_id(&conn, "Poker").unwrap(), None);
        assert_eq!(seed::category_id(&conn, "Subscriptions").unwrap(), None);
        assert_eq!(row(&conn, "poker").0, None, "the row stays, removed and uncategorised");
        assert!(removed(&conn, "poker"), "Copilot doesn't have it, so it is removed without asking");
        assert_eq!(row(&conn, "sub"), (None, "auto".into(), false), "back to To review");
    }

    #[test]
    fn replacing_all_leaves_only_copilots_categories_and_deletes_no_row() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        let other = account(&conn, "Brokerage", "cash");
        upsert_transactions(&conn, card, &[
            payee_txn("sf1", "2026-07-01", -12.5, "Zqx Diner"),
            payee_txn("later", "2026-08-01", -4.0, "Zqx Later Thing"),
        ], &[]).unwrap();
        upsert_transactions(&conn, other, &[payee_txn("sub", "2026-07-06", -9.0, "Zqx Stream")], &[]).unwrap();
        let subs = seed::category_id(&conn, "Subscriptions").unwrap().unwrap();
        let travel = seed::category_id(&conn, "Travel").unwrap().unwrap();
        // Chosen by hand: one Copilot doesn't cover, one after the export.
        set_category(&conn, id_of(&conn, "sub"), Some(subs), false).unwrap();
        set_category(&conn, id_of(&conn, "later"), Some(subs), false).unwrap();
        conn.execute("INSERT INTO budgets (category_id, month, limit_amount) VALUES (?1, NULL, 100)", [travel]).unwrap();
        let csv = export(&[copilot_row("2026-07-01", "Zqx Diner", "12.50", "Eating Out", "regular", "9849")]);
        let plan = copilot_plan(&conn, &csv);
        assert!(plan.deletions.contains(&"Travel".to_string()), "a budget doesn't keep it");
        let rows_before: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();

        apply_copilot_plan(&conn, &plan).unwrap();

        let names: Vec<String> = conn.prepare("SELECT name FROM categories ORDER BY sort").unwrap()
            .query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(names, vec!["Eating Out".to_string()]);
        assert_eq!(row(&conn, "sf1").0.as_deref(), Some("Eating Out"));
        assert_eq!(row(&conn, "sub"), (None, "auto".into(), false), "back to To review");
        assert_eq!(row(&conn, "later"), (None, "auto".into(), false));
        let budgets: i64 = conn.query_row("SELECT count(*) FROM budgets", [], |r| r.get(0)).unwrap();
        assert_eq!(budgets, 0);
        let rows_after: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(rows_after, rows_before, "no transaction deleted");
    }

    #[test]
    fn clearing_categories_uncategorises_everything_and_deletes_no_row() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[
            payee_txn("a", "2026-07-01", -12.5, "Zqx Diner"),
            payee_txn("b", "2026-07-02", -30.0, "Zqx Shop"),
        ], &[]).unwrap();
        let dining = seed::category_id(&conn, "Dining").unwrap().unwrap();
        let shopping = seed::category_id(&conn, "Shopping").unwrap().unwrap();
        set_category(&conn, id_of(&conn, "a"), Some(dining), true).unwrap();
        set_splits(&conn, id_of(&conn, "b"), &[
            NewSplit { category_id: Some(dining), amount: -10.0, note: None },
            NewSplit { category_id: Some(shopping), amount: -20.0, note: None },
        ]).unwrap();
        conn.execute("INSERT INTO budgets (category_id, month, limit_amount) VALUES (?1, NULL, 100)", [dining]).unwrap();

        let gone = clear_categories(&conn).unwrap();

        assert!(gone > 0);
        let left: i64 = conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
        assert_eq!(row(&conn, "a"), (None, "auto".into(), false));
        let (rows, rules, budgets, pieces, uncategorised_pieces): (i64, i64, i64, i64, i64) = conn.query_row(
            "SELECT (SELECT count(*) FROM bank_transactions), (SELECT count(*) FROM category_rules),
                    (SELECT count(*) FROM budgets), (SELECT count(*) FROM bank_transaction_splits),
                    (SELECT count(*) FROM bank_transaction_splits WHERE category_id IS NULL)",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        ).unwrap();
        assert_eq!((rows, rules, budgets), (2, 0, 0));
        assert_eq!((pieces, uncategorised_pieces), (2, 2), "split pieces stay, uncategorised");
    }

    const COPILOT_HEADER: &str = "\"date\",\"name\",\"amount\",\"status\",\"category\",\"parent category\",\"excluded\",\"tags\",\"type\",\"account\",\"account mask\",\"note\",\"recurring\"";

    #[test]
    fn applying_a_plan_matches_adds_creates_and_learns() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner")], &[]).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-07-03\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"lunch\",\"\"\n\
            \"2026-01-05\",\"Haggin Oaks\",\"20\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-12\",\"Haggin Oaks\",\"25\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n");
        let plan = copilot_plan(&conn, &csv);

        let counts = apply_copilot_plan(&conn, &plan).unwrap();

        assert_eq!((counts.matched, counts.added), (1, 2));
        // Copilot's name: Tally's old Dining is renamed to it.
        assert_eq!(row(&conn, "sf1"), (Some("Eating Out".into()), "manual".into(), true));
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
    fn a_re_import_leaves_a_split_history_row_alone() {
        let conn = seeded();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-01-05\",\"Haggin Oaks\",\"-20\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n");
        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        let amount: f64 = conn.query_row("SELECT amount FROM bank_transactions WHERE id=?1", [id], |r| r.get(0)).unwrap();
        let half = amount / 2.0;
        set_splits(&conn, id, &[
            NewSplit { category_id: seed::category_id(&conn, "Groceries").unwrap(), amount: half, note: None },
            NewSplit { category_id: None, amount: half, note: None },
        ]).unwrap();

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        let category: Option<i64> = conn.query_row("SELECT category_id FROM bank_transactions WHERE id=?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(category, None, "the pieces own the category now");
        let n: i64 = conn.query_row("SELECT count(*) FROM bank_transaction_splits WHERE txn_id=?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn copilot_wins_over_a_category_chosen_in_tally() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        set_category(&conn, id, seed::category_id(&conn, "Groceries").unwrap(), false).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\"2026-07-03\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n");
        let plan = copilot_plan(&conn, &csv);
        assert_eq!(plan.recategorised, 1);

        apply_copilot_plan(&conn, &plan).unwrap();

        assert_eq!(row(&conn, "sf1"), (Some("Eating Out".into()), "manual".into(), true));
        let total: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 1, "matched, not added");
    }

    #[test]
    fn a_split_matched_row_is_left_alone() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner")], &[]).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -10.0), piece(&conn, None, -2.5)]).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\"2026-07-03\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n");

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        assert_eq!(row(&conn, "sf1").0, None, "the pieces own the category");
        // Copilot has no Groceries, so the piece keeps its amount but not that category.
        assert_eq!(splits_of(&conn, "sf1"), vec![(None, -10.0), (None, -2.5)]);
        assert!(conn.query_row("SELECT category_source='manual' FROM bank_transactions", [], |r| r.get::<_, bool>(0)).unwrap(),
            "still split, so the re-sort leaves it alone");
    }

    fn snapshot_of(conn: &Connection, ext: &str) -> (i64, Option<String>, f64, String, bool, bool) {
        conn.query_row(
            "SELECT b.id, c.name, b.amount, b.category_source, b.reviewed, b.removed
             FROM bank_transactions b LEFT JOIN categories c ON c.id=b.category_id WHERE b.external_id=?1",
            [ext], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0, r.get::<_, i64>(5)? != 0)),
        ).unwrap()
    }

    #[test]
    fn after_the_exports_newest_day_only_categories_change() {
        let conn = seeded();
        conn.execute("INSERT INTO categories (name,kind,sort) VALUES ('Shops','spending',500)", []).unwrap();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[
            payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner"),
            // After the export: a Target run in Shopping (merged into Shops),
            // a meal in Dining (renamed Eating Out), a trip in Travel, a golf
            // round the learned rule would re-sort, and a removed row.
            payee_txn("late-target", "2026-07-10", -30.0, "Target"),
            payee_txn("late-meal", "2026-07-11", -9.0, "Zqx Cafe"),
            payee_txn("late-trip", "2026-07-12", -200.0, "Zqx Air"),
            payee_txn("late-golf", "2026-07-13", -40.0, "Haggin Oaks"),
            payee_txn("late-gone", "2026-07-14", -5.0, "Zqx Gone"),
        ], &[]).unwrap();
        let set = |ext: &str, name: &str| conn.execute(
            "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name=?2) WHERE external_id=?1",
            params![ext, name],
        ).unwrap();
        set("late-target", "Shopping");
        set("late-meal", "Dining");
        set("late-trip", "Travel");
        set("late-golf", "Other");
        conn.execute("UPDATE bank_transactions SET removed=1, reviewed=1 WHERE external_id='late-gone'", []).unwrap();
        let before: Vec<_> = ["late-target", "late-meal", "late-trip", "late-golf", "late-gone"].iter().map(|e| snapshot_of(&conn, e)).collect();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-07-03\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n\
            \"2026-01-05\",\"Target\",\"20\",\"posted\",\"Shops\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-06\",\"Haggin Oaks\",\"20\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-07\",\"Haggin Oaks\",\"25\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n");
        let plan = copilot_plan(&conn, &csv);
        assert_eq!(plan.cutoff, "2026-07-03");
        assert_eq!(plan.untouched_after_cutoff, 5);

        apply_copilot_plan(&conn, &plan).unwrap();

        let after: Vec<_> = ["late-target", "late-meal", "late-trip", "late-golf", "late-gone"].iter().map(|e| snapshot_of(&conn, e)).collect();
        let renamed = |(id, cat, amount, source, reviewed, removed): &(i64, Option<String>, f64, String, bool, bool), name: Option<&str>| {
            (*id, name.map(str::to_string).or(cat.clone()), *amount, source.clone(), *reviewed, *removed)
        };
        assert_eq!(after[0], renamed(&before[0], Some("Shops")), "only the merge reaches it");
        assert_eq!(after[1], renamed(&before[1], Some("Eating Out")), "only the rename reaches it");
        // Copilot has no Travel or Other: the rows lose them, and the re-sort a
        // sync would do puts the golf round in Copilot's Golf by the learned rule.
        let blank = |s: &(i64, Option<String>, f64, String, bool, bool), cat: Option<&str>| (s.0, cat.map(str::to_string), s.2, s.3.clone(), s.4, s.5);
        assert_eq!(after[2], blank(&before[2], None));
        assert_eq!(after[3], blank(&before[3], Some("Golf")));
        assert_eq!(after[4], before[4], "removed stays removed");
        let total: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 9, "6 of Tally's plus 3 added, none deleted");
    }

    #[test]
    fn merging_moves_rows_pieces_rules_and_budgets_then_deletes_the_old_one() {
        let conn = seeded();
        conn.execute("INSERT INTO categories (name,kind) VALUES ('Eating Out','spending')", []).unwrap();
        let dining = seed::category_id(&conn, "Dining").unwrap().unwrap();
        let eating_out = seed::category_id(&conn, "Eating Out").unwrap().unwrap();
        let (_, costco_id) = costco(&conn);
        set_splits(&conn, costco_id, &[piece(&conn, Some("Dining"), -80.0), piece(&conn, None, -5.5)]).unwrap();
        let card = account(&conn, "Card 2", "credit");
        upsert_transactions(&conn, card, &[payee_txn("meal", "2026-10-04", -9.0, "Zqx Cafe")], &[]).unwrap();
        conn.execute("UPDATE bank_transactions SET category_id=?1 WHERE external_id='meal'", [dining]).unwrap();
        // A pattern has one rule whatever its category (UNIQUE match_type,
        // pattern), so moving rules can never collide.
        for (match_type, pattern) in [("payee", "zqx cafe"), ("payee", "both"), ("description", "both")] {
            conn.execute(
                "INSERT INTO category_rules (match_type,pattern,category_id,created_at) VALUES (?1,?2,?3,'x')",
                params![match_type, pattern, dining],
            ).unwrap();
        }
        for (cat, month, limit) in [(dining, Some("2026-10"), 100.0), (dining, Some("2026-09"), 90.0), (eating_out, Some("2026-10"), 50.0), (dining, None, 70.0), (eating_out, None, 60.0)] {
            conn.execute("INSERT INTO budgets (category_id,month,limit_amount) VALUES (?1,?2,?3)", params![cat, month, limit]).unwrap();
        }

        merge_category(&conn, dining, eating_out).unwrap();

        assert_eq!(seed::category_id(&conn, "Dining").unwrap(), None);
        assert_eq!(row(&conn, "meal").0.as_deref(), Some("Eating Out"));
        assert_eq!(splits_of(&conn, "c1")[0], (Some("Eating Out".into()), -80.0));
        let rules: Vec<(String, String, i64)> = conn.prepare("SELECT match_type, pattern, category_id FROM category_rules ORDER BY match_type, pattern").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(rules, vec![
            ("description".into(), "both".into(), eating_out),
            ("payee".into(), "both".into(), eating_out),
            ("payee".into(), "zqx cafe".into(), eating_out),
        ]);
        let budgets: Vec<(Option<String>, f64)> = conn.prepare("SELECT month, limit_amount FROM budgets WHERE category_id=?1 ORDER BY month").unwrap()
            .query_map([eating_out], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(budgets, vec![(None, 60.0), (Some("2026-09".into()), 90.0), (Some("2026-10".into()), 50.0)], "the target's own budget wins");
        let left: i64 = conn.query_row("SELECT count(*) FROM budgets", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 3);
    }

    #[test]
    fn merging_into_a_name_that_does_not_exist_renames_and_keeps_the_id() {
        let conn = seeded();
        let dining = seed::category_id(&conn, "Dining").unwrap().unwrap();
        let card = account(&conn, "Card", "credit");
        upsert_transactions(&conn, card, &[payee_txn("meal", "2026-10-04", -9.0, "Zqx Cafe")], &[]).unwrap();
        conn.execute("UPDATE bank_transactions SET category_id=?1 WHERE external_id='meal'", [dining]).unwrap();

        merge_into_name(&conn, "Dining", "Eating Out").unwrap();

        assert_eq!(seed::category_id(&conn, "Eating Out").unwrap(), Some(dining));
        assert_eq!(row(&conn, "meal").0.as_deref(), Some("Eating Out"));
    }

    fn category_names(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM categories ORDER BY sort, id").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    #[test]
    fn an_import_leaves_exactly_copilots_categories() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[
            payee_txn("sf1", "2026-07-02", -12.5, "Zqx Diner"),
            payee_txn("late", "2026-08-01", -50.0, "Zqx Air"),
        ], &[]).unwrap();
        conn.execute("UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Travel') WHERE external_id='late'", []).unwrap();
        let health = seed::category_id(&conn, "Health").unwrap().unwrap();
        conn.execute("INSERT INTO budgets (category_id,month,limit_amount) VALUES (?1,NULL,40)", [health]).unwrap();
        let fees = seed::category_id(&conn, "Fees").unwrap().unwrap();
        conn.execute("INSERT INTO category_rules (match_type,pattern,category_id,created_at) VALUES ('payee','zqx fee',?1,'x')", [fees]).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-07-03\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n\
            \"2026-01-05\",\"Range\",\"20\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-06\",\"Range\",\"20\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-07\",\"To savings\",\"-200\",\"posted\",\"\",\"\",\"false\",\"\",\"internal transfer\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-08\",\"Odd\",\"3\",\"posted\",\"Groceries\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n");
        let plan = copilot_plan(&conn, &csv);

        apply_copilot_plan(&conn, &plan).unwrap();

        // Copilot's, most used first (Golf twice), then the system category.
        // Travel goes though a row after the cutoff holds it, Health though a
        // budget does.
        assert_eq!(category_names(&conn), vec!["Golf", "Eating Out", "Groceries", "Internal transfer"]);
        let mut deleted = plan.deletions.clone();
        deleted.sort();
        assert_eq!(deleted, vec!["Entertainment", "Fees", "Fuel", "Health", "Income", "Other", "Rent & Mortgage", "Shopping", "Subscriptions", "Transport", "Travel", "Utilities"],
            "the preview names exactly what goes");
        assert_eq!(plan.uncategorised, 1, "the Travel row after the cutoff");
        assert_eq!(row(&conn, "late"), (None, "auto".into(), false));
        let rules: i64 = conn.query_row("SELECT count(*) FROM category_rules WHERE pattern='zqx fee'", [], |r| r.get(0)).unwrap();
        assert_eq!(rules, 0, "a deleted category's rules go with it");
    }

    #[test]
    fn categories_get_distinct_colours_in_copilots_order() {
        let conn = db::open_in_memory().unwrap();
        let mut rows = String::new();
        // 13 categories, the first used 13 times, the next 12, and so on.
        for i in 0..13 {
            for n in 0..(13 - i) {
                rows.push_str(&format!("\"2026-01-{:02}\",\"P{i}\",\"{n}.5\",\"posted\",\"C{i:02}\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n", n + 1));
            }
        }
        rows.push_str("\"2026-01-20\",\"Pay\",\"-900\",\"posted\",\"\",\"\",\"false\",\"\",\"income\",\"\",\"\",\"\",\"\"\n");
        let csv = format!("{COPILOT_HEADER}\n{rows}");

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        let got: Vec<(String, String, i64)> = conn.prepare("SELECT name, colour, sort FROM categories ORDER BY sort").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect();
        let names: Vec<&str> = got.iter().map(|g| g.0.as_str()).collect();
        let mut expected: Vec<String> = (0..13).map(|i| format!("C{i:02}")).collect();
        expected.push("Income".into());
        assert_eq!(names, expected);
        let colours: Vec<&str> = got.iter().map(|g| g.1.as_str()).collect();
        assert_eq!(&colours[..12], &(1..=12).map(|n| format!("cat-{n}")).collect::<Vec<_>>()[..]);
        assert_eq!(&colours[12..], &["cat-1", "cat-2"], "wrapping only past 12");
        assert!(got.windows(2).all(|w| w[0].2 < w[1].2));
    }

    #[test]
    fn the_categories_count_includes_system_ones_the_import_made() {
        let conn = db::open_in_memory().unwrap();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-01-05\",\"To savings\",\"-200\",\"posted\",\"\",\"\",\"false\",\"\",\"internal transfer\",\"\",\"\",\"\",\"\"\n\
            \"2026-01-06\",\"Range\",\"20\",\"posted\",\"Golf\",\"\",\"false\",\"\",\"regular\",\"\",\"\",\"\",\"\"\n");
        let counts = apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();
        assert_eq!(counts.categories, 2);
    }

    #[test]
    fn the_import_removes_every_row_copilot_doesnt_have_and_no_other() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[
            payee_txn("kept", "2026-07-01", -12.5, "Zqx Diner"),
            payee_txn("paidback", "2026-07-04", 40.0, "Transfer from Apple Pay"),
            payee_txn("other", "2026-07-05", 7.0, "Zqx Refund"),
        ], &[]).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\
            \"2026-07-01\",\"Zqx Diner\",\"12.50\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n\
            \"2026-07-20\",\"Later\",\"3\",\"posted\",\"Other\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n");
        let plan = copilot_plan(&conn, &csv);
        assert_eq!(plan.not_in_copilot.len(), 2);

        let counts = apply_copilot_plan(&conn, &plan).unwrap();

        assert_eq!(counts.removed, 2);
        assert!(removed(&conn, "paidback"));
        assert!(removed(&conn, "other"));
        assert!(!removed(&conn, "kept"), "Copilot has it");
    }

    #[test]
    fn copilots_name_shows_and_a_sync_never_overwrites_it() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-01", -12.5, "SQ *ZQX DINER 123")], &[]).unwrap();
        let csv = export(&[copilot_row("2026-07-01", "Zqx Diner", "12.50", "Eating Out", "regular", "9849")]);

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();
        upsert_transactions(&conn, card, &[payee_txn("sf1", "2026-07-01", -12.5, "SQ *ZQX DINER 999")], &[]).unwrap();

        let (name, payee): (String, String) = conn.query_row(
            "SELECT COALESCE(name, payee), payee FROM bank_transactions WHERE external_id='sf1'", [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(name, "Zqx Diner");
        assert_eq!(payee, "SQ *ZQX DINER 999", "the bank's own text is still kept");
    }

    #[test]
    fn a_row_the_bank_has_differently_is_replaced_by_copilots() {
        // Copilot holds the purchase at $12.50 with the tip; the bank's record
        // says $10. Copilot's goes in, the bank's is removed.
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[
            payee_txn("first", "2026-07-01", -5.0, "Zqx First"),
            payee_txn("tipless", "2026-07-05", -10.0, "Zqx Bistro"),
        ], &[]).unwrap();
        let csv = export(&[
            copilot_row("2026-07-01", "Zqx First", "5", "Eating Out", "regular", "9849"),
            copilot_row("2026-07-05", "Zqx Bistro", "12.50", "Eating Out", "regular", "9849"),
            copilot_row("2026-07-20", "Later", "1", "Eating Out", "regular", "9849"),
        ]);

        let counts = apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        assert_eq!((counts.matched, counts.added, counts.removed), (1, 2, 1));
        assert!(removed(&conn, "tipless"));
        let live: Vec<(String, f64)> = conn.prepare(
            "SELECT COALESCE(name, payee), amount FROM bank_transactions WHERE removed=0 ORDER BY posted",
        ).unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect();
        assert_eq!(live, vec![("Zqx First".into(), -5.0), ("Zqx Bistro".into(), -12.5), ("Later".into(), -1.0)]);
    }

    #[test]
    fn an_excluded_row_shows_in_excluded_and_never_counts_as_spending() {
        let conn = seeded();
        // The owner's own Excluded, made as spending: the import puts it right.
        conn.execute("INSERT INTO categories (name,kind) VALUES ('Excluded','spending')", []).unwrap();
        // Paid back: excluded on its own, among Concerts rows that count.
        let excluded = copilot_row("2026-01-05", "Zqx Concert", "80", "Concerts", "regular", "")
            .replace("\"false\"", "\"true\"");
        let csv = export(&[
            excluded,
            copilot_row("2026-01-07", "Zqx Gig", "30", "Concerts", "regular", ""),
            copilot_row("2026-01-06", "Range", "20", "Golf", "regular", ""),
        ]);

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        let (category, kind, gone): (String, String, i64) = conn.query_row(
            "SELECT c.name, c.kind, b.removed FROM bank_transactions b JOIN categories c ON c.id=b.category_id
             WHERE b.description='Zqx Concert'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!((category.as_str(), kind.as_str(), gone), ("Excluded", "transfer", 0));
        assert!(category_names(&conn).contains(&"Concerts".to_string()), "its own category is Copilot's too");
    }

    fn kind_of(conn: &Connection, name: &str) -> String {
        conn.query_row("SELECT kind FROM categories WHERE name=?1", [name], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_category_copilot_excludes_whole_keeps_its_rows_and_stops_counting() {
        let conn = seeded();
        conn.execute("INSERT INTO categories (name,kind) VALUES ('Car','spending')", []).unwrap();
        let excluded = |r: String| r.replace("\"false\"", "\"true\"");
        let csv = export(&[
            excluded(copilot_row("2026-01-05", "Zqx Smog", "40", "Car", "regular", "")),
            // Copilot marks every paycheck excluded: still income.
            excluded(copilot_row("2026-01-09", "Target Payroll", "-500", "", "income", "")),
            copilot_row("2026-01-06", "Range", "20", "Golf", "regular", ""),
        ]);

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        let filed = |d: &str| -> String {
            conn.query_row("SELECT c.name FROM bank_transactions b JOIN categories c ON c.id=b.category_id
                            WHERE b.description=?1", [d], |r| r.get(0)).unwrap()
        };
        assert_eq!(filed("Zqx Smog"), "Car");
        assert_eq!(kind_of(&conn, "Car"), "transfer", "doesn't count as spending, as in Copilot");
        assert_eq!(filed("Target Payroll"), "Income");
        assert_eq!(kind_of(&conn, "Golf"), "spending");

        // Counted in Copilot again: counted here again.
        let counted = export(&[copilot_row("2026-01-05", "Zqx Smog", "40", "Car", "regular", "")]);
        apply_copilot_plan(&conn, &copilot_plan(&conn, &counted)).unwrap();
        assert_eq!(kind_of(&conn, "Car"), "spending");
    }

    #[test]
    fn a_re_import_brings_back_a_copilot_row_removed_in_tally() {
        let conn = seeded();
        let csv = export(&[copilot_row("2026-01-05", "Old Diner", "8", "Eating Out", "regular", "")]);
        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();
        conn.execute("UPDATE bank_transactions SET removed=1", []).unwrap();

        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        let gone: i64 = conn.query_row("SELECT removed FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0, "Copilot has it, so it shows");
    }

    #[test]
    fn a_sync_adopts_an_imported_row_instead_of_duplicating_it() {
        let conn = seeded();
        let card = account(&conn, "Card (9849)", "credit");
        upsert_transactions(&conn, card, &[payee_txn("sf-new", "2026-07-02", -1.0, "Zqx")], &[]).unwrap();
        let csv = format!("{COPILOT_HEADER}\n\"2026-01-05\",\"Old Diner\",\"8\",\"posted\",\"Eating Out\",\"\",\"false\",\"\",\"regular\",\"Adv\",\"9849\",\"\",\"\"\n");
        apply_copilot_plan(&conn, &copilot_plan(&conn, &csv)).unwrap();

        // "Import 2 years" later brings SimpleFIN's own copy of that purchase.
        upsert_transactions(&conn, card, &[payee_txn("sf-old", "2026-01-06", -8.0, "Old Diner Inc")], &[]).unwrap();

        let rows: i64 = conn.query_row("SELECT count(*) FROM bank_transactions WHERE amount=-8", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        assert_eq!(row(&conn, "sf-old").0.as_deref(), Some("Eating Out"), "the owner's category survives");
    }
}
