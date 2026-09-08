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
    pub transactions_added: usize,
    pub transactions_updated: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Default)]
struct AccountResult {
    holdings_synced: usize,
    holdings_skipped: usize,
    transactions_added: usize,
    transactions_updated: usize,
}

pub fn apply(conn: &mut Connection, set: &SfAccountSet) -> Result<SyncReport, String> {
    let mut report = SyncReport { errors: set.errors.clone(), ..Default::default() };
    let now = chrono::Utc::now().to_rfc3339();
    // Rules are read once: they change only when the user edits a category.
    let rules = crate::budget::store::load_rules(conn).map_err(|e| e.to_string())?;
    for sf in &set.accounts {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        match apply_account(&tx, sf, &now, &rules) {
            Ok(r) => {
                tx.commit().map_err(|e| e.to_string())?;
                report.accounts_synced += 1;
                report.holdings_synced += r.holdings_synced;
                report.holdings_skipped += r.holdings_skipped;
                report.transactions_added += r.transactions_added;
                report.transactions_updated += r.transactions_updated;
            }
            Err(e) => {
                // tx drops → rolled back
                report.errors.push(format!("{}: {e}", sf.name));
            }
        }
    }
    Ok(report)
}

/// SimpleFIN does not say what kind of account something is, so infer it:
/// anything reporting holdings is a brokerage, a negative balance is money
/// owed, and everything else is cash. The user can correct it in Accounts.
fn infer_type(sf: &SfAccount) -> &'static str {
    if !sf.holdings.is_empty() {
        "brokerage"
    } else if sf.balance < 0.0 {
        "credit"
    } else {
        "cash"
    }
}

fn is_fund(description: &str) -> bool {
    let d = description.to_lowercase();
    d.contains("etf") || d.contains("fund") || d.contains("index") || d.contains("trust")
}

fn apply_account(
    tx: &Connection,
    sf: &SfAccount,
    now: &str,
    rules: &[crate::budget::categorize::Rule],
) -> rusqlite::Result<AccountResult> {
    let existing: Option<i64> = tx
        .query_row("SELECT id FROM accounts WHERE external_id=?1", [&sf.id], |r| r.get(0))
        .optional()?;
    let account_id = match existing {
        Some(id) => id,
        None => {
            tx.execute(
                "INSERT INTO accounts (name,type,institution,currency,created_at,source,external_id)
                 VALUES (?1,?2,?3,'USD',?4,'simplefin',?5)",
                params![sf.name, infer_type(sf), sf.institution, now, sf.id],
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

    // Bank transactions arrive only when the fetch asked for them, so an
    // empty list here means "not requested", never "delete what we hold".
    let incoming: Vec<crate::budget::store::IncomingTxn> = sf
        .transactions
        .iter()
        .map(|t| crate::budget::store::IncomingTxn {
            external_id: t.id.clone(),
            posted: t.posted.clone(),
            amount: t.amount,
            description: t.description.clone(),
            payee: t.payee.clone(),
            memo: t.memo.clone(),
            mcc: t.mcc.clone(),
            pending: t.pending,
        })
        .collect();
    let counts = crate::budget::store::upsert_transactions(tx, account_id, &incoming, rules)?;

    Ok(AccountResult {
        holdings_synced: kept.len(),
        holdings_skipped: skipped,
        transactions_added: counts.added,
        transactions_updated: counts.updated,
    })
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
            transactions: vec![],
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
    fn account_type_is_inferred_from_holdings_and_balance_sign() {
        let mut conn = db::open_in_memory().unwrap();
        let mut card = account("card1", -240.10, vec![]);
        card.transactions = vec![crate::simplefin::parse::SfTransaction {
            id: "t1".into(), posted: "2026-09-01".into(), amount: -55.5,
            description: "Fishing bait".into(), payee: Some("John's Fishin Shack".into()),
            memo: None, mcc: Some("5812".into()), pending: false,
        }];
        let set = SfAccountSet { errors: vec![], accounts: vec![
            card,
            account("cash1", 8420.55, vec![]),
            account("brk1", 5.0, vec![holding("VTI", 10.0, 2000.0, 2500.0)]),
        ] };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.transactions_added, 1);
        assert_eq!(r.transactions_updated, 0);

        let type_of = |ext: &str| -> String {
            conn.query_row("SELECT type FROM accounts WHERE external_id=?1", [ext], |r| r.get(0)).unwrap()
        };
        assert_eq!(type_of("card1"), "credit", "a negative balance is money owed");
        assert_eq!(type_of("cash1"), "cash");
        assert_eq!(type_of("brk1"), "brokerage");

        // The transaction was categorised from its merchant code on the way in.
        let category: Option<String> = conn.query_row(
            "SELECT c.name FROM bank_transactions t LEFT JOIN categories c ON c.id=t.category_id",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(category.as_deref(), Some("Dining"));
    }

    #[test]
    fn a_sync_without_transactions_never_deletes_the_ones_we_hold() {
        let mut conn = db::open_in_memory().unwrap();
        let mut with = account("card1", -10.0, vec![]);
        with.transactions = vec![crate::simplefin::parse::SfTransaction {
            id: "t1".into(), posted: "2026-09-01".into(), amount: -5.0,
            description: "Coffee".into(), payee: None, memo: None, mcc: None, pending: false,
        }];
        apply(&mut conn, &SfAccountSet { errors: vec![], accounts: vec![with] }).unwrap();

        // A later balances-only sync carries no transactions at all.
        let r = apply(&mut conn, &SfAccountSet { errors: vec![], accounts: vec![account("card1", -10.0, vec![])] }).unwrap();
        assert_eq!(r.transactions_added, 0);
        let n: i64 = conn.query_row("SELECT count(*) FROM bank_transactions", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the stored transaction must survive");
    }

    #[test]
    fn feed_errors_are_passed_through() {
        let mut conn = db::open_in_memory().unwrap();
        let set = SfAccountSet { errors: vec!["Bank needs attention".into()], accounts: vec![] };
        let r = apply(&mut conn, &set).unwrap();
        assert_eq!(r.errors, vec!["Bank needs attention".to_string()]);
        assert_eq!(r.accounts_synced, 0);
    }

    /// The whole SimpleFIN path against the public demo bridge: resolve what
    /// the user pasted into an access URL, fetch the feed, and write it to a
    /// database. Ignored by default because it needs the network; run with
    /// `cargo test live_demo_end_to_end -- --ignored --nocapture`.
    ///
    /// Uses the demo *access URL* rather than the demo setup token: the shared
    /// token at bridge.simplefin.org/simplefin/claim/demo is permanently
    /// claimed and answers 403 to everyone.
    #[test]
    #[ignore = "hits the network"]
    fn live_demo_categorises_real_transactions() {
        use crate::simplefin::client::{fetch_accounts_in, Range, MAX_WINDOW_DAYS};
        let set = fetch_accounts_in(
            "https://demo:demo@beta-bridge.simplefin.org/simplefin",
            Range::last_days(MAX_WINDOW_DAYS),
        ).unwrap();

        let mut conn = db::open_in_memory().unwrap();
        let report = apply(&mut conn, &set).unwrap();
        assert!(report.transactions_added > 0, "the demo feed should import transactions");

        // Re-applying the same feed must update rather than duplicate.
        let again = apply(&mut conn, &set).unwrap();
        assert_eq!(again.transactions_added, 0);
        assert_eq!(again.transactions_updated, report.transactions_added);

        // The merchant codes in the feed should land real categories.
        let categorised: i64 = conn.query_row(
            "SELECT count(*) FROM bank_transactions WHERE category_id IS NOT NULL", [], |r| r.get(0),
        ).unwrap();
        assert!(categorised > 0, "merchant codes should have categorised something");

        let groceries: i64 = conn.query_row(
            "SELECT count(*) FROM bank_transactions t JOIN categories c ON c.id=t.category_id
             WHERE c.name='Groceries'", [], |r| r.get(0),
        ).unwrap();
        assert!(groceries > 0, "the demo's 5411 rows should be Groceries");
    }

    #[test]
    #[ignore = "hits the network"]
    fn live_demo_end_to_end() {
        const DEMO_ACCESS_URL: &str = "https://demo:demo@beta-bridge.simplefin.org/simplefin";
        let access_url = crate::simplefin::client::resolve_access_url(DEMO_ACCESS_URL).unwrap();
        assert!(access_url.starts_with("https://"));

        let set = crate::simplefin::client::fetch_accounts(&access_url).unwrap();
        assert!(!set.accounts.is_empty(), "demo feed should have accounts");

        let mut conn = db::open_in_memory().unwrap();
        let first = apply(&mut conn, &set).unwrap();
        assert_eq!(first.accounts_synced, set.accounts.len());

        // Syncing the same feed again must update in place, not duplicate.
        let second = apply(&mut conn, &set).unwrap();
        assert_eq!(second.accounts_synced, set.accounts.len());
        let accounts: i64 = conn
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(accounts, set.accounts.len() as i64);

        let unsynced: i64 = conn
            .query_row(
                "SELECT count(*) FROM accounts WHERE source!='simplefin' OR synced_balance IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unsynced, 0, "every account should be marked synced");
    }
}
