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

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Account> {
    conn.query_row(
        "SELECT id,name,type,institution,currency,created_at FROM accounts WHERE id=?1",
        [id],
        row_to_account,
    )
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Account>> {
    let mut stmt = conn.prepare(
        "SELECT id,name,type,institution,currency,created_at FROM accounts ORDER BY name",
    )?;
    let rows = stmt.query_map([], row_to_account)?;
    rows.collect()
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM accounts WHERE id=?1", [id])?;
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
    })
}

#[tauri::command]
pub fn accounts_list(db: tauri::State<Db>) -> Result<Vec<Account>, String> {
    let conn = db.0.lock().unwrap();
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounts_create(db: tauri::State<Db>, account: NewAccount) -> Result<Account, String> {
    let conn = db.0.lock().unwrap();
    create(&conn, account).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn accounts_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    delete(&conn, id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    #[test]
    fn create_then_list_returns_account() {
        let conn = db::open_in_memory().unwrap();
        create(&conn, NewAccount { name: "Brokerage".into(), type_: "brokerage".into(), institution: Some("Fidelity".into()) }).unwrap();
        let all = list(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Brokerage");
        assert_eq!(all[0].currency, "USD");
    }
}
