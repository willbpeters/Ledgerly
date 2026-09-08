//! Write a parsed SimpleFIN account set into SQLite. Each SimpleFIN account
//! is applied in its own transaction so one bad account never half-updates
//! another.
use super::parse::{SfAccount, SfAccountSet};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct SyncReport {
    pub accounts_synced: usize,
    pub holdings_synced: usize,
    pub holdings_skipped: usize,
    pub errors: Vec<String>,
}

pub fn apply(conn: &mut Connection, set: &SfAccountSet) -> Result<SyncReport, String> {
    let mut report = SyncReport { errors: set.errors.clone(), ..Default::default() };
    let now = chrono::Utc::now().to_rfc3339();
    for sf in &set.accounts {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        match apply_account(&tx, sf, &now) {
            Ok((synced, skipped)) => {
                tx.commit().map_err(|e| e.to_string())?;
                report.accounts_synced += 1;
                report.holdings_synced += synced;
                report.holdings_skipped += skipped;
            }
            Err(e) => {
                // tx drops → rolled back
                report.errors.push(format!("{}: {e}", sf.name));
            }
        }
    }
    Ok(report)
}

fn is_fund(description: &str) -> bool {
    let d = description.to_lowercase();
    d.contains("etf") || d.contains("fund") || d.contains("index") || d.contains("trust")
}

/// Returns (holdings synced, holdings skipped).
fn apply_account(tx: &Connection, sf: &SfAccount, now: &str) -> rusqlite::Result<(usize, usize)> {
    let existing: Option<i64> = tx
        .query_row("SELECT id FROM accounts WHERE external_id=?1", [&sf.id], |r| r.get(0))
        .optional()?;
    let account_id = match existing {
        Some(id) => id,
        None => {
            let type_ = if sf.holdings.is_empty() { "cash" } else { "brokerage" };
            tx.execute(
                "INSERT INTO accounts (name,type,institution,currency,created_at,source,external_id)
                 VALUES (?1,?2,?3,'USD',?4,'simplefin',?5)",
                params![sf.name, type_, sf.institution, now, sf.id],
            )?;
            tx.last_insert_rowid()
        }
    };
    tx.execute(
        "UPDATE accounts SET synced_balance=?1, last_synced_at=?2 WHERE id=?3",
        params![sf.balance, now, account_id],
    )?;

    let mut kept: Vec<i64> = Vec::new();
    let mut skipped = 0usize;
    for h in &sf.holdings {
        if h.symbol.is_empty() || h.shares <= 0.0 {
            skipped += 1;
            continue;
        }
        let kind = if is_fund(&h.description) { "etf" } else { "stock" };
        let name = if h.description.is_empty() { None } else { Some(h.description.as_str()) };
        let sec = crate::commands::securities::get_or_create(tx, &h.symbol, name, kind)?;
        tx.execute(
            "INSERT INTO synced_holdings (account_id,security_id,shares,cost_basis,market_value,as_of)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(account_id,security_id) DO UPDATE SET
               shares=excluded.shares, cost_basis=excluded.cost_basis,
               market_value=excluded.market_value, as_of=excluded.as_of",
            params![account_id, sec.id, h.shares, h.cost_basis, h.market_value, sf.balance_date],
        )?;
        let has_yahoo: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM prices WHERE security_id=?1 AND date=?2 AND source='yahoo')",
            params![sec.id, sf.balance_date],
            |r| r.get(0),
        )?;
        if !has_yahoo && h.market_value > 0.0 {
            crate::commands::prices::upsert(tx, sec.id, &sf.balance_date, h.market_value / h.shares, "simplefin")?;
        }
        kept.push(sec.id);
    }

    if kept.is_empty() {
        tx.execute("DELETE FROM synced_holdings WHERE account_id=?1", [account_id])?;
    } else {
        let ids = kept.iter().map(ToString::to_string).collect::<Vec<_>>().join(",");
        tx.execute(
            &format!("DELETE FROM synced_holdings WHERE account_id=?1 AND security_id NOT IN ({ids})"),
            [account_id],
        )?;
    }
    Ok((kept.len(), skipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::simplefin::parse::{SfAccount, SfHolding};

    fn holding(sym: &str, shares: f64, cost: f64, mv: f64) -> SfHolding {
        SfHolding { symbol: sym.into(), description: format!("{sym} Fund"), shares, cost_basis: cost, market_value: mv }
    }
    fn account(id: &str, balance: f64, holdings: Vec<SfHolding>) -> SfAccount {
        SfAccount {
            id: id.into(), name: format!("Acct {id}"), institution: "Demo Bank".into(),
            currency: "USD".into(), balance, balance_date: "2026-09-07".into(), holdings,
        }
    }
    fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn first_sync_creates_accounts_with_type_from_holdings() {
        let mut conn = db::open_in_memory().unwrap();
        let set = SfAccountSet {
            errors: vec![],
            accounts: vec![
                account("cash1", 100.0, vec![]),
                account("brk1", 5.0, vec![holding("VTI", 10.0, 2000.0, 2500.0)]),
            ],
        };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.accounts_synced, 2);
        assert_eq!(r.holdings_synced, 1);
        assert_eq!(r.holdings_skipped, 0);
        assert!(r.errors.is_empty());

        let t: String = conn.query_row("SELECT type FROM accounts WHERE external_id='cash1'", [], |r| r.get(0)).unwrap();
        assert_eq!(t, "cash");
        let t: String = conn.query_row("SELECT type FROM accounts WHERE external_id='brk1'", [], |r| r.get(0)).unwrap();
        assert_eq!(t, "brokerage");
        let src: String = conn.query_row("SELECT source FROM accounts WHERE external_id='brk1'", [], |r| r.get(0)).unwrap();
        assert_eq!(src, "simplefin");
        let bal: f64 = conn.query_row("SELECT synced_balance FROM accounts WHERE external_id='cash1'", [], |r| r.get(0)).unwrap();
        assert_eq!(bal, 100.0);
        // security created, holding row present, price written from market_value/shares
        assert_eq!(count(&conn, "SELECT count(*) FROM securities WHERE ticker='VTI' AND type='etf'"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM synced_holdings"), 1);
        let close: f64 = conn.query_row("SELECT close FROM prices WHERE source='simplefin'", [], |r| r.get(0)).unwrap();
        assert_eq!(close, 250.0);
    }

    #[test]
    fn second_sync_updates_in_place_and_removes_stale_holdings() {
        let mut conn = db::open_in_memory().unwrap();
        let first = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 5.0, vec![
            holding("VTI", 10.0, 2000.0, 2500.0), holding("AAPL", 1.0, 100.0, 150.0),
        ])] };
        apply(&mut conn, &first).unwrap();
        let second = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 9.0, vec![
            holding("VTI", 12.0, 2400.0, 3000.0),
        ])] };
        let r = apply(&mut conn, &second).unwrap();
        assert_eq!(r.accounts_synced, 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM accounts"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM synced_holdings"), 1);
        let shares: f64 = conn.query_row("SELECT shares FROM synced_holdings", [], |r| r.get(0)).unwrap();
        assert_eq!(shares, 12.0);
        let bal: f64 = conn.query_row("SELECT synced_balance FROM accounts", [], |r| r.get(0)).unwrap();
        assert_eq!(bal, 9.0);
    }

    #[test]
    fn skips_symbolless_and_zero_share_holdings() {
        let mut conn = db::open_in_memory().unwrap();
        let set = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 0.0, vec![
            holding("", 5.0, 5.0, 5.0), holding("VTI", 0.0, 0.0, 0.0), holding("AAPL", 1.0, 100.0, 150.0),
        ])] };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.holdings_synced, 1);
        assert_eq!(r.holdings_skipped, 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM securities"), 1);
    }

    #[test]
    fn does_not_overwrite_yahoo_price_for_same_date() {
        let mut conn = db::open_in_memory().unwrap();
        let sec = crate::commands::securities::get_or_create(&conn, "VTI", None, "etf").unwrap();
        crate::commands::prices::upsert(&conn, sec.id, "2026-09-07", 999.0, "yahoo").unwrap();
        let set = SfAccountSet { errors: vec![], accounts: vec![account("brk1", 0.0, vec![holding("VTI", 10.0, 2000.0, 2500.0)])] };
        apply(&mut conn, &set).unwrap();
        let close: f64 = conn.query_row("SELECT close FROM prices WHERE security_id=?1 AND date='2026-09-07'", [sec.id], |r| r.get(0)).unwrap();
        assert_eq!(close, 999.0);
    }

    #[test]
    fn feed_errors_are_passed_through() {
        let mut conn = db::open_in_memory().unwrap();
        let set = SfAccountSet { errors: vec!["Bank needs attention".into()], accounts: vec![] };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.errors, vec!["Bank needs attention".to_string()]);
        assert_eq!(r.accounts_synced, 0);
    }
}
