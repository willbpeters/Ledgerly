//! CSV export: one spreadsheet-ready file per kind of data.
use chrono::NaiveDate;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

/// Each file and the query that fills it. Columns are named for a person
/// reading the file in Excel, and IDs are joined to names for the same reason.
/// Market caches and snapshots are left out: they are re-fetchable or derived.
pub const EXPORTS: [(&str, &str); 8] = [
    (
        "accounts.csv",
        "SELECT name, type, institution, currency, source, hidden, synced_balance,
                last_synced_at, created_at
         FROM accounts ORDER BY name",
    ),
    (
        "investment-transactions.csv",
        "SELECT t.date, a.name AS account, s.ticker AS ticker, t.type, t.quantity, t.price,
                t.amount, t.fees, t.note
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN securities s ON s.id = t.security_id
         ORDER BY t.date, t.id",
    ),
    (
        "bank-transactions.csv",
        "SELECT b.posted AS date, a.name AS account, b.description, b.payee, b.memo, b.amount,
                CASE WHEN EXISTS (SELECT 1 FROM bank_transaction_splits s WHERE s.txn_id = b.id)
                     THEN 'Split' ELSE c.name END AS category,
                b.category_source, b.mcc, b.pending
         FROM bank_transactions b
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN categories c ON c.id = b.category_id
         ORDER BY b.posted, b.id",
    ),
    (
        "synced-holdings.csv",
        "SELECT a.name AS account, s.ticker, h.shares, h.cost_basis, h.market_value, h.as_of
         FROM synced_holdings h
         JOIN accounts a ON a.id = h.account_id
         JOIN securities s ON s.id = h.security_id
         ORDER BY a.name, s.ticker",
    ),
    (
        "categories.csv",
        "SELECT name, kind, colour, sort, is_builtin FROM categories ORDER BY sort, name",
    ),
    (
        "budgets.csv",
        "SELECT c.name AS category, b.month, b.limit_amount
         FROM budgets b JOIN categories c ON c.id = b.category_id
         ORDER BY c.name, b.month",
    ),
    (
        "category-rules.csv",
        "SELECT r.match_type, r.pattern, c.name AS category, r.created_at
         FROM category_rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.match_type, r.pattern",
    ),
    // One line per piece, beside the transaction it came from, so a split can
    // be rebuilt from bank-transactions.csv and this file alone.
    (
        "transaction-splits.csv",
        "SELECT b.posted AS date, a.name AS account, COALESCE(b.payee, b.description) AS payee,
                b.amount AS transaction_amount, c.name AS category, s.amount, s.note
         FROM bank_transaction_splits s
         JOIN bank_transactions b ON b.id = s.txn_id
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN categories c ON c.id = s.category_id
         ORDER BY b.posted, b.id, s.sort",
    ),
];

/// Bank descriptions are third-party text. Excel runs a cell starting with one
/// of these as a formula, so text gets a leading apostrophe. Numbers never
/// pass through here, which is what keeps a negative amount a number.
fn guard(text: &str) -> String {
    if text.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{text}")
    } else {
        text.to_string()
    }
}

fn quote(text: &str) -> String {
    if text.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

fn cell(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null | ValueRef::Blob(_) => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => quote(&guard(&String::from_utf8_lossy(t))),
    }
}

/// Run `sql` and return it as CSV text. The byte-order mark makes Excel read
/// the file as UTF-8, so accented payee names survive.
pub fn query_to_csv(conn: &Connection, sql: &str) -> rusqlite::Result<String> {
    let mut stmt = conn.prepare(sql)?;
    let header: Vec<String> = stmt.column_names().iter().map(|c| quote(c)).collect();
    let width = header.len();
    let mut out = String::from("\u{FEFF}");
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let cells = (0..width)
            .map(|i| row.get_ref(i).map(cell))
            .collect::<rusqlite::Result<Vec<String>>>()?;
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    }
    Ok(out)
}

/// `Tally export 2026-10-14`, or `… (2)` if that exists already.
fn folder_for(base: &Path, day: NaiveDate) -> PathBuf {
    let stem = format!("Tally export {}", day.format("%Y-%m-%d"));
    (1..)
        .map(|n| if n == 1 { base.join(&stem) } else { base.join(format!("{stem} ({n})")) })
        .find(|p| !p.exists())
        .expect("an unused folder name")
}

/// Write every export into a new dated folder inside `base`; returns the folder.
pub fn export_all(conn: &Connection, base: &Path, day: NaiveDate) -> Result<PathBuf, String> {
    let folder = folder_for(base, day);
    fs::create_dir_all(&folder).map_err(|e| format!("Couldn't create {}: {e}", folder.display()))?;
    for (file, sql) in EXPORTS {
        let csv = query_to_csv(conn, sql).map_err(|e| format!("Couldn't export {file}: {e}"))?;
        fs::write(folder.join(file), csv).map_err(|e| format!("Couldn't write {file}: {e}"))?;
    }
    Ok(folder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap()
    }

    #[test]
    fn fields_with_commas_quotes_or_line_breaks_are_quoted() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote("a,b"), "\"a,b\"");
        assert_eq!(quote("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(quote("two\nlines"), "\"two\nlines\"");
    }

    #[test]
    fn text_excel_would_run_as_a_formula_is_defused() {
        for risky in ["=SUM(A1)", "+1", "-5 refund", "@cmd", "\tx"] {
            assert_eq!(guard(risky), format!("'{risky}"));
        }
        assert_eq!(guard("Coffee"), "Coffee");
    }

    #[test]
    fn a_query_becomes_csv_with_a_bom_header_and_untouched_numbers() {
        let conn = Connection::open_in_memory().unwrap();
        let csv = query_to_csv(
            &conn,
            "SELECT 'a,b' AS x, -12.5 AS amount, 3 AS n, NULL AS empty, '=SUM(A1)' AS f, 'say \"hi\"' AS q",
        )
        .unwrap();
        assert_eq!(
            csv,
            "\u{FEFF}x,amount,n,empty,f,q\r\n\"a,b\",-12.5,3,,'=SUM(A1),\"say \"\"hi\"\"\"\r\n"
        );
    }

    #[test]
    fn every_file_is_written_with_names_instead_of_ids() {
        let conn = crate::db::open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (id, name, type, created_at) VALUES (1, 'Checking', 'cash', '2026-10-01');
             INSERT INTO securities (id, ticker, type) VALUES (1, 'VTI', 'etf');
             INSERT INTO transactions (account_id, security_id, type, date, quantity, price, amount)
               VALUES (1, 1, 'buy', '2026-10-02', 2, 250, 500);
             INSERT INTO categories (id, name, kind) VALUES (900, 'Test category', 'spending');
             INSERT INTO bank_transactions (account_id, external_id, posted, amount, description, category_id)
               VALUES (1, 'x1', '2026-10-03', -4.5, 'Coffee, large', 900);
             INSERT INTO bank_transaction_splits (txn_id, category_id, amount, sort)
               VALUES (1, 900, -3, 0), (1, NULL, -1.5, 1);",
        )
        .unwrap();
        let out = tempfile::tempdir().unwrap();

        let folder = export_all(&conn, out.path(), day()).unwrap();

        assert!(folder.ends_with("Tally export 2026-10-14"));
        for (file, _) in EXPORTS {
            assert!(folder.join(file).exists(), "{file} missing");
        }
        let investments = std::fs::read_to_string(folder.join("investment-transactions.csv")).unwrap();
        assert!(investments.starts_with("\u{FEFF}date,account,ticker,type,quantity,price,amount,fees,note\r\n"));
        assert!(investments.contains("2026-10-02,Checking,VTI,buy,2,250,500,0,\r\n"));
        let bank = std::fs::read_to_string(folder.join("bank-transactions.csv")).unwrap();
        assert!(bank.contains("2026-10-03,Checking,\"Coffee, large\",,,-4.5,Split,auto,,0\r\n"), "a split row reads Split, not its own category");
        let splits = std::fs::read_to_string(folder.join("transaction-splits.csv")).unwrap();
        assert!(splits.starts_with("\u{FEFF}date,account,payee,transaction_amount,category,amount,note\r\n"));
        assert!(splits.contains("2026-10-03,Checking,\"Coffee, large\",-4.5,Test category,-3,\r\n"));
        assert!(splits.contains("2026-10-03,Checking,\"Coffee, large\",-4.5,,-1.5,\r\n"));
    }

    #[test]
    fn a_second_export_on_the_same_day_gets_its_own_folder() {
        let conn = crate::db::open_in_memory().unwrap();
        let out = tempfile::tempdir().unwrap();
        export_all(&conn, out.path(), day()).unwrap();
        let second = export_all(&conn, out.path(), day()).unwrap();
        assert!(second.ends_with("Tally export 2026-10-14 (2)"));
    }
}
