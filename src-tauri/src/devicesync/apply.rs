//! Applying one change from the other computer. Rows are found by key, never
//! by local id. Runs inside `pull::apply_all`, which silences the triggers.
use super::clock;
use super::files::Change;
use rusqlite::types::Value as Sql;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    /// Something newer for this field is already here.
    Stale,
    /// The row it is about is not on this computer yet, usually a bank
    /// transaction this computer's SimpleFIN sync has not fetched. Kept and
    /// retried.
    Waiting,
}

pub fn apply(conn: &Connection, device: &str, c: &Change) -> rusqlite::Result<Outcome> {
    if !clock::is_newer(conn, &c.tbl, &c.key, &c.field, c.at, device)? {
        return Ok(Outcome::Stale);
    }
    let landed = match c.tbl.as_str() {
        "accounts" => accounts(conn, c)?,
        "categories" => categories(conn, c)?,
        "bank_transactions" => bank_transactions(conn, device, c)?,
        "category_rules" => rules(conn, c)?,
        "budgets" => budgets(conn, c)?,
        "transactions" => transactions(conn, c)?,
        // A table this build does not know. Files from a newer schema are set
        // aside before reaching here, so this is only ever a retired table.
        _ => true,
    };
    if !landed {
        return Ok(Outcome::Waiting);
    }
    clock::record(conn, &c.tbl, &c.key, &c.field, c.at, device)?;
    Ok(Outcome::Applied)
}

/// A JSON scalar as an SQL value.
fn sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => Sql::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn field(v: &Value, name: &str) -> Sql {
    sql(v.get(name).unwrap_or(&Value::Null))
}

/// A row changed key: its clock, unsent edits and held-back changes follow it,
/// or they would point at a key that no longer exists. `OR REPLACE` because the
/// new key may already have entries, and then the moved row replaces them, not
/// necessarily the newest one. That only happens when two keys merge, and at
/// worst one stale clock entry stays, so it is accepted.
fn rekey(conn: &Connection, tbl: &str, old: &str, new: &str) -> rusqlite::Result<()> {
    for t in ["sync_clock", "sync_outbox", "sync_pending"] {
        conn.execute(
            &format!("UPDATE OR REPLACE {t} SET key=?1 WHERE tbl=?2 AND key=?3"),
            params![new, tbl, old],
        )?;
    }
    if tbl == "categories" {
        // Budget keys start with the category key. Compared with substr, not
        // LIKE: names can contain % and _.
        for t in ["sync_clock", "sync_outbox", "sync_pending"] {
            conn.execute(
                &format!(
                    "UPDATE OR REPLACE {t} SET key = ?1 || substr(key, length(?2) + 1)
                     WHERE tbl='budgets' AND substr(key, 1, length(?2) + 1) = ?2 || '|'"
                ),
                params![new, old],
            )?;
        }
    }
    Ok(())
}

fn id_by_key(conn: &Connection, table: &'static str, key: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row(&format!("SELECT id FROM {table} WHERE sync_key=?1"), [key], |r| r.get(0))
        .optional()
}

/// A category reference: `Ok(Some(None))` for none, `Ok(None)` when the
/// category has not reached this computer yet.
fn category_ref(conn: &Connection, v: Option<&Value>) -> rusqlite::Result<Option<Option<i64>>> {
    match v.and_then(Value::as_str) {
        None => Ok(Some(None)),
        Some(key) => Ok(id_by_key(conn, "categories", key)?.map(Some)),
    }
}

fn accounts(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            conn.execute("DELETE FROM accounts WHERE sync_key=?1 AND source='manual'", [&c.key])?;
            Ok(true)
        }
        "_row" => {
            if id_by_key(conn, "accounts", &c.key)?.is_none() {
                let v = &c.value;
                conn.execute(
                    "INSERT INTO accounts (name, type, institution, currency, created_at, hidden, source, sync_key)
                     VALUES (?1, ?2, ?3, coalesce(?4, 'USD'), ?5, coalesce(?6, 0), 'manual', ?7)",
                    params![field(v, "name"), field(v, "type"), field(v, "institution"), field(v, "currency"),
                            field(v, "created_at"), field(v, "hidden"), c.key],
                )?;
            }
            Ok(true)
        }
        name @ ("type" | "hidden" | "name" | "institution" | "currency") => {
            let n = conn.execute(&format!("UPDATE accounts SET {name}=?1 WHERE sync_key=?2"), params![sql(&c.value), c.key])?;
            Ok(n > 0)
        }
        _ => Ok(true),
    }
}

fn categories(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            conn.execute("DELETE FROM categories WHERE sync_key=?1", [&c.key])?;
            Ok(true)
        }
        "_row" => {
            if id_by_key(conn, "categories", &c.key)?.is_some() {
                return Ok(true);
            }
            let v = &c.value;
            let Some(name) = v.get("name").and_then(Value::as_str) else { return Ok(true) };
            let namesake: Option<(i64, String)> = conn
                .query_row("SELECT id, sync_key FROM categories WHERE name=?1", [name], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()?;
            if let Some((id, local_key)) = namesake {
                // Both computers made a category with this name before sync.
                // Only a row whose key was made from this name is that twin; one
                // renamed into the name is a different category, so wait.
                let own = format!("cat:{name}");
                if local_key != own && !local_key.starts_with(&format!("{own}:")) {
                    return Ok(false);
                }
                // Both sides run this with the other's key, so both must pick
                // the same winner: the smaller key. If ours is smaller, the
                // other computer adopts it when our row reaches it.
                // The merged row keeps its local colour and sort, which is
                // accepted. Category references inside other tables' JSON values
                // are not rewritten either; those only exist for edits made
                // while a round runs, and are accepted.
                if c.key < local_key {
                    conn.execute("UPDATE categories SET sync_key=?1 WHERE id=?2", params![c.key, id])?;
                    rekey(conn, "categories", &local_key, &c.key)?;
                }
            } else {
                conn.execute(
                    "INSERT INTO categories (name, kind, colour, sort, is_builtin, sync_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![field(v, "name"), field(v, "kind"), field(v, "colour"), field(v, "sort"),
                            field(v, "is_builtin"), c.key],
                )?;
            }
            Ok(true)
        }
        name @ ("name" | "colour" | "sort") => {
            if name == "name" {
                // A different category already has this name: wait rather than
                // fail on the UNIQUE constraint.
                let taken: i64 = conn.query_row(
                    "SELECT count(*) FROM categories WHERE name=?1 AND sync_key<>?2",
                    params![sql(&c.value), c.key],
                    |r| r.get(0),
                )?;
                if taken > 0 {
                    return Ok(false);
                }
            }
            let n = conn.execute(&format!("UPDATE categories SET {name}=?1 WHERE sync_key=?2"), params![sql(&c.value), c.key])?;
            Ok(n > 0)
        }
        _ => Ok(true),
    }
}

fn bank_transactions(conn: &Connection, device: &str, c: &Change) -> rusqlite::Result<bool> {
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            // Never a SimpleFIN row: only Copilot history or a manual account's
            // rows are ever the owner's to delete.
            conn.execute(
                "DELETE FROM bank_transactions WHERE sync_key=?1
                   AND (external_id LIKE 'copilot:%'
                        OR account_id IN (SELECT id FROM accounts WHERE source='manual'))",
                [&c.key],
            )?;
            Ok(true)
        }
        "_row" => insert_bank_row(conn, device, c),
        "category" => {
            let pair = c.value.as_array();
            let source = pair.and_then(|p| p.get(1)).and_then(Value::as_str).unwrap_or("manual");
            if source == "auto" {
                // Back to automatic: this computer's own re-sort, which runs at
                // the end of the pull, picks the category.
                let n = conn.execute("UPDATE bank_transactions SET category_source='auto' WHERE sync_key=?1", [&c.key])?;
                return Ok(n > 0);
            }
            let Some(category) = category_ref(conn, pair.and_then(|p| p.first()))? else { return Ok(false) };
            let n = conn.execute(
                "UPDATE bank_transactions SET category_id=?1, category_source='manual' WHERE sync_key=?2",
                params![category, c.key],
            )?;
            Ok(n > 0)
        }
        name @ ("note" | "reviewed" | "removed") => {
            let n = conn.execute(
                &format!("UPDATE bank_transactions SET {name}=?1 WHERE sync_key=?2"),
                params![sql(&c.value), c.key],
            )?;
            Ok(n > 0)
        }
        _ => Ok(true),
    }
}

/// A row SimpleFIN cannot supply here: a manual account's, or Copilot history.
fn insert_bank_row(conn: &Connection, device: &str, c: &Change) -> rusqlite::Result<bool> {
    if id_by_key(conn, "bank_transactions", &c.key)?.is_some() {
        return Ok(true);
    }
    let v = &c.value;
    let Some(account_id) = v.get("account").and_then(Value::as_str).map(|k| id_by_key(conn, "accounts", k)).transpose()?.flatten()
    else { return Ok(false) };
    let Some(category) = category_ref(conn, v.get("category"))? else { return Ok(false) };
    let external_id = v.get("external_id").and_then(Value::as_str).unwrap_or_default();

    if external_id.starts_with("copilot:") {
        // This computer may already hold the bank's own copy of the purchase:
        // its sync had nothing to adopt because the Copilot row had not
        // arrived yet. Take that row over rather than adding a duplicate, with
        // the same match the sync uses to adopt.
        let twin: Option<i64> = conn
            .query_row(
                "SELECT id FROM bank_transactions
                 WHERE account_id=?1 AND external_id NOT LIKE 'copilot:%'
                   AND sync_key NOT LIKE '%|copilot:%'
                   AND pending = 0
                   -- the other computer already shows it holds this row apart
                   AND NOT EXISTS (SELECT 1 FROM sync_clock k
                                   WHERE k.tbl='bank_transactions' AND k.key=bank_transactions.sync_key AND k.device=?4)
                   AND NOT EXISTS (SELECT 1 FROM sync_pending p
                                   WHERE p.tbl='bank_transactions' AND p.key=bank_transactions.sync_key)
                   AND CAST(ROUND(amount*100) AS INTEGER) = CAST(ROUND(?2*100) AS INTEGER)
                   AND ABS(julianday(posted) - julianday(?3)) <= 3
                 ORDER BY ABS(julianday(posted) - julianday(?3)) LIMIT 1",
                params![account_id, field(v, "amount"), field(v, "posted"), device],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = twin {
            let old_key: String = conn.query_row("SELECT sync_key FROM bank_transactions WHERE id=?1", [id], |r| r.get(0))?;
            // The owner's own edits on the local row win, as in the Copilot import.
            conn.execute(
                "UPDATE bank_transactions SET sync_key=?1,
                   category_id = CASE WHEN category_source='manual' THEN category_id ELSE ?2 END,
                   category_source = CASE WHEN category_source='manual' THEN 'manual' ELSE coalesce(?3,'manual') END,
                   reviewed = MAX(reviewed, coalesce(?4,0)),
                   note = COALESCE(note, ?5),
                   removed = MAX(removed, coalesce(?6,0))
                 WHERE id=?7",
                params![c.key, category, field(v, "category_source"), field(v, "reviewed"),
                        field(v, "note"), field(v, "removed"), id],
            )?;
            rekey(conn, "bank_transactions", &old_key, &c.key)?;
            return Ok(true);
        }
    }
    conn.execute(
        "INSERT INTO bank_transactions
           (account_id, external_id, posted, amount, description, payee, memo,
            category_id, category_source, reviewed, note, removed, sync_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, coalesce(?9, 'manual'), coalesce(?10, 0), ?11, coalesce(?12, 0), ?13)",
        params![account_id, external_id, field(v, "posted"), field(v, "amount"), field(v, "description"),
                field(v, "payee"), field(v, "memo"), category, field(v, "category_source"),
                field(v, "reviewed"), field(v, "note"), field(v, "removed"), c.key],
    )?;
    Ok(true)
}

fn rules(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    let Some((match_type, pattern)) = c.key.split_once(':') else { return Ok(true) };
    match c.field.as_str() {
        "_row" if c.value.is_null() => {
            conn.execute("DELETE FROM category_rules WHERE match_type=?1 AND pattern=?2", params![match_type, pattern])?;
            Ok(true)
        }
        "_row" | "category" => {
            let reference = if c.field == "_row" { c.value.get("category") } else { Some(&c.value) };
            let Some(category) = category_ref(conn, reference)? else { return Ok(false) };
            let Some(category_id) = category else { return Ok(true) }; // a rule needs a category
            let created_at = c.value.get("created_at").and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
            conn.execute(
                "INSERT INTO category_rules (match_type, pattern, category_id, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(match_type, pattern) DO UPDATE SET category_id=excluded.category_id",
                params![match_type, pattern, category_id, created_at],
            )?;
            Ok(true)
        }
        _ => Ok(true),
    }
}

fn budgets(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    let Some((category_key, month)) = c.key.rsplit_once('|') else { return Ok(true) };
    let month = if month == "*" { None } else { Some(month) };
    let deleting = c.field == "_row" && c.value.is_null();
    let Some(category_id) = id_by_key(conn, "categories", category_key)? else {
        // Nothing to delete without the category; anything else waits for it.
        return Ok(deleting);
    };
    if deleting {
        conn.execute("DELETE FROM budgets WHERE category_id=?1 AND month IS ?2", params![category_id, month])?;
        return Ok(true);
    }
    let amount = if c.field == "_row" { c.value.get("limit_amount") } else { Some(&c.value) };
    let Some(amount) = amount.and_then(Value::as_f64) else { return Ok(true) };
    // NULL months are distinct to a UNIQUE index, so no ON CONFLICT: update,
    // else insert, as `budget_set` does.
    let n = conn.execute(
        "UPDATE budgets SET limit_amount=?1 WHERE category_id=?2 AND month IS ?3",
        params![amount, category_id, month],
    )?;
    if n == 0 {
        if c.field != "_row" {
            // An edit to a budget that is gone: if a newer create or delete of
            // the whole budget is on record, the edit is moot, and inserting
            // would bring a deleted budget back.
            let row_at: Option<i64> = conn
                .query_row(
                    "SELECT at FROM sync_clock WHERE tbl='budgets' AND key=?1 AND field='_row'",
                    [&c.key],
                    |r| r.get(0),
                )
                .optional()?;
            if row_at.is_some_and(|at| at > c.at) {
                return Ok(true);
            }
        }
        conn.execute(
            "INSERT INTO budgets (category_id, month, limit_amount) VALUES (?1, ?2, ?3)",
            params![category_id, month, amount],
        )?;
    }
    Ok(true)
}

fn transactions(conn: &Connection, c: &Change) -> rusqlite::Result<bool> {
    if c.field != "_row" {
        return Ok(true);
    }
    if c.value.is_null() {
        conn.execute("DELETE FROM transactions WHERE sync_key=?1", [&c.key])?;
        return Ok(true);
    }
    if id_by_key(conn, "transactions", &c.key)?.is_some() {
        return Ok(true);
    }
    let v = &c.value;
    let Some(account_id) = v.get("account").and_then(Value::as_str).map(|k| id_by_key(conn, "accounts", k)).transpose()?.flatten()
    else { return Ok(false) };
    let security_id: Option<i64> = match v.get("security").filter(|s| !s.is_null()) {
        None => None,
        Some(s) => {
            conn.execute(
                "INSERT INTO securities (ticker, name, type, currency) VALUES (?1, ?2, ?3, coalesce(?4, 'USD'))
                 ON CONFLICT(ticker) DO NOTHING",
                params![field(s, "ticker"), field(s, "name"), field(s, "type"), field(s, "currency")],
            )?;
            Some(conn.query_row("SELECT id FROM securities WHERE ticker=?1", [field(s, "ticker")], |r| r.get(0))?)
        }
    };
    conn.execute(
        "INSERT INTO transactions (account_id, security_id, type, date, quantity, price, amount, fees, note, sync_key)
         VALUES (?1, ?2, ?3, ?4, coalesce(?5, 0), coalesce(?6, 0), coalesce(?7, 0), coalesce(?8, 0), ?9, ?10)",
        params![account_id, security_id, field(v, "type"), field(v, "date"), field(v, "quantity"),
                field(v, "price"), field(v, "amount"), field(v, "fees"), field(v, "note"), c.key],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::devicesync::meta;
    use serde_json::json;

    /// A database as `pull` leaves it while applying: recording on, but silenced.
    fn applying() -> Connection {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        meta::enable(&conn, "laptop").unwrap();
        meta::set(&conn, "applying", "1").unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'TRN-1','2026-10-01',-5,'Coffee');",
        )
        .unwrap();
        conn
    }

    fn change(tbl: &str, key: &str, field: &str, value: Value, at: i64) -> Change {
        Change { tbl: tbl.into(), key: key.into(), field: field.into(), value, at }
    }

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_category_chosen_on_the_other_computer_lands_on_the_same_bank_row() {
        let conn = applying();
        let c = change("bank_transactions", "sf:ACT-1|TRN-1", "category", json!(["cat:Dining", "manual"]), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        let (name, source): (String, String) = conn
            .query_row(
                "SELECT c.name, b.category_source FROM bank_transactions b JOIN categories c ON c.id=b.category_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((name.as_str(), source.as_str()), ("Dining", "manual"));
        assert_eq!(conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get::<_, i64>(0)).unwrap(), 0,
            "applied changes are not echoed back");
    }

    #[test]
    fn an_older_change_does_not_overwrite_a_newer_one() {
        let conn = applying();
        apply(&conn, "pc", &change("bank_transactions", "sf:ACT-1|TRN-1", "note", json!("new"), 20)).unwrap();
        let older = change("bank_transactions", "sf:ACT-1|TRN-1", "note", json!("old"), 10);
        assert_eq!(apply(&conn, "pc", &older).unwrap(), Outcome::Stale);
        assert_eq!(one::<String>(&conn, "SELECT note FROM bank_transactions"), "new");
    }

    #[test]
    fn a_change_for_a_transaction_not_fetched_here_yet_waits() {
        let conn = applying();
        let c = change("bank_transactions", "sf:ACT-1|TRN-2", "reviewed", json!(1), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Waiting);
    }

    #[test]
    fn a_manual_account_is_created_with_its_key_then_deleted() {
        let conn = applying();
        let row = json!({"name":"Cash jar","type":"cash","institution":null,"currency":"USD","created_at":"2026-01-01","hidden":0});
        apply(&conn, "pc", &change("accounts", "acct:abc", "_row", row, 10)).unwrap();
        assert_eq!(one::<String>(&conn, "SELECT name FROM accounts WHERE sync_key='acct:abc'"), "Cash jar");
        apply(&conn, "pc", &change("accounts", "acct:abc", "_row", Value::Null, 11)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM accounts WHERE sync_key='acct:abc'"), 0);
    }

    #[test]
    fn hiding_an_account_reaches_the_same_simplefin_account() {
        let conn = applying();
        apply(&conn, "pc", &change("accounts", "sf:ACT-1", "hidden", json!(1), 10)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT hidden FROM accounts WHERE id=1"), 1);
    }

    #[test]
    fn a_budget_is_set_changed_and_cleared() {
        let conn = applying();
        apply(&conn, "pc", &change("budgets", "cat:Groceries|2026-10", "_row", json!({"limit_amount": 400.0}), 10)).unwrap();
        apply(&conn, "pc", &change("budgets", "cat:Groceries|2026-10", "limit_amount", json!(450.0), 11)).unwrap();
        assert_eq!(one::<f64>(&conn, "SELECT limit_amount FROM budgets WHERE month='2026-10'"), 450.0);
        apply(&conn, "pc", &change("budgets", "cat:Groceries|2026-10", "_row", Value::Null, 12)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM budgets"), 0);
    }

    #[test]
    fn an_every_month_budget_is_stored_with_no_month() {
        let conn = applying();
        apply(&conn, "pc", &change("budgets", "cat:Groceries|*", "_row", json!({"limit_amount": 400.0}), 10)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM budgets WHERE month IS NULL"), 1);
    }

    #[test]
    fn a_rule_is_created_against_the_right_category() {
        let conn = applying();
        let row = json!({"match_type":"payee","pattern":"blue bottle","category":"cat:Dining","created_at":"2026-10-16"});
        apply(&conn, "pc", &change("category_rules", "payee:blue bottle", "_row", row, 10)).unwrap();
        assert_eq!(
            one::<String>(&conn, "SELECT c.name FROM category_rules r JOIN categories c ON c.id=r.category_id"),
            "Dining"
        );
    }

    #[test]
    fn a_new_category_is_created_and_a_namesake_here_is_merged_not_duplicated() {
        let conn = applying();
        let golf = json!({"name":"Golf","kind":"spending","colour":"chart-3","sort":200,"is_builtin":0});
        apply(&conn, "pc", &change("categories", "cat:Golf", "_row", golf, 10)).unwrap();
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM categories WHERE name='Golf'"), "cat:Golf");

        // Both computers once created "Dining" on their own, under different keys.
        let dining = json!({"name":"Dining","kind":"spending","colour":"chart-2","sort":20,"is_builtin":1});
        apply(&conn, "pc", &change("categories", "cat:Dining:ab12cd34", "_row", dining, 11)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM categories WHERE name='Dining'"), 1);
        // "cat:Dining" sorts before "cat:Dining:ab12cd34", so the key here wins.
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM categories WHERE name='Dining'"), "cat:Dining");
    }

    fn dining_row() -> Value {
        json!({"name":"Dining","kind":"spending","colour":"chart-2","sort":20,"is_builtin":1})
    }

    fn local_dining_key(conn: &Connection, key: &str) {
        conn.execute("UPDATE categories SET sync_key=?1 WHERE name='Dining'", [key]).unwrap();
    }

    #[test]
    fn a_category_namesake_merge_keeps_the_smaller_key_whichever_side_applies_it() {
        // Larger remote key: ours stays.
        let conn = applying();
        local_dining_key(&conn, "cat:Dining:5555");
        let c = change("categories", "cat:Dining:9999", "_row", dining_row(), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM categories WHERE name='Dining'"), "cat:Dining:5555");
        // Smaller remote key: we adopt it.
        let conn = applying();
        local_dining_key(&conn, "cat:Dining:5555");
        let c = change("categories", "cat:Dining:1111", "_row", dining_row(), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM categories WHERE name='Dining'"), "cat:Dining:1111");
    }

    #[test]
    fn a_category_renamed_into_the_name_is_not_taken_over() {
        let conn = applying();
        conn.execute("UPDATE categories SET sync_key='cat:Sport', name='Golf' WHERE name='Dining'", []).unwrap();
        let golf = json!({"name":"Golf","kind":"spending","colour":"chart-3","sort":200,"is_builtin":0});
        let c = change("categories", "cat:Golf", "_row", golf, 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Waiting);
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM categories WHERE name='Golf'"), "cat:Sport");
    }

    #[test]
    fn a_rekeyed_category_takes_its_bookkeeping_with_it() {
        let conn = applying();
        local_dining_key(&conn, "cat:Dining:5555");
        clock::record(&conn, "categories", "cat:Dining:5555", "name", 5, "pc").unwrap();
        clock::record(&conn, "budgets", "cat:Dining:5555|2026-10", "_row", 5, "pc").unwrap();
        conn.execute(
            "INSERT INTO sync_outbox (tbl,key,field,value,at) VALUES ('budgets','cat:Dining:5555|*','limit_amount','1',5)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_pending (device,tbl,key,field,value,at) VALUES ('pc','categories','cat:Dining:5555','colour','\"x\"',5)",
            [],
        )
        .unwrap();
        let c = change("categories", "cat:Dining:1111", "_row", dining_row(), 10);
        apply(&conn, "pc", &c).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_clock WHERE tbl='categories' AND key='cat:Dining:1111' AND field='name'"), 1);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_clock WHERE tbl='budgets' AND key='cat:Dining:1111|2026-10'"), 1);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_clock WHERE key LIKE '%5555%'"), 0);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_outbox WHERE key='cat:Dining:1111|*'"), 1);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_pending WHERE key='cat:Dining:1111'"), 1);
    }

    fn copilot_row(posted: &str, category: &str, note: &str) -> Value {
        json!({"account":"sf:ACT-1","external_id":"copilot:00ff","posted":posted,"amount":-5.0,
            "description":"Coffee","payee":"Coffee","memo":null,"category":category,"category_source":"manual",
            "reviewed":1,"note":note,"removed":0})
    }
    const COPILOT_KEY: &str = "sf:ACT-1|copilot:00ff";

    #[test]
    fn a_copilot_takeover_keeps_the_owners_own_category_and_note_here() {
        let conn = applying();
        conn.execute(
            "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Groceries'),
               category_source='manual', note='mine'",
            [],
        )
        .unwrap();
        let c = change("bank_transactions", COPILOT_KEY, "_row", copilot_row("2026-10-02", "cat:Dining", "theirs"), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        let (cat, note, key): (String, String, String) = conn
            .query_row(
                "SELECT c.name, b.note, b.sync_key FROM bank_transactions b JOIN categories c ON c.id=b.category_id",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((cat.as_str(), note.as_str(), key.as_str()), ("Groceries", "mine", COPILOT_KEY));
    }

    #[test]
    fn a_pending_bank_row_is_not_taken_over() {
        let conn = applying();
        conn.execute("UPDATE bank_transactions SET pending=1", []).unwrap();
        let c = change("bank_transactions", COPILOT_KEY, "_row", copilot_row("2026-10-02", "cat:Dining", "x"), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 2);
    }

    #[test]
    fn this_computers_own_edit_does_not_rule_out_a_twin() {
        let conn = applying();
        // A pushed edit is recorded in the clock under this device.
        clock::record(&conn, "bank_transactions", "sf:ACT-1|TRN-1", "reviewed", 1, "laptop").unwrap();
        let c = change("bank_transactions", COPILOT_KEY, "_row", copilot_row("2026-10-02", "cat:Dining", "x"), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 1);
        assert_eq!(one::<String>(&conn, "SELECT sync_key FROM bank_transactions"), COPILOT_KEY);
    }

    #[test]
    fn a_bank_row_the_other_computer_holds_separately_is_not_taken_over() {
        let conn = applying();
        clock::record(&conn, "bank_transactions", "sf:ACT-1|TRN-1", "note", 1, "pc").unwrap();
        let c = change("bank_transactions", COPILOT_KEY, "_row", copilot_row("2026-10-02", "cat:Dining", "x"), 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 2);
    }

    #[test]
    fn with_two_candidates_the_nearer_date_is_taken_over_and_its_bookkeeping_follows() {
        let conn = applying();
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'TRN-3','2026-10-02',-5,'Coffee');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sync_outbox (tbl,key,field,value,at) VALUES ('bank_transactions','sf:ACT-1|TRN-3','note','\"n\"',5)",
            [],
        )
        .unwrap();
        let c = change("bank_transactions", COPILOT_KEY, "_row", copilot_row("2026-10-02", "cat:Dining", "x"), 10);
        apply(&conn, "pc", &c).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 2);
        assert_eq!(one::<String>(&conn, "SELECT external_id FROM bank_transactions WHERE sync_key='sf:ACT-1|copilot:00ff'"), "TRN-3");
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM sync_outbox WHERE key='sf:ACT-1|copilot:00ff'"), 1);
    }

    #[test]
    fn renaming_a_category_to_a_name_already_taken_waits() {
        let conn = applying();
        let golf = json!({"name":"Golf","kind":"spending","colour":"chart-3","sort":200,"is_builtin":0});
        apply(&conn, "pc", &change("categories", "cat:Golf", "_row", golf, 10)).unwrap();
        let c = change("categories", "cat:Golf", "name", json!("Dining"), 11);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Waiting);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM categories WHERE name='Golf'"), 1);
    }

    #[test]
    fn a_late_budget_edit_does_not_bring_back_a_deleted_budget() {
        let conn = applying();
        let k = "cat:Groceries|2026-10";
        apply(&conn, "pc", &change("budgets", k, "_row", json!({"limit_amount": 400.0}), 10)).unwrap();
        apply(&conn, "pc", &change("budgets", k, "_row", Value::Null, 12)).unwrap();
        let c = change("budgets", k, "limit_amount", json!(450.0), 11);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM budgets"), 0);
        // A newer edit with no row at all still creates one.
        let c = change("budgets", k, "limit_amount", json!(500.0), 13);
        apply(&conn, "pc", &c).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM budgets"), 1);
    }

    #[test]
    fn deleting_a_budget_of_an_unknown_category_is_done() {
        let conn = applying();
        let c = change("budgets", "cat:Nope|*", "_row", Value::Null, 10);
        assert_eq!(apply(&conn, "pc", &c).unwrap(), Outcome::Applied);
    }

    #[test]
    fn deletes_never_remove_simplefin_rows() {
        let conn = applying();
        apply(&conn, "pc", &change("accounts", "sf:ACT-1", "_row", Value::Null, 10)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM accounts WHERE sync_key='sf:ACT-1'"), 1);
        apply(&conn, "pc", &change("bank_transactions", "sf:ACT-1|TRN-1", "_row", Value::Null, 11)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 1);
    }

    #[test]
    fn a_copilot_history_row_takes_over_the_bank_copy_already_here() {
        let conn = applying();
        // TRN-1 is -5 on 2026-10-01. The PC holds it as an imported Copilot row.
        let row = json!({"account":"sf:ACT-1","external_id":"copilot:00ff","posted":"2026-10-02","amount":-5.0,
            "description":"Coffee","payee":"Coffee","memo":null,"category":"cat:Dining","category_source":"manual",
            "reviewed":1,"note":"with Sam","removed":0});
        apply(&conn, "pc", &change("bank_transactions", "sf:ACT-1|copilot:00ff", "_row", row, 10)).unwrap();

        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 1, "no duplicate");
        let (key, note): (String, String) = conn
            .query_row("SELECT sync_key, note FROM bank_transactions", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((key.as_str(), note.as_str()), ("sf:ACT-1|copilot:00ff", "with Sam"));
    }

    #[test]
    fn a_copilot_history_row_with_no_twin_is_added() {
        let conn = applying();
        let row = json!({"account":"sf:ACT-1","external_id":"copilot:0aaa","posted":"2023-01-02","amount":-80.0,
            "description":"Golf","payee":"Golf","memo":null,"category":null,"category_source":"manual",
            "reviewed":1,"note":null,"removed":0});
        apply(&conn, "pc", &change("bank_transactions", "sf:ACT-1|copilot:0aaa", "_row", row, 10)).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT count(*) FROM bank_transactions"), 2);
    }

    #[test]
    fn an_investment_transaction_brings_its_security_along() {
        let conn = applying();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,sync_key) VALUES ('Brokerage','brokerage','USD','2026-01-01','acct:b');",
        )
        .unwrap();
        let row = json!({"account":"acct:b","security":{"ticker":"VTI","name":"Vanguard Total","type":"etf","currency":"USD"},
            "type":"buy","date":"2026-10-01","quantity":2.0,"price":250.0,"amount":500.0,"fees":0.0,"note":null});
        apply(&conn, "pc", &change("transactions", "txn:1", "_row", row, 10)).unwrap();
        assert_eq!(
            one::<String>(&conn, "SELECT s.ticker FROM transactions t JOIN securities s ON s.id=t.security_id"),
            "VTI"
        );
    }
}
