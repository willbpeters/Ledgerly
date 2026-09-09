use crate::db::Db;
use crate::models::{Account, NewAccount};
use rusqlite::Connection;

pub fn create(conn: &Connection, a: NewAccount) -> rusqlite::Result<Account> {
    let created_at = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO accounts (name, type, institution, currency, created_at)
         VALUES (?1, ?2, ?3, 'USD', ?4)",
        rusqlite::params![a.name, a.type_, a.institution, created_at],
    )?;
    let id = conn.last_insert_rowid();
    get(conn, id)
}

const COLS: &str = "id,name,type,institution,currency,created_at,source,external_id,synced_balance,last_synced_at,hidden";

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Account> {
    conn.query_row(
        &format!("SELECT {COLS} FROM accounts WHERE id=?1"),
        [id],
        row_to_account,
    )
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Account>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM accounts ORDER BY name"))?;
    let rows = stmt.query_map([], row_to_account)?;
    rows.collect()
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM accounts WHERE id=?1", [id])?;
    Ok(())
}

/// Hide or show an account. Hidden accounts stay in the database and keep
/// syncing; they are simply left out of every derived figure.
pub fn set_hidden(conn: &Connection, id: i64, hidden: bool) -> rusqlite::Result<()> {
    conn.execute("UPDATE accounts SET hidden=?1 WHERE id=?2", rusqlite::params![hidden, id])?;
    Ok(())
}

fn row_to_account(r: &rusqlite::Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: r.get(0)?,
        name: r.get(1)?,
        type_: r.get(2)?,
        institution: r.get(3)?,
        currency: r.get(4)?,
        created_at: r.get(5)?,
        source: r.get(6)?,
        external_id: r.get(7)?,
        synced_balance: r.get(8)?,
        last_synced_at: r.get(9)?,
        hidden: r.get(10)?,
    })
}

#[tauri::command]
pub fn accounts_list(db: tauri::State<Db>) -> Result<Vec<Account>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounts_create(db: tauri::State<Db>, account: NewAccount) -> Result<Account, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    create(&conn, account).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounts_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    delete(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounts_set_hidden(db: tauri::State<Db>, id: i64, hidden: bool) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    set_hidden(&conn, id, hidden).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn a_new_account_starts_visible() {
        let conn = db::open_in_memory().unwrap();
        let a = create(&conn, NewAccount { name: "A".into(), type_: "cash".into(), institution: None }).unwrap();
        assert!(!a.hidden, "accounts must not be hidden until asked");
    }

    #[test]
    fn set_hidden_hides_and_shows_an_account() {
        let conn = db::open_in_memory().unwrap();
        let a = create(&conn, NewAccount { name: "A".into(), type_: "cash".into(), institution: None }).unwrap();

        set_hidden(&conn, a.id, true).unwrap();
        assert!(get(&conn, a.id).unwrap().hidden);

        set_hidden(&conn, a.id, false).unwrap();
        assert!(!get(&conn, a.id).unwrap().hidden);
    }

    #[test]
    fn hidden_accounts_are_still_listed_because_the_accounts_screen_needs_them() {
        let conn = db::open_in_memory().unwrap();
        let a = create(&conn, NewAccount { name: "A".into(), type_: "cash".into(), institution: None }).unwrap();
        set_hidden(&conn, a.id, true).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1, "list() is the raw list; filtering happens in the UI layer");
        assert!(all[0].hidden);
    }

    #[test]
    fn create_then_list_returns_account() {
        let conn = db::open_in_memory().unwrap();
        create(&conn, NewAccount { name: "Brokerage".into(), type_: "brokerage".into(), institution: Some("Fidelity".into()) }).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Brokerage");
        assert_eq!(all[0].currency, "USD");
        assert_eq!(all[0].source, "manual");
        assert!(all[0].external_id.is_none());
    }
}
