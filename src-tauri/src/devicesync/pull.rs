//! Taking the other computer's edits: note which files are applied (lock),
//! read the new ones (no lock: Google Drive may download them first), then
//! apply them in one transaction (lock).
use super::apply::{self, Outcome};
use super::files::{self, Change, ChangeFile, FORMAT};
use super::meta;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// A waiting change older than this is dropped: its row will not come.
pub const PENDING_DAYS: i64 = 60;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PullReport {
    pub applied: usize,
    /// Changes still waiting for their row, after this pull.
    pub waiting: usize,
    /// Changes that would not apply (a constraint failed).
    pub skipped: usize,
    /// Files from a newer Tally, left for after an update.
    pub newer_files: usize,
}

pub struct Fetched {
    pub name: String,
    pub file: ChangeFile,
}

pub fn applied_names(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT name FROM sync_files_applied")?;
    let names = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(names)
}

/// The other computer's files not yet applied. A file that does not parse is
/// most likely still arriving through Google Drive. It is left for the next round.
pub fn fetch(folder: &Path, me: &str, applied: &HashSet<String>) -> Vec<Fetched> {
    files::list_others(folder, me)
        .into_iter()
        .filter(|name| !applied.contains(name))
        .filter_map(|name| files::read(folder, &name).ok().map(|file| Fetched { name, file }))
        // A file must sit in its own device's folder and not claim to be ours.
        .filter(|f| f.name.starts_with(&format!("{}/", f.file.device)) && f.file.device != me)
        .collect()
}

/// Does applying this change call for re-sorting automatic rows?
fn affects_sorting(c: &Change) -> bool {
    matches!(c.tbl.as_str(), "category_rules" | "categories") || (c.tbl == "bank_transactions" && c.field == "category")
}

fn read_pending(conn: &Connection) -> rusqlite::Result<Vec<(i64, String, Change)>> {
    let mut stmt = conn.prepare("SELECT id, device, tbl, key, field, value, at FROM sync_pending ORDER BY at, id")?;
    let rows = stmt.query_map([], |r| {
        let value: Option<String> = r.get(5)?;
        Ok((
            r.get(0)?,
            r.get(1)?,
            Change {
                tbl: r.get(2)?,
                key: r.get(3)?,
                field: r.get(4)?,
                value: value.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or(serde_json::Value::Null),
                at: r.get(6)?,
            },
        ))
    })?;
    rows.collect()
}

/// Apply one change inside its own savepoint. A constraint violation rolls
/// back just this change (so a half-made security does not linger) and counts
/// as a skip. Any other error (disk full, I/O, busy) may have rolled the
/// whole transaction back already, so it ends the pull instead of letting the
/// loop carry on in autocommit.
fn apply_guarded(tx: &Connection, device: &str, c: &Change, report: &mut PullReport) -> rusqlite::Result<Option<Outcome>> {
    tx.execute_batch("SAVEPOINT change")?;
    match apply::apply(tx, device, c) {
        Ok(outcome) => {
            tx.execute_batch("RELEASE change")?;
            Ok(Some(outcome))
        }
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            tx.execute_batch("ROLLBACK TO change; RELEASE change")?;
            eprintln!("device sync: skipped {} {} {}", c.tbl, c.key, c.field);
            report.skipped += 1;
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// One transaction, with the triggers silenced: apply the new files' changes
/// oldest first, retry waiting changes (including ones that just began
/// waiting, since their row may arrive later in the same round), record the
/// files, and re-sort automatic rows if a rule or category changed.
pub fn apply_all(conn: &Connection, fetched: &[Fetched], schema: i64, now_ms: i64) -> rusqlite::Result<PullReport> {
    let tx = conn.unchecked_transaction()?;
    meta::set(&tx, "applying", "1")?;
    let mut report = PullReport::default();
    let mut resort = false;

    let already = applied_names(&tx)?;
    let mut usable: Vec<&Fetched> = Vec::new();
    for f in fetched {
        if f.file.schema > schema || f.file.format > FORMAT {
            report.newer_files += 1;
        } else if !already.contains(&f.name) {
            usable.push(f);
        }
    }
    let mut changes: Vec<(&str, &Change)> = usable
        .iter()
        .flat_map(|f| f.file.changes.iter().map(move |c| (f.file.device.as_str(), c)))
        .collect();
    changes.sort_by(|a, b| (a.1.at, a.0).cmp(&(b.1.at, b.0)));

    for (device, c) in changes {
        match apply_guarded(&tx, device, c, &mut report)? {
            Some(Outcome::Applied) => {
                report.applied += 1;
                resort |= affects_sorting(c);
            }
            Some(Outcome::Waiting) => {
                tx.execute(
                    "INSERT INTO sync_pending (device, tbl, key, field, value, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![device, c.tbl, c.key, c.field, c.value.to_string(), c.at],
                )?;
            }
            Some(Outcome::Stale) | None => {}
        }
    }

    for (id, device, c) in read_pending(&tx)? {
        // Replaced by a newer whole-row change (create or delete), or by a
        // change from the same device in the same millisecond that landed
        // first this round. That one is the later edit, and the same-device
        // tie rule would otherwise let this older one overwrite it.
        let replaced: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM sync_clock WHERE tbl=?1 AND key=?2
               AND ((field='_row' AND at>?3) OR (field=?4 AND at=?3 AND device=?5)))",
            params![c.tbl, c.key, c.at, c.field, device],
            |r| r.get(0),
        )?;
        let expired = now_ms - c.at > PENDING_DAYS * 86_400_000;
        if !replaced {
            match apply_guarded(&tx, &device, &c, &mut report)? {
                Some(Outcome::Waiting) if !expired => continue,
                Some(Outcome::Applied) => {
                    report.applied += 1;
                    resort |= affects_sorting(&c);
                }
                _ => {}
            }
        }
        tx.execute("DELETE FROM sync_pending WHERE id=?1", [id])?;
    }

    for f in &usable {
        tx.execute("INSERT OR IGNORE INTO sync_files_applied (name) VALUES (?1)", [&f.name])?;
    }
    if resort {
        crate::budget::store::recategorise_all(&tx)?;
    }
    report.waiting = tx.query_row("SELECT count(*) FROM sync_pending", [], |r| r.get::<_, i64>(0))? as usize;
    meta::set(&tx, "applying", "0")?;
    tx.commit()?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use serde_json::json;

    const DAY: i64 = 86_400_000;

    fn laptop() -> Connection {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        meta::enable(&conn, "laptop").unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description,payee)
               VALUES (1,'TRN-1','2026-10-01',-5,'BLUE BOTTLE #12','Blue Bottle');",
        )
        .unwrap();
        conn
    }

    fn file(name: &str, schema: i64, changes: Vec<Change>) -> Fetched {
        Fetched { name: name.into(), file: ChangeFile { format: FORMAT, schema, device: "pc".into(), changes } }
    }

    fn note(key: &str, text: &str, at: i64) -> Change {
        Change { tbl: "bank_transactions".into(), key: key.into(), field: "note".into(), value: json!(text), at }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_file_is_applied_once_and_remembered() {
        let conn = laptop();
        let f = file("pc/1-1.json", 9, vec![note("sf:ACT-1|TRN-1", "lunch", 10)]);
        let report = apply_all(&conn, std::slice::from_ref(&f), 9, 100).unwrap();
        assert_eq!(report.applied, 1);
        assert!(applied_names(&conn).unwrap().contains("pc/1-1.json"));
        assert_eq!(count(&conn, "SELECT count(*) FROM sync_outbox"), 0, "nothing echoed back");
        assert_eq!(meta::get(&conn, "applying").unwrap().as_deref(), Some("0"));

        // The same file again (Drive can list it twice) changes nothing.
        let again = apply_all(&conn, std::slice::from_ref(&f), 9, 200).unwrap();
        assert_eq!(again.applied, 0);
        assert_eq!(
            conn.query_row("SELECT note FROM bank_transactions WHERE external_id='TRN-1'", [], |r| r.get::<_, String>(0)).unwrap(),
            "lunch"
        );
    }

    #[test]
    fn a_waiting_edit_does_not_overwrite_a_later_one_from_the_same_millisecond() {
        let conn = laptop();
        apply_all(&conn, &[file("pc/1-1.json", 9, vec![note("sf:ACT-1|TRN-2", "first", 10)])], 9, 100).unwrap();
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description) VALUES (1,'TRN-2','2026-10-02',-30,'Dinner');",
        )
        .unwrap();
        // The PC's next file carries its later edit, made in the same millisecond.
        apply_all(&conn, &[file("pc/2-2.json", 9, vec![note("sf:ACT-1|TRN-2", "second", 10)])], 9, 200).unwrap();
        let got: String =
            conn.query_row("SELECT note FROM bank_transactions WHERE external_id='TRN-2'", [], |r| r.get(0)).unwrap();
        assert_eq!(got, "second");
        assert_eq!(count(&conn, "SELECT count(*) FROM sync_pending"), 0);
    }

    #[test]
    fn a_change_waits_for_its_transaction_and_lands_once_simplefin_brings_it() {
        let conn = laptop();
        let f = file("pc/1-1.json", 9, vec![note("sf:ACT-1|TRN-2", "dinner", 10)]);
        let report = apply_all(&conn, &[f], 9, 100).unwrap();
        assert_eq!(report.waiting, 1);

        // This computer's next SimpleFIN sync fetches TRN-2.
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description) VALUES (1,'TRN-2','2026-10-02',-30,'Dinner');",
        )
        .unwrap();
        let report = apply_all(&conn, &[], 9, 200).unwrap();
        assert_eq!((report.applied, report.waiting), (1, 0));
        assert_eq!(
            conn.query_row("SELECT note FROM bank_transactions WHERE external_id='TRN-2'", [], |r| r.get::<_, String>(0)).unwrap(),
            "dinner"
        );
    }

    #[test]
    fn a_change_that_never_finds_its_row_is_dropped_after_sixty_days() {
        let conn = laptop();
        apply_all(&conn, &[file("pc/1-1.json", 9, vec![note("sf:GONE|X", "x", 10)])], 9, 100).unwrap();
        let report = apply_all(&conn, &[], 9, 10 + (PENDING_DAYS + 1) * DAY).unwrap();
        assert_eq!(report.waiting, 0);
    }

    #[test]
    fn a_file_from_a_newer_tally_is_left_for_later() {
        let conn = laptop();
        let report = apply_all(&conn, &[file("pc/1-1.json", 99, vec![note("sf:ACT-1|TRN-1", "x", 10)])], 9, 100).unwrap();
        assert_eq!((report.applied, report.newer_files), (0, 1));
        assert!(!applied_names(&conn).unwrap().contains("pc/1-1.json"));
    }

    #[test]
    fn a_new_rule_re_sorts_automatic_rows() {
        let conn = laptop();
        let rule = Change {
            tbl: "category_rules".into(), key: "payee:blue bottle".into(), field: "_row".into(),
            value: json!({"match_type":"payee","pattern":"blue bottle","category":"cat:Fees","created_at":"2026-10-16"}),
            at: 10,
        };
        apply_all(&conn, &[file("pc/1-1.json", 9, vec![rule])], 9, 100).unwrap();
        let name: String = conn
            .query_row("SELECT c.name FROM bank_transactions b JOIN categories c ON c.id=b.category_id", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Fees");
    }

    #[test]
    fn fetching_reads_new_files_and_skips_applied_and_unreadable_ones() {
        let dir = tempfile::tempdir().unwrap();
        let cf = ChangeFile { format: FORMAT, schema: 9, device: "pc".into(), changes: vec![] };
        files::write_change_file(dir.path(), "pc/0000000000001-1.json", &cf).unwrap();
        files::write_change_file(dir.path(), "pc/0000000000002-2.json", &cf).unwrap();
        std::fs::write(dir.path().join("changes/pc/0000000000003-3.json"), "{\"format\":").unwrap();

        let applied: HashSet<String> = ["pc/0000000000001-1.json".to_string()].into();
        let got = fetch(dir.path(), "laptop", &applied);
        assert_eq!(got.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["pc/0000000000002-2.json"]);
    }

    #[test]
    fn a_constraint_failure_is_skipped_and_leaves_nothing_behind() {
        let conn = laptop();
        // The security is fine; the transaction's own NOT NULL type is not.
        let row = json!({"account":"sf:ACT-1","security":{"ticker":"ZZZ","name":"Zed","type":"stock","currency":"USD"},"type":null,"date":"2026-10-01"});
        let c = Change { tbl: "transactions".into(), key: "txn:bad".into(), field: "_row".into(), value: row, at: 10 };
        let report = apply_all(&conn, &[file("pc/1-1.json", 9, vec![c])], 9, 100).unwrap();
        assert_eq!(report.skipped, 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM securities WHERE ticker='ZZZ'"), 0, "the half-made security is rolled back");
        assert_eq!(meta::get(&conn, "applying").unwrap().as_deref(), Some("0"));
    }

    #[test]
    fn a_waiting_change_lands_when_its_category_arrives_in_the_same_round() {
        let conn = laptop();
        let budget = Change { tbl: "budgets".into(), key: "cat:Golf|*".into(), field: "_row".into(), value: json!({"limit_amount": 50.0}), at: 5 };
        let golf = Change {
            tbl: "categories".into(), key: "cat:Golf".into(), field: "_row".into(),
            value: json!({"name":"Golf","kind":"spending","colour":"chart-3","sort":200,"is_builtin":0}), at: 10,
        };
        let report = apply_all(&conn, &[file("pc/1-1.json", 9, vec![budget, golf])], 9, 100).unwrap();
        assert_eq!(report.waiting, 0);
        assert_eq!(count(&conn, "SELECT count(*) FROM budgets b JOIN categories c ON c.id=b.category_id WHERE c.name='Golf'"), 1);
    }

    #[test]
    fn a_waiting_change_is_dropped_once_a_newer_whole_row_replaced_it() {
        let conn = laptop();
        conn.execute("INSERT INTO sync_pending (device, tbl, key, field, value, at) VALUES ('pc','budgets','cat:Ghost|*','limit_amount','40',5)", []).unwrap();
        super::super::clock::record(&conn, "budgets", "cat:Ghost|*", "_row", 10, "pc").unwrap();
        let report = apply_all(&conn, &[], 9, 100).unwrap();
        assert_eq!(report.waiting, 0);
    }

    #[test]
    fn a_file_filed_under_another_device_or_claiming_this_one_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let cf = ChangeFile { format: FORMAT, schema: 9, device: "laptop".into(), changes: vec![] };
        files::write_change_file(dir.path(), "pc/0000000000001-1.json", &cf).unwrap();
        let other = ChangeFile { format: FORMAT, schema: 9, device: "tablet".into(), changes: vec![] };
        files::write_change_file(dir.path(), "pc/0000000000002-2.json", &other).unwrap();
        assert!(fetch(dir.path(), "laptop", &HashSet::new()).is_empty());
    }
}
