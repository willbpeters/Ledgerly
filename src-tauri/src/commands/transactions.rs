use crate::db::Db;
use crate::models::{NewTransaction, Transaction};
use rusqlite::Connection;

pub fn create(conn: &Connection, t: NewTransaction) -> rusqlite::Result<Transaction> {
    conn.execute(
        "INSERT INTO transactions
           (account_id,security_id,type,date,quantity,price,amount,fees,note)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![t.account_id, t.security_id, t.type_, t.date,
                          t.quantity, t.price, t.amount, t.fees, t.note],
    )?;
    get(conn, conn.last_insert_rowid())
}

/// Insert many transactions atomically (used by CSV import).
pub fn create_many(conn: &mut Connection, items: Vec<NewTransaction>) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    for t in &items {
        tx.execute(
            "INSERT INTO transactions
               (account_id,security_id,type,date,quantity,price,amount,fees,note)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![t.account_id, t.security_id, t.type_, t.date,
                              t.quantity, t.price, t.amount, t.fees, t.note],
        )?;
    }
    tx.commit()?;
    Ok(items.len())
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Transaction> {
    conn.query_row(
        "SELECT id,account_id,security_id,type,date,quantity,price,amount,fees,note
         FROM transactions WHERE id=?1",
        [id], row_to_txn)
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Transaction>> {
    let mut stmt = conn.prepare(
        "SELECT id,account_id,security_id,type,date,quantity,price,amount,fees,note
         FROM transactions ORDER BY date DESC, id DESC")?;
    let rows = stmt.query_map([], row_to_txn)?;
    rows.collect()
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM transactions WHERE id=?1", [id])?;
    Ok(())
}

fn row_to_txn(r: &rusqlite::Row) -> rusqlite::Result<Transaction> {
    Ok(Transaction {
        id: r.get(0)?, account_id: r.get(1)?, security_id: r.get(2)?, type_: r.get(3)?,
        date: r.get(4)?, quantity: r.get(5)?, price: r.get(6)?, amount: r.get(7)?,
        fees: r.get(8)?, note: r.get(9)?,
    })
}

#[tauri::command]
pub fn transactions_list(db: tauri::State<Db>) -> Result<Vec<Transaction>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transactions_create(db: tauri::State<Db>, txn: NewTransaction) -> Result<Transaction, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    create(&conn, txn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transactions_create_many(db: tauri::State<Db>, txns: Vec<NewTransaction>) -> Result<usize, String> {
    let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    create_many(&mut conn, txns).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn transactions_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    delete(&conn, id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db, commands::accounts};
    use crate::models::NewAccount;

    fn acct(conn: &Connection) -> i64 {
        accounts::create(conn, NewAccount { name: "B".into(), type_: "brokerage".into(), institution: None }).unwrap().id
    }

    #[test]
    fn create_and_list_transaction() {
        let conn = db::open_in_memory().unwrap();
        let a = acct(&conn);
        create(&conn, NewTransaction { account_id: a, security_id: None, type_: "deposit".into(),
            date: "2026-01-02".into(), quantity: 0.0, price: 0.0, amount: 1000.0, fees: 0.0, note: None }).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn create_many_is_atomic() {
        let mut conn = db::open_in_memory().unwrap();
        let a = acct(&conn);
        let n = create_many(&mut conn, vec![
            NewTransaction { account_id: a, security_id: None, type_: "deposit".into(), date: "2026-01-01".into(), quantity:0.0, price:0.0, amount:500.0, fees:0.0, note:None },
            NewTransaction { account_id: a, security_id: None, type_: "deposit".into(), date: "2026-01-03".into(), quantity:0.0, price:0.0, amount:250.0, fees:0.0, note:None },
        ]).unwrap();
        assert_eq!(n, 2);
        assert_eq!(list(&conn).unwrap().len(), 2);
    }
}
