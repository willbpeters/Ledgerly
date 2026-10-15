//! Choosing a backup to restore. The swap itself happens at the next launch,
//! in `startup`, because Windows will not replace a file the app has open.
use super::naming::Kind;
use super::{snapshot, Attempt, Paths};
use chrono::NaiveDateTime;
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

/// A healthy SQLite file that has Ledgerly's `accounts` table. Without the
/// second check, any `.sqlite` file on the disk could replace the finances.
pub fn validate(path: &Path) -> Result<(), String> {
    snapshot::check(path)?;
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if tables == 1 {
        Ok(())
    } else {
        Err("That file isn't a Ledgerly backup.".to_string())
    }
}

/// Check `chosen`, back up the current database, then copy `chosen` to the
/// pending-restore path for the next launch to swap in. Returns the safety
/// backup. Nothing is staged unless the safety backup succeeded: a restore
/// must always be undoable.
pub fn stage(conn: &Connection, paths: &Paths, chosen: &Path, at: NaiveDateTime) -> Result<Attempt, String> {
    validate(chosen)?;
    let safety = snapshot::attempt(conn, paths, Kind::PreRestore, at);
    if let Some(e) = &safety.error {
        return Err(format!("Couldn't back up your current data first, so nothing was restored. {e}"));
    }
    std::fs::copy(chosen, paths.pending_restore())
        .map_err(|e| format!("Couldn't stage the backup for restore: {e}"))?;
    Ok(safety)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{populated_db, snapshot, test_at, test_paths};

    #[test]
    fn a_sqlite_file_that_is_not_ledgerly_is_refused() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let other = paths.app_dir.join("other.sqlite");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE notes (t TEXT);").unwrap();

        let err = stage(&conn, &paths, &other, test_at("2026-10-14 09:00:00")).unwrap_err();
        assert!(err.contains("isn't a Ledgerly backup"), "{err}");
        assert!(!paths.pending_restore().exists());
        assert!(snapshot::list(&paths.backups()).is_empty(), "no safety backup for a refused restore");
    }

    #[test]
    fn a_file_that_is_not_a_database_is_refused() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let junk = paths.app_dir.join("junk.sqlite");
        std::fs::write(&junk, "not a database").unwrap();

        assert!(stage(&conn, &paths, &junk, test_at("2026-10-14 09:00:00")).is_err());
        assert!(!paths.pending_restore().exists());
    }

    #[test]
    fn a_valid_backup_is_staged_after_a_safety_backup() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let chosen = snapshot::create(&conn, &paths.backups(), None, Kind::Manual, test_at("2026-10-13 09:00:00"))
            .unwrap()
            .file;

        let safety = stage(&conn, &paths, &chosen, test_at("2026-10-14 09:00:00")).unwrap();

        assert_eq!(safety.kind, Kind::PreRestore);
        assert!(paths.pending_restore().exists());
        assert!(snapshot::list(&paths.backups()).iter().any(|e| e.kind == Kind::PreRestore));
    }
}
