use crate::budget::store;
use crate::db::Db;
use crate::models::{BankTransaction, Budget, Category, CategoryRule, TxnSplit};
use rusqlite::{params, Connection};
use std::collections::HashMap;

// ---------- categories ----------

pub fn categories(conn: &Connection) -> rusqlite::Result<Vec<Category>> {
    let mut stmt = conn.prepare(
        "SELECT id,name,kind,colour,sort,is_builtin FROM categories ORDER BY sort, name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Category {
            id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, colour: r.get(3)?,
            sort: r.get(4)?, is_builtin: r.get::<_, i64>(5)? != 0,
        })
    })?;
    rows.collect()
}

#[tauri::command]
pub fn categories_list(db: tauri::State<Db>) -> Result<Vec<Category>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    categories(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn categories_create(db: tauri::State<Db>, name: String, kind: String, colour: String)
    -> Result<Category, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    create_category(&conn, &name, &kind, &colour)
}

/// Make a category. An empty or "auto" colour picks the least-used `cat-N`,
/// so each new category looks distinct; an explicit token is kept.
pub fn create_category(conn: &Connection, name: &str, kind: &str, colour: &str)
    -> Result<Category, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the category a name.".into());
    }
    let colour = match colour.trim() {
        "" | "auto" => crate::budget::seed::next_colour(conn).map_err(|e| e.to_string())?,
        explicit => explicit.to_string(),
    };
    let next_sort: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort),0)+10 FROM categories", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO categories (name,kind,colour,sort,is_builtin) VALUES (?1,?2,?3,?4,0)",
        params![name, kind, colour, next_sort],
    )
    .map_err(|e| if e.to_string().contains("UNIQUE") {
        format!("There is already a category called \"{name}\".")
    } else { e.to_string() })?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id,name,kind,colour,sort,is_builtin FROM categories WHERE id=?1", [id],
        |r| Ok(Category {
            id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, colour: r.get(3)?,
            sort: r.get(4)?, is_builtin: r.get::<_, i64>(5)? != 0,
        }),
    ).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn categories_update(db: tauri::State<Db>, id: i64, name: String, colour: String)
    -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    update_category(&conn, id, &name, &colour)
}

/// Rename or recolour a category. An empty or "auto" colour picks the
/// least-used `cat-N`, as on create, so "auto" is never stored.
pub fn update_category(conn: &Connection, id: i64, name: &str, colour: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the category a name.".into());
    }
    let colour = match colour.trim() {
        "" | "auto" => crate::budget::seed::next_colour(conn).map_err(|e| e.to_string())?,
        explicit => explicit.to_string(),
    };
    conn.execute("UPDATE categories SET name=?1, colour=?2 WHERE id=?3", params![name, colour, id])
        .map_err(|e| if e.to_string().contains("UNIQUE") {
            format!("There is already a category called \"{name}\".")
        } else { e.to_string() })?;
    Ok(())
}

#[tauri::command]
pub fn categories_set_kind(db: tauri::State<Db>, id: i64, kind: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    set_category_kind(&conn, id, &kind)
}

/// What a category counts as: `spending` (spent and budgets), `income`, or
/// `transfer`, which shows but never counts, like a category Copilot excludes.
pub fn set_category_kind(conn: &Connection, id: i64, kind: &str) -> Result<(), String> {
    if !matches!(kind, "spending" | "income" | "transfer") {
        return Err(format!("\"{kind}\" isn't something a category can count as."));
    }
    conn.execute("UPDATE categories SET kind=?1 WHERE id=?2", params![kind, id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Deleting a category leaves its transactions uncategorised (the foreign key
/// is ON DELETE SET NULL) and removes any rules that pointed at it.
#[tauri::command]
pub fn categories_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute("DELETE FROM categories WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove every category, to start sorting again from nothing. Backs up
/// first, like an import, since this can't be undone any other way.
#[tauri::command]
pub async fn categories_clear(app: tauri::AppHandle) -> Result<usize, String> {
    use crate::backup::{self, naming::Kind, snapshot, BackupState};
    use tauri::Manager;
    super::off_main_thread(move || {
        let state = app.state::<BackupState>();
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let safety = snapshot::attempt(&conn, &state.paths, Kind::Manual, backup::now());
        state.record(&safety);
        if let Some(e) = safety.error {
            return Err(format!("Didn't remove anything, because the backup before it failed: {e}"));
        }
        store::clear_categories(&conn).map_err(|e| e.to_string())
    })
    .await
}

// ---------- transactions ----------

/// `payee` is the name Tally shows: Copilot's when the import gave one, which a
/// bank sync never overwrites, otherwise the bank's.
const TXN_COLUMNS: &str = "id,account_id,external_id,posted,amount,description,COALESCE(name,payee),memo,mcc,pending,
                           category_id,category_source,reviewed,note,removed";

fn txn_from_row(r: &rusqlite::Row) -> rusqlite::Result<BankTransaction> {
    Ok(BankTransaction {
        id: r.get(0)?, account_id: r.get(1)?, external_id: r.get(2)?, posted: r.get(3)?,
        amount: r.get(4)?, description: r.get(5)?, payee: r.get(6)?, memo: r.get(7)?,
        mcc: r.get(8)?, pending: r.get::<_, i64>(9)? != 0,
        category_id: r.get(10)?, category_source: r.get(11)?,
        reviewed: r.get::<_, i64>(12)? != 0,
        note: r.get(13)?,
        removed: r.get::<_, i64>(14)? != 0,
        splits: Vec::new(),
    })
}

/// Fill in each row's split pieces. The table holds only rows the owner split
/// by hand, so it is read whole rather than by a list of ids, which for a
/// search across every month would run to thousands.
fn attach_splits(conn: &Connection, rows: &mut [BankTransaction]) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT txn_id, id, category_id, amount, note FROM bank_transaction_splits
         ORDER BY txn_id, sort, id",
    )?;
    let mut by_txn: HashMap<i64, Vec<TxnSplit>> = HashMap::new();
    let pieces = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, TxnSplit {
            id: r.get(1)?, category_id: r.get(2)?, amount: r.get(3)?, note: r.get(4)?,
        }))
    })?;
    for piece in pieces {
        let (txn_id, split) = piece?;
        by_txn.entry(txn_id).or_default().push(split);
    }
    for row in rows.iter_mut() {
        if let Some(splits) = by_txn.remove(&row.id) {
            row.splits = splits;
        }
    }
    Ok(())
}

pub fn list_transactions(conn: &Connection, from: &str, to: &str)
    -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE posted >= ?1 AND posted <= ?2
         ORDER BY posted DESC, id DESC"
    ))?;
    let mut rows = stmt.query_map([from, to], txn_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    attach_splits(conn, &mut rows)?;
    Ok(rows)
}

/// Every transaction the owner has not looked at yet, any month, newest first.
pub fn list_to_review(conn: &Connection) -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE reviewed = 0 AND removed = 0
         ORDER BY posted DESC, id DESC"
    ))?;
    let mut rows = stmt.query_map([], txn_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    attach_splits(conn, &mut rows)?;
    Ok(rows)
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

/// Remove transactions from Spending and budgets, or restore them.
#[tauri::command]
pub fn bank_transactions_set_removed(db: tauri::State<Db>, ids: Vec<i64>, removed: bool) -> Result<usize, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::set_removed(&conn, &ids, removed).map_err(|e| e.to_string())
}

/// Undo: put rows back as they were before an action in Spending.
#[tauri::command]
pub fn bank_transactions_restore(db: tauri::State<Db>, states: Vec<store::RowState>) -> Result<usize, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::restore_rows(&conn, &states).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bank_transactions_list(db: tauri::State<Db>, from: String, to: String)
    -> Result<Vec<BankTransaction>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list_transactions(&conn, &from, &to).map_err(|e| e.to_string())
}

/// The earliest and latest posting dates we hold, so the UI knows which months
/// are worth offering.
#[tauri::command]
pub fn bank_transactions_range(db: tauri::State<Db>) -> Result<(Option<String>, Option<String>), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.query_row("SELECT MIN(posted), MAX(posted) FROM bank_transactions", [], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
    }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bank_transaction_set_category(
    db: tauri::State<Db>,
    id: i64,
    category_id: Option<i64>,
    apply_to_payee: bool,
) -> Result<usize, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::set_category(&conn, id, category_id, apply_to_payee).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bank_transaction_set_note(db: tauri::State<Db>, id: i64, note: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    set_note(&conn, id, &note).map_err(|e| e.to_string())
}

/// The owner's note on a transaction. A blank one clears it.
pub fn set_note(conn: &Connection, id: i64, note: &str) -> rusqlite::Result<()> {
    let note = Some(note.trim()).filter(|n| !n.is_empty());
    conn.execute("UPDATE bank_transactions SET note=?1 WHERE id=?2", params![note, id])?;
    Ok(())
}

/// Split a transaction across categories; an empty list unsplits it.
#[tauri::command]
pub fn bank_transaction_set_splits(db: tauri::State<Db>, id: i64, splits: Vec<store::NewSplit>)
    -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::set_splits(&conn, id, &splits)
}

// ---------- rules ----------

#[tauri::command]
pub fn rules_list(db: tauri::State<Db>) -> Result<Vec<CategoryRule>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn.prepare(
        "SELECT id,match_type,pattern,category_id,created_at FROM category_rules ORDER BY id DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(CategoryRule {
            id: r.get(0)?, match_type: r.get(1)?, pattern: r.get(2)?,
            category_id: r.get(3)?, created_at: r.get(4)?,
        })
    }).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rules_create(db: tauri::State<Db>, match_type: String, pattern: String, category_id: i64)
    -> Result<usize, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    create_rule(&conn, &match_type, &pattern, category_id)
}

/// A rule the owner writes: a transaction whose payee (or description)
/// contains `pattern`, in any case, goes in the category. It replaces a rule
/// with the same text. Every automatic row is re-sorted at once, so it reaches
/// history too; categories chosen by hand stay. Returns how many rows moved.
pub fn create_rule(conn: &Connection, match_type: &str, pattern: &str, category_id: i64) -> Result<usize, String> {
    if !matches!(match_type, "payee" | "description") {
        return Err("A rule looks at the payee or the description.".into());
    }
    let pattern = pattern.trim().to_lowercase();
    if pattern.is_empty() {
        return Err("Type the text the rule looks for.".into());
    }
    let run = || -> rusqlite::Result<usize> {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO category_rules (match_type, pattern, category_id, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(match_type, pattern) DO UPDATE SET category_id=excluded.category_id",
            params![match_type, pattern, category_id, chrono::Utc::now().to_rfc3339()],
        )?;
        let auto = "SELECT id, category_id FROM bank_transactions WHERE category_source='auto'";
        let read = |tx: &Connection| -> rusqlite::Result<HashMap<i64, Option<i64>>> {
            tx.prepare(auto)?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect()
        };
        let before = read(&tx)?;
        store::recategorise_all(&tx)?;
        let moved = read(&tx)?.iter().filter(|(id, c)| before.get(id) != Some(c)).count();
        tx.commit()?;
        Ok(moved)
    };
    run().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rules_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute("DELETE FROM category_rules WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- budgets ----------

/// Every budget row. A row with `month = null` is the default that applies to
/// any month without its own figure; the frontend picks between them.
#[tauri::command]
pub fn budgets_list(db: tauri::State<Db>) -> Result<Vec<Budget>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    let mut stmt = conn.prepare("SELECT id,category_id,month,limit_amount FROM budgets")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(Budget { id: r.get(0)?, category_id: r.get(1)?, month: r.get(2)?, limit_amount: r.get(3)? })
    }).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// Set or clear a limit. `month` null sets the every-month default; a negative
/// or zero amount removes the row.
#[tauri::command]
pub fn budget_set(db: tauri::State<Db>, category_id: i64, month: Option<String>, amount: f64)
    -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    if amount <= 0.0 {
        conn.execute(
            "DELETE FROM budgets WHERE category_id=?1 AND month IS ?2",
            params![category_id, month],
        ).map_err(|e| e.to_string())?;
        return Ok(());
    }
    // SQLite's UNIQUE treats NULLs as distinct, so upsert by hand.
    let changed = conn.execute(
        "UPDATE budgets SET limit_amount=?1 WHERE category_id=?2 AND month IS ?3",
        params![amount, category_id, month],
    ).map_err(|e| e.to_string())?;
    if changed == 0 {
        conn.execute(
            "INSERT INTO budgets (category_id, month, limit_amount) VALUES (?1,?2,?3)",
            params![category_id, month, amount],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- accounts ----------

/// Let the user correct an account's kind, since SimpleFIN never tells us.
#[tauri::command]
pub fn accounts_set_type(db: tauri::State<Db>, id: i64, kind: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    conn.execute("UPDATE accounts SET type=?1 WHERE id=?2", params![kind, id])
        .map_err(|_| "That is not an account type Tally knows.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn seeded() -> Connection {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        conn
    }

    fn with_target_paycheck() -> Connection {
        let conn = seeded();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES ('Checking','cash','USD','2026-01-01');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee)
               VALUES (1,'t1','2026-10-01',500,'TARGET CORPORATI PAYROLL PETERS','Target');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee,category_id,category_source)
               VALUES (1,'t2','2026-10-15',500,'TARGET CORPORATI PAYROLL PETERS','Target',
                       (SELECT id FROM categories WHERE name='Groceries'),'manual');",
        ).unwrap();
        conn
    }

    fn category_of(conn: &Connection, ext: &str) -> Option<String> {
        conn.query_row(
            "SELECT c.name FROM bank_transactions b LEFT JOIN categories c ON c.id=b.category_id WHERE b.external_id=?1",
            [ext], |r| r.get(0),
        ).unwrap()
    }

    #[test]
    fn a_rule_the_owner_writes_sorts_history_but_not_hand_picked_rows() {
        let conn = with_target_paycheck();
        let income = crate::budget::seed::category_id(&conn, "Income").unwrap().unwrap();
        let moved = create_rule(&conn, "description", "  Target Corporati Payroll ", income).unwrap();
        assert_eq!(moved, 1);
        assert_eq!(category_of(&conn, "t1").as_deref(), Some("Income"));
        assert_eq!(category_of(&conn, "t2").as_deref(), Some("Groceries"), "chosen by hand, so it stays");
        let pattern: String = conn.query_row("SELECT pattern FROM category_rules", [], |r| r.get(0)).unwrap();
        assert_eq!(pattern, "target corporati payroll");
    }

    #[test]
    fn a_rule_with_the_same_text_is_replaced_and_a_blank_one_refused() {
        let conn = with_target_paycheck();
        let id = |n: &str| crate::budget::seed::category_id(&conn, n).unwrap().unwrap();
        create_rule(&conn, "payee", "target", id("Groceries")).unwrap();
        create_rule(&conn, "payee", "TARGET", id("Income")).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM category_rules", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        assert_eq!(category_of(&conn, "t1").as_deref(), Some("Income"));
        assert!(create_rule(&conn, "payee", "  ", id("Income")).unwrap_err().contains("Type the text"));
        assert!(create_rule(&conn, "mcc", "5812", id("Income")).is_err());
    }

    #[test]
    fn a_note_is_set_trimmed_and_cleared_when_blank() {
        let conn = with_target_paycheck();
        let note = |c: &Connection| -> Option<String> {
            c.query_row("SELECT note FROM bank_transactions WHERE external_id='t1'", [], |r| r.get(0)).unwrap()
        };
        set_note(&conn, 1, "  Bonus week ").unwrap();
        assert_eq!(note(&conn).as_deref(), Some("Bonus week"));
        set_note(&conn, 1, "   ").unwrap();
        assert_eq!(note(&conn), None);
    }

    #[test]
    fn a_category_counts_as_spending_income_or_neither() {
        let conn = seeded();
        let id = crate::budget::seed::category_id(&conn, "Groceries").unwrap().unwrap();
        set_category_kind(&conn, id, "transfer").unwrap();
        let kind: String = conn.query_row("SELECT kind FROM categories WHERE id=?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(kind, "transfer");
        assert!(set_category_kind(&conn, id, "savings").is_err());
    }

    #[test]
    fn new_categories_get_distinct_colours_unless_one_is_given() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(create_category(&conn, "Golf", "spending", "auto").unwrap().colour, "cat-1");
        assert_eq!(create_category(&conn, "Pets", "spending", "").unwrap().colour, "cat-2");
        assert_eq!(create_category(&conn, "Kids", "spending", "cat-7").unwrap().colour, "cat-7");
        assert_eq!(create_category(&conn, "Gifts", "spending", "auto").unwrap().colour, "cat-3");
        let c = create_category(&conn, "  Books ", "spending", "auto").unwrap();
        assert_eq!((c.name.as_str(), c.kind.as_str(), c.is_builtin), ("Books", "spending", false));
    }

    #[test]
    fn an_update_never_stores_auto_as_a_colour() {
        let conn = db::open_in_memory().unwrap();
        let golf = create_category(&conn, "Golf", "spending", "cat-1").unwrap();
        create_category(&conn, "Pets", "spending", "cat-2").unwrap();
        let colour = |id: i64| -> String {
            conn.query_row("SELECT colour FROM categories WHERE id=?1", [id], |r| r.get(0)).unwrap()
        };
        update_category(&conn, golf.id, "Golf", "auto").unwrap();
        assert_eq!(colour(golf.id), "cat-3");
        // Golf moved off cat-1, so cat-1 is the least used again.
        update_category(&conn, golf.id, "Golf", "").unwrap();
        assert_eq!(colour(golf.id), "cat-1");
        update_category(&conn, golf.id, "  Golfing ", "cat-9").unwrap();
        assert_eq!(colour(golf.id), "cat-9");
        let name: String = conn.query_row("SELECT name FROM categories WHERE id=?1", [golf.id], |r| r.get(0)).unwrap();
        assert_eq!(name, "Golfing");
        assert!(update_category(&conn, golf.id, "Pets", "cat-1").err().unwrap().contains("already a category"));
        assert!(update_category(&conn, golf.id, " ", "cat-1").is_err());
    }

    #[test]
    fn a_duplicate_or_blank_category_is_refused() {
        let conn = db::open_in_memory().unwrap();
        create_category(&conn, "Golf", "spending", "auto").unwrap();
        let err = create_category(&conn, "Golf", "spending", "auto").err().unwrap();
        assert!(err.contains("already a category"), "{err}");
        assert!(create_category(&conn, "  ", "spending", "auto").is_err());
    }

    #[test]
    fn budget_set_inserts_updates_and_clears() {
        let conn = seeded();
        let cat: i64 = conn.query_row("SELECT id FROM categories WHERE name='Groceries'", [], |r| r.get(0)).unwrap();

        // Insert a monthly default, then a specific month.
        set_budget(&conn, cat, None, 400.0);
        set_budget(&conn, cat, Some("2026-09".into()), 550.0);
        let n: i64 = conn.query_row("SELECT count(*) FROM budgets", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "a month-specific limit sits alongside the default");

        // Updating the default replaces rather than duplicating.
        set_budget(&conn, cat, None, 450.0);
        let n: i64 = conn.query_row("SELECT count(*) FROM budgets", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        let amount: f64 = conn.query_row("SELECT limit_amount FROM budgets WHERE month IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(amount, 450.0);

        // Zero clears it.
        set_budget(&conn, cat, None, 0.0);
        let n: i64 = conn.query_row("SELECT count(*) FROM budgets", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    /// The body of `budget_set` without the Tauri state wrapper.
    fn set_budget(conn: &Connection, category_id: i64, month: Option<String>, amount: f64) {
        if amount <= 0.0 {
            conn.execute("DELETE FROM budgets WHERE category_id=?1 AND month IS ?2", params![category_id, month]).unwrap();
            return;
        }
        let changed = conn.execute(
            "UPDATE budgets SET limit_amount=?1 WHERE category_id=?2 AND month IS ?3",
            params![amount, category_id, month],
        ).unwrap();
        if changed == 0 {
            conn.execute("INSERT INTO budgets (category_id, month, limit_amount) VALUES (?1,?2,?3)",
                params![category_id, month, amount]).unwrap();
        }
    }

    #[test]
    fn deleting_a_category_leaves_its_transactions_uncategorised() {
        let conn = seeded();
        conn.execute("INSERT INTO accounts (name,type,currency,created_at) VALUES ('C','credit','USD','2026-01-01')", []).unwrap();
        let cat: i64 = conn.query_row("SELECT id FROM categories WHERE name='Dining'", [], |r| r.get(0)).unwrap();
        conn.execute(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,category_id)
             VALUES (1,'t1','2026-09-01',-10,'Lunch',?1)", [cat],
        ).unwrap();

        conn.execute("DELETE FROM categories WHERE id=?1", [cat]).unwrap();

        let left: Option<i64> = conn.query_row("SELECT category_id FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(left, None);
        let rows: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "the transaction itself must survive");
    }

    #[test]
    fn the_review_list_holds_only_unreviewed_rows() {
        let conn = seeded();
        conn.execute("INSERT INTO accounts (name,type,currency,created_at) VALUES ('C','credit','USD','2026-01-01')", []).unwrap();
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,reviewed)
             VALUES (1,'new','2026-10-02',-5,'x',0), (1,'seen','2026-10-01',-5,'y',1);",
        ).unwrap();
        let ids: Vec<String> = list_to_review(&conn).unwrap().into_iter().map(|t| t.external_id).collect();
        assert_eq!(ids, vec!["new".to_string()]);
    }

    #[test]
    fn transactions_are_listed_newest_first_within_a_window() {
        let conn = seeded();
        conn.execute("INSERT INTO accounts (name,type,currency,created_at) VALUES ('C','credit','USD','2026-01-01')", []).unwrap();
        for (ext, date) in [("a", "2026-08-31"), ("b", "2026-09-01"), ("c", "2026-09-30"), ("d", "2026-10-01")] {
            conn.execute(
                "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
                 VALUES (1,?1,?2,-5,'x')", params![ext, date],
            ).unwrap();
        }
        let rows = list_transactions(&conn, "2026-09-01", "2026-09-30").unwrap();
        assert_eq!(rows.iter().map(|r| r.external_id.as_str()).collect::<Vec<_>>(), vec!["c", "b"]);
    }

    #[test]
    fn listed_transactions_carry_their_split_pieces_in_order() {
        let conn = seeded();
        conn.execute("INSERT INTO accounts (name,type,currency,created_at) VALUES ('C','credit','USD','2026-01-01')", []).unwrap();
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
             VALUES (1,'split','2026-09-10',-85.5,'Costco'), (1,'plain','2026-09-11',-5,'Coffee');",
        ).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='split'", [], |r| r.get(0)).unwrap();
        store::set_splits(&conn, id, &[
            store::NewSplit { category_id: None, amount: -60.0, note: Some("food".into()) },
            store::NewSplit { category_id: None, amount: -25.5, note: None },
        ]).unwrap();

        let rows = list_transactions(&conn, "2026-09-01", "2026-09-30").unwrap();
        let plain = rows.iter().find(|r| r.external_id == "plain").unwrap();
        assert!(plain.splits.is_empty());
        let split = rows.iter().find(|r| r.external_id == "split").unwrap();
        let pieces: Vec<(f64, Option<String>)> = split.splits.iter().map(|s| (s.amount, s.note.clone())).collect();
        assert_eq!(pieces, vec![(-60.0, Some("food".to_string())), (-25.5, None)]);

        // The review list carries them too.
        conn.execute("UPDATE bank_transactions SET reviewed=0 WHERE id=?1", [id]).unwrap();
        let review = list_to_review(&conn).unwrap();
        assert_eq!(review.iter().find(|r| r.id == id).unwrap().splits.len(), 2);
    }
}
