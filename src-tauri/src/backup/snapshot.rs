//! Making a backup: write it with `VACUUM INTO`, check it, copy it to the extra
//! folder, prune old dailies.
use super::naming::{self, Kind};
use super::{settings, stamp, Attempt, Paths};
use chrono::NaiveDateTime;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// One backup as the Settings card lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    pub file_name: String,
    pub path: String,
    pub date: String,
    pub time: String,
    pub kind: Kind,
    pub size: u64,
}

pub struct Created {
    pub file: PathBuf,
    pub warning: Option<String>,
}

/// The file names in `dir`; empty if it does not exist yet.
pub fn names_in(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// The backups in `dir`, newest first. Files Ledgerly did not name are skipped.
pub fn list(dir: &Path) -> Vec<Entry> {
    let mut found: Vec<(naming::Parsed, Entry)> = names_in(dir)
        .into_iter()
        .filter_map(|name| {
            let parsed = naming::parse(&name)?;
            let path = dir.join(&name);
            let size = fs::metadata(&path).ok()?.len();
            let entry = Entry {
                path: path.to_string_lossy().into_owned(),
                date: parsed.date.format("%Y-%m-%d").to_string(),
                time: parsed.time.format("%H:%M:%S").to_string(),
                kind: parsed.kind,
                size,
                file_name: name,
            };
            Some((parsed, entry))
        })
        .collect();
    found.sort_by(|a, b| {
        (b.0.date, b.0.time, &b.1.file_name).cmp(&(a.0.date, a.0.time, &a.1.file_name))
    });
    found.into_iter().map(|(_, e)| e).collect()
}

/// Open read-only and run SQLite's own consistency check. A backup nobody has
/// checked is not a backup.
pub fn check(path: &Path) -> Result<(), String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(|e| format!("{} isn't a readable database: {e}", path.display()))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("{} failed SQLite's check: {result}", path.display()))
    }
}

/// Write a backup of `conn` into `dir`, check it, prune old dailies there, and
/// copy it to `extra` if given. Only a failure of the main backup is an error;
/// trouble with pruning or the extra copy comes back as a warning.
pub fn create(
    conn: &Connection,
    dir: &Path,
    extra: Option<&Path>,
    kind: Kind,
    at: NaiveDateTime,
) -> Result<Created, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the backups folder: {e}"))?;
    let file = (1..)
        .map(|n| dir.join(naming::file_name(at, kind, n)))
        .find(|p| !p.exists())
        .expect("an unused name");

    // VACUUM INTO writes a consistent copy even mid-write, unlike a file copy.
    conn.execute("VACUUM INTO ?1", [file.to_string_lossy().into_owned()])
        .map_err(|e| format!("Couldn't write the backup: {e}"))?;
    if let Err(e) = check(&file) {
        let _ = fs::remove_file(&file);
        return Err(e);
    }

    let mut warnings = Vec::new();
    if let Err(e) = prune(dir) {
        warnings.push(e);
    }
    if let Some(extra) = extra {
        if let Err(e) = copy_to_extra(&file, extra) {
            warnings.push(e);
        }
    }
    let warning = if warnings.is_empty() { None } else { Some(warnings.join(" ")) };
    Ok(Created { file, warning })
}

/// One backup, reported as an `Attempt` whatever happens. Reads the extra
/// folder from the settings file each time, so a change in Settings applies
/// to the very next backup.
pub fn attempt(conn: &Connection, paths: &Paths, kind: Kind, at: NaiveDateTime) -> Attempt {
    let extra = settings::load(&paths.settings()).extra_folder.map(PathBuf::from);
    match create(conn, &paths.backups(), extra.as_deref(), kind, at) {
        Ok(made) => Attempt {
            at: stamp(at),
            kind,
            file: Some(made.file.to_string_lossy().into_owned()),
            error: None,
            warning: made.warning,
        },
        Err(e) => Attempt { at: stamp(at), kind, file: None, error: Some(e), warning: None },
    }
}

fn prune(dir: &Path) -> Result<(), String> {
    for name in naming::to_prune(&names_in(dir), naming::KEEP_DAILY) {
        fs::remove_file(dir.join(&name))
            .map_err(|e| format!("Couldn't remove the old backup {name}: {e}"))?;
    }
    Ok(())
}

fn copy_to_extra(file: &Path, extra: &Path) -> Result<(), String> {
    let fail = |e: std::io::Error| {
        format!("Saved here, but couldn't copy it to {}: {e}", extra.display())
    };
    fs::create_dir_all(extra).map_err(fail)?;
    fs::copy(file, extra.join(file.file_name().expect("a backup has a file name"))).map_err(fail)?;
    prune(extra)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{populated_db, test_at, test_paths};

    fn accounts_in(path: &Path) -> i64 {
        Connection::open(path)
            .unwrap()
            .query_row("SELECT count(*) FROM accounts", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_backup_holds_the_same_rows() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let made = create(&conn, &paths.backups(), None, Kind::Manual, test_at("2026-10-14 09:30:12")).unwrap();

        assert!(made.file.ends_with("ledgerly-2026-10-14-093012-manual.sqlite"));
        assert_eq!(accounts_in(&made.file), 1);
        assert_eq!(made.warning, None);
    }

    #[test]
    fn two_backups_in_the_same_second_get_different_names() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let at = test_at("2026-10-14 09:30:12");
        create(&conn, &paths.backups(), None, Kind::Manual, at).unwrap();
        let second = create(&conn, &paths.backups(), None, Kind::Manual, at).unwrap();
        assert!(second.file.ends_with("ledgerly-2026-10-14-093012-manual-2.sqlite"));
    }

    #[test]
    fn a_backup_is_copied_to_the_extra_folder() {
        let (_dir, paths) = test_paths();
        let extra = tempfile::tempdir().unwrap();
        let conn = populated_db(&paths);
        let made = create(&conn, &paths.backups(), Some(extra.path()), Kind::Manual, test_at("2026-10-14 09:30:12")).unwrap();

        assert!(extra.path().join(made.file.file_name().unwrap()).exists());
        assert_eq!(made.warning, None);
    }

    #[test]
    fn an_unreachable_extra_folder_warns_but_keeps_the_backup() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        // A folder cannot be created inside a file, which stands in for an
        // unplugged drive.
        let blocker = paths.app_dir.join("blocker");
        fs::write(&blocker, "x").unwrap();
        let unreachable = blocker.join("sub");
        let made = create(&conn, &paths.backups(), Some(unreachable.as_path()), Kind::Manual, test_at("2026-10-14 09:30:12")).unwrap();

        assert!(made.file.exists());
        assert!(made.warning.unwrap().contains("couldn't copy it"));
    }

    #[test]
    fn a_new_daily_prunes_the_oldest_but_never_other_kinds() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let dir = paths.backups();
        fs::create_dir_all(&dir).unwrap();
        for d in 1..=14 {
            let name = naming::file_name(test_at(&format!("2026-09-{d:02} 09:00:00")), Kind::Daily, 1);
            fs::write(dir.join(name), "old").unwrap();
        }
        let manual = naming::file_name(test_at("2026-08-01 09:00:00"), Kind::Manual, 1);
        fs::write(dir.join(&manual), "old").unwrap();

        create(&conn, &dir, None, Kind::Daily, test_at("2026-10-14 09:00:00")).unwrap();

        let names = names_in(&dir);
        let dailies = names.iter().filter(|n| n.ends_with("-daily.sqlite")).count();
        assert_eq!(dailies, naming::KEEP_DAILY);
        assert!(!names.contains(&naming::file_name(test_at("2026-09-01 09:00:00"), Kind::Daily, 1)));
        assert!(names.contains(&manual));
    }

    #[test]
    fn a_file_that_is_not_a_database_fails_the_check() {
        let (_dir, paths) = test_paths();
        let bad = paths.app_dir.join("bad.sqlite");
        fs::write(&bad, "this is not a database, just text").unwrap();
        assert!(check(&bad).is_err());
    }

    #[test]
    fn the_list_is_newest_first_and_ignores_other_files() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        create(&conn, &paths.backups(), None, Kind::Manual, test_at("2026-10-13 09:00:00")).unwrap();
        create(&conn, &paths.backups(), None, Kind::Daily, test_at("2026-10-14 09:00:00")).unwrap();
        fs::write(paths.backups().join("notes.txt"), "hi").unwrap();

        let list = list(&paths.backups());
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].date.as_str(), list[0].time.as_str(), list[0].kind), ("2026-10-14", "09:00:00", Kind::Daily));
        assert_eq!(list[1].kind, Kind::Manual);
        assert!(list[0].size > 0);
    }

    #[test]
    fn an_attempt_reports_a_failure_instead_of_failing() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        // A file where the backups folder should be: the folder cannot be made.
        fs::write(paths.backups(), "in the way").unwrap();

        let attempt = attempt(&conn, &paths, Kind::Daily, test_at("2026-10-14 09:00:00"));
        assert_eq!(attempt.kind, Kind::Daily);
        assert_eq!(attempt.at, "2026-10-14T09:00:00");
        assert!(attempt.file.is_none());
        assert!(attempt.error.unwrap().contains("backups folder"));
    }

    #[test]
    fn an_attempt_uses_the_saved_extra_folder() {
        let (_dir, paths) = test_paths();
        let extra = tempfile::tempdir().unwrap();
        settings::save(
            &paths.settings(),
            &settings::BackupSettings { extra_folder: Some(extra.path().to_string_lossy().into_owned()) },
        )
        .unwrap();
        let conn = populated_db(&paths);

        let attempt = attempt(&conn, &paths, Kind::Manual, test_at("2026-10-14 09:00:00"));
        assert!(attempt.error.is_none());
        assert_eq!(names_in(extra.path()).len(), 1);
    }
}
