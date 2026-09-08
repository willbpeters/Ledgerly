use crate::budget::store;
use crate::db::Db;
use crate::models::{BankTransaction, Budget, Category, CategoryRule};
use rusqlite::{params, Connection};

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
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the category a name.".into());
    }
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
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the category a name.".into());
    }
    conn.execute("UPDATE categories SET name=?1, colour=?2 WHERE id=?3", params![name, colour, id])
        .map_err(|e| if e.to_string().contains("UNIQUE") {
            format!("There is already a category called \"{name}\".")
        } else { e.to_string() })?;
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

// ---------- transactions ----------

pub fn list_transactions(conn: &Connection, from: &str, to: &str)
    -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(
        "SELECT id,account_id,external_id,posted,amount,description,payee,memo,mcc,pending,
                category_id,category_source
         FROM bank_transactions WHERE posted >= ?1 AND posted <= ?2
         ORDER BY posted DESC, id DESC",
    )?;
    let rows = stmt.query_map([from, to], |r| {
        Ok(BankTransaction {
            id: r.get(0)?, account_id: r.get(1)?, external_id: r.get(2)?, posted: r.get(3)?,
            amount: r.get(4)?, description: r.get(5)?, payee: r.get(6)?, memo: r.get(7)?,
            mcc: r.get(8)?, pending: r.get::<_, i64>(9)? != 0,
            category_id: r.get(10)?, category_source: r.get(11)?,
        })
    })?;
    rows.collect()
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
        .map_err(|_| "That is not an account type Ledgerly knows.".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn budget_set_inserts_updates_and_clears() {
        let conn = db::open_in_memory().unwrap();
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
        let conn = db::open_in_memory().unwrap();
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
    fn transactions_are_listed_newest_first_within_a_window() {
        let conn = db::open_in_memory().unwrap();
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
}
