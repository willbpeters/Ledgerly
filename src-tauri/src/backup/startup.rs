//! What happens at launch, before `db::open`: swap in a staged restore, then
//! take the launch backup — `pre-migration` if opening will change the
//! database, otherwise `daily` if none has been made today.
use super::naming::{self, Kind};
use super::{restore, snapshot, stamp, Attempt, Paths};
use chrono::NaiveDateTime;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
pub struct StartupReport {
    pub restore_error: Option<String>,
    pub attempt: Option<Attempt>,
}

/// Runs before `db::open`. Never fails: problems are reported for Settings to
/// show, because a backup problem must not become a can't-open-the-app problem.
pub fn run(paths: &Paths, at: NaiveDateTime) -> StartupReport {
    let restore_error = apply_pending_restore(paths).err();
    let attempt = if paths.db().exists() { backup_if_due(paths, at) } else { None };
    StartupReport { restore_error, attempt }
}

fn backup_if_due(paths: &Paths, at: NaiveDateTime) -> Option<Attempt> {
    let failed = |e: String| Attempt {
        at: stamp(at),
        kind: Kind::Daily,
        file: None,
        error: Some(format!("Couldn't open the database to back it up: {e}")),
        warning: None,
    };
    let conn = match Connection::open(paths.db()) {
        Ok(c) => c,
        Err(e) => return Some(failed(e.to_string())),
    };
    let kind = match crate::db::migration_pending(&conn) {
        Ok(true) => Kind::PreMigration,
        Ok(false) if naming::has_backup_on(&snapshot::names_in(&paths.backups()), at.date()) => return None,
        Ok(false) => Kind::Daily,
        Err(e) => return Some(failed(e.to_string())),
    };
    Some(snapshot::attempt(&conn, paths, kind, at))
}

/// `finance.sqlite-journal` and friends.
fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", db.display()))
}

/// Swap a staged backup in. The old database's journal files go first: SQLite
/// would replay a leftover journal into the restored file and corrupt it.
fn apply_pending_restore(paths: &Paths) -> Result<(), String> {
    let pending = paths.pending_restore();
    if !pending.exists() {
        return Ok(());
    }
    if let Err(e) = restore::validate(&pending) {
        let _ = fs::remove_file(&pending);
        return Err(format!("The backup chosen for restore couldn't be used, so nothing was changed. {e}"));
    }
    let db = paths.db();
    for suffix in ["-journal", "-wal", "-shm"] {
        let file = sidecar(&db, suffix);
        if file.exists() {
            fs::remove_file(&file).map_err(|e| format!("Couldn't clear {}: {e}", file.display()))?;
        }
    }
    rename_with_retry(&pending, &db).map_err(|e| format!("Couldn't swap in the restored backup: {e}"))
}

/// The previous instance is still exiting when the restarted one gets here,
/// and Windows will not replace a file another process still has open, so
/// give it a moment rather than failing the restore.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_) if tries < 10 => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{populated_db, snapshot, test_at, test_paths};

    fn account_names(paths: &Paths) -> Vec<String> {
        let conn = Connection::open(paths.db()).unwrap();
        let mut stmt = conn.prepare("SELECT name FROM accounts ORDER BY id").unwrap();
        let names = stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        names
    }

    #[test]
    fn the_first_run_has_nothing_to_back_up() {
        let (_dir, paths) = test_paths();
        let report = run(&paths, test_at("2026-10-14 09:00:00"));
        assert_eq!(report.attempt, None);
        assert_eq!(report.restore_error, None);
        assert!(!paths.backups().exists());
    }

    #[test]
    fn one_daily_backup_per_day() {
        let (_dir, paths) = test_paths();
        drop(populated_db(&paths));

        let first = run(&paths, test_at("2026-10-14 09:00:00")).attempt.unwrap();
        assert_eq!(first.kind, Kind::Daily);
        assert!(first.error.is_none());

        assert_eq!(run(&paths, test_at("2026-10-14 15:00:00")).attempt, None);

        let next_day = run(&paths, test_at("2026-10-15 08:00:00")).attempt.unwrap();
        assert_eq!(next_day.kind, Kind::Daily);
    }

    #[test]
    fn a_database_about_to_migrate_gets_a_pre_migration_backup() {
        let (_dir, paths) = test_paths();
        // user_version 0: opening it would apply the whole schema.
        Connection::open(paths.db()).unwrap().execute_batch("CREATE TABLE t (x INTEGER);").unwrap();

        let attempt = run(&paths, test_at("2026-10-14 09:00:00")).attempt.unwrap();
        assert_eq!(attempt.kind, Kind::PreMigration);
        assert!(attempt.error.is_none());
    }

    #[test]
    fn a_staged_restore_replaces_the_database_and_drops_a_stale_journal() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let backup = snapshot::create(&conn, &paths.backups(), None, Kind::Manual, test_at("2026-10-13 09:00:00"))
            .unwrap()
            .file;
        conn.execute("INSERT INTO accounts (name, type, created_at) VALUES ('Brokerage', 'brokerage', '2026-10-14')", [])
            .unwrap();
        drop(conn);
        fs::copy(&backup, paths.pending_restore()).unwrap();
        let journal = sidecar(&paths.db(), "-journal");
        fs::write(&journal, "a journal from the old database").unwrap();

        let report = run(&paths, test_at("2026-10-14 09:00:00"));

        assert_eq!(report.restore_error, None);
        assert_eq!(account_names(&paths), vec!["Checking".to_string()]);
        assert!(!paths.pending_restore().exists());
        assert!(!journal.exists());
    }

    #[test]
    fn a_broken_staged_restore_is_discarded_and_the_database_kept() {
        let (_dir, paths) = test_paths();
        drop(populated_db(&paths));
        fs::write(paths.pending_restore(), "not a database").unwrap();

        let report = run(&paths, test_at("2026-10-14 09:00:00"));

        assert!(report.restore_error.unwrap().contains("nothing was changed"));
        assert!(!paths.pending_restore().exists());
        assert_eq!(account_names(&paths), vec!["Checking".to_string()]);
    }
}
