//! Backups, restore and CSV export.
//! Design: docs/superpowers/specs/2026-10-14-backup-and-export-design.md
pub mod naming;
pub mod settings;

use chrono::NaiveDateTime;
use naming::Kind;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

/// Every file this module touches, all inside the app data folder.
#[derive(Debug, Clone)]
pub struct Paths {
    pub app_dir: PathBuf,
}

impl Paths {
    pub fn new(app_dir: impl Into<PathBuf>) -> Self {
        Paths { app_dir: app_dir.into() }
    }
    pub fn db(&self) -> PathBuf {
        self.app_dir.join("finance.sqlite")
    }
    pub fn backups(&self) -> PathBuf {
        self.app_dir.join("backups")
    }
    /// A backup waiting to replace the database at the next launch. It lives
    /// here, not in the folder it came from, so a USB drive can be unplugged
    /// once the restore has been staged.
    pub fn pending_restore(&self) -> PathBuf {
        self.app_dir.join("finance.sqlite.restore-pending")
    }
    /// Beside the database rather than inside it, so restoring an older backup
    /// does not forget where the extra copies go.
    pub fn settings(&self) -> PathBuf {
        self.app_dir.join("backup-settings.json")
    }
}

/// The outcome of one backup attempt. A failure is an outcome, not a panic:
/// a backup problem must never stop the app opening.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Attempt {
    pub at: String,
    pub kind: Kind,
    pub file: Option<String>,
    pub error: Option<String>,
    /// The backup worked, but something beside it did not (the extra-folder
    /// copy, pruning).
    pub warning: Option<String>,
}

/// What this session knows that the files on disk do not: what went wrong.
pub struct BackupState {
    pub paths: Paths,
    pub last_attempt: Mutex<Option<Attempt>>,
    pub restore_error: Mutex<Option<String>>,
}

impl BackupState {
    pub fn new(paths: Paths, last_attempt: Option<Attempt>, restore_error: Option<String>) -> Self {
        BackupState {
            paths,
            last_attempt: Mutex::new(last_attempt),
            restore_error: Mutex::new(restore_error),
        }
    }

    pub fn record(&self, attempt: &Attempt) {
        *self.last_attempt.lock().unwrap_or_else(|e| e.into_inner()) = Some(attempt.clone());
    }
}

/// The local date and time. Local, not UTC, for the same reason the frontend
/// has `localIsoDate()`: on a Pacific-time evening the UTC date is tomorrow,
/// which would date tonight's backup tomorrow and skip tomorrow's.
pub fn now() -> NaiveDateTime {
    chrono::Local::now().naive_local()
}

/// `2026-10-14T09:30:12`, the form `Attempt::at` is reported in.
pub fn stamp(at: NaiveDateTime) -> String {
    at.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// A throwaway app data folder. Keep the `TempDir`: dropping it deletes the folder.
#[cfg(test)]
pub(crate) fn test_paths() -> (tempfile::TempDir, Paths) {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::new(dir.path());
    (dir, paths)
}

/// A migrated database on disk at `paths.db()` holding one account, "Checking".
#[cfg(test)]
pub(crate) fn populated_db(paths: &Paths) -> rusqlite::Connection {
    let conn = crate::db::open(&paths.db()).unwrap();
    conn.execute(
        "INSERT INTO accounts (name, type, created_at) VALUES ('Checking', 'cash', '2026-10-14')",
        [],
    )
    .unwrap();
    conn
}

#[cfg(test)]
pub(crate) fn test_at(s: &str) -> NaiveDateTime {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
}
