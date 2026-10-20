//! Pairing two computers. The first writes a copy of its database to the
//! folder; the second joins by restoring that copy, through the backup
//! module's restore (so its own data is backed up first and the swap happens
//! at the restart, when Windows lets go of the file).
use super::settings::{self, DeviceSyncSettings};
use super::{files, meta};
use crate::backup::{restore, Attempt, Paths};
use chrono::NaiveDateTime;
use rusqlite::Connection;
use std::path::Path;

/// Make this computer the first: start recording, put a copy of this database
/// in `folder` for the other computer to join from, and remember the folder.
/// Writing the copy holds the database lock: it is a one-off, and Google
/// Drive for desktop writes to a local cache.
pub fn start_first(conn: &Connection, app_dir: &Path, folder: &Path) -> Result<DeviceSyncSettings, String> {
    // Starting again would give this computer a new id and a new folder while
    // the other computer still syncs with the old one.
    if is_on(&settings::load(&settings::path(app_dir))) {
        return Err("Sync is already on. Stop syncing first.".into());
    }
    let seed = files::seed_path(folder);
    if files::is_used(folder) {
        return Err("That folder already has Ledgerly sync data. Join it from this computer, or choose an empty folder.".into());
    }
    let id = meta::new_device_id(conn).map_err(|e| e.to_string())?;
    meta::enable(conn, &id).map_err(|e| e.to_string())?;
    if let Err(e) = write_seed(conn, &seed) {
        let _ = meta::disable(conn);
        return Err(e);
    }
    let s = DeviceSyncSettings { folder: Some(folder.to_string_lossy().into_owned()), device_id: Some(id) };
    // Recording without a saved folder would be undone at the next launch
    // anyway (adopt turns it off), so turn it off now rather than half-start.
    if let Err(e) = settings::save(&settings::path(app_dir), &s) {
        let _ = meta::disable(conn);
        return Err(e);
    }
    Ok(s)
}

/// `VACUUM INTO` a temporary name beside `seed`, then rename, so the other
/// computer never joins from half a file.
fn write_seed(conn: &Connection, seed: &Path) -> Result<(), String> {
    let dir = seed.parent().ok_or("No folder for the copy")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let tmp = seed.with_extension("sqlite.tmp");
    let _ = std::fs::remove_file(&tmp);
    let result = conn
        .execute("VACUUM INTO ?1", [tmp.to_string_lossy().into_owned()])
        .map_err(|e| format!("Couldn't copy your data to the folder: {e}"))
        // A bad copy must never reach the folder: the other computer would
        // join from it.
        .and_then(|_| restore::validate(&tmp))
        .and_then(|_| {
            files::rename_retrying(&tmp, seed)
                .map_err(|e| format!("Couldn't finish copying your data to the folder: {e}"))
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Join a folder the other computer started: stage its copy as a restore
/// (backing this computer's data up first) and remember the folder with a
/// fresh device id. The copy replaces this database at the restart. Returns
/// the safety backup.
pub fn join(conn: &Connection, paths: &Paths, folder: &Path, at: NaiveDateTime) -> Result<Attempt, String> {
    let seed = files::seed_path(folder);
    if !seed.exists() {
        return Err("There's no Ledgerly data in that folder yet. Turn on sync on your other computer first, choosing this same folder.".into());
    }
    let id = meta::new_device_id(conn).map_err(|e| e.to_string())?;
    let safety = restore::stage(conn, paths, &seed, at)?;
    let joined = DeviceSyncSettings { folder: Some(folder.to_string_lossy().into_owned()), device_id: Some(id) };
    if let Err(e) = settings::save(&settings::path(&paths.app_dir), &joined) {
        // Left staged, the next launch would swap the other computer's data
        // in with no fresh identity.
        let _ = std::fs::remove_file(paths.pending_restore());
        return Err(e);
    }
    Ok(safety)
}

/// Stop recording and forget the folder. The folder's files are left alone,
/// so the other computer keeps working and this one can join again.
pub fn stop(conn: &Connection, app_dir: &Path) -> Result<(), String> {
    meta::disable(conn).map_err(|e| e.to_string())?;
    settings::save(&settings::path(app_dir), &DeviceSyncSettings::default())
}

/// The same test `meta::adopt` uses at launch: a non-blank folder and an id.
fn is_on(s: &DeviceSyncSettings) -> bool {
    s.folder.as_deref().is_some_and(|f| !f.trim().is_empty()) && s.device_id.is_some()
}

/// Stage a backup for restore, turning sync off if it is on. A backup's
/// database has none of the change files recorded as applied, so if sync
/// stayed on, every file the other computer ever wrote would be replayed onto
/// that older data at the next round. The owner joins again afterwards.
/// If sync can't be turned off, nothing stays staged.
pub fn stage_restore(conn: &Connection, paths: &Paths, chosen: &Path, at: NaiveDateTime) -> Result<Attempt, String> {
    let safety = restore::stage(conn, paths, chosen, at)?;
    let path = settings::path(&paths.app_dir);
    if settings::load(&path) != DeviceSyncSettings::default() {
        if let Err(e) = stop(conn, &paths.app_dir) {
            let _ = std::fs::remove_file(paths.pending_restore());
            return Err(format!("Couldn't turn off sync between computers, so nothing was restored. {e}"));
        }
    }
    Ok(safety)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{self, test_at};
    use crate::db;

    struct Computer {
        _dir: tempfile::TempDir,
        paths: Paths,
        conn: Connection,
    }

    fn computer() -> Computer {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        let conn = db::open(&paths.db()).unwrap();
        Computer { _dir: dir, paths, conn }
    }

    #[test]
    fn the_first_computer_leaves_a_copy_in_the_folder_and_starts_recording() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        let s = start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();

        assert!(files::seed_path(drive.path()).exists());
        assert!(restore::validate(&files::seed_path(drive.path())).is_ok());
        assert_eq!(meta::get(&pc.conn, "enabled").unwrap().as_deref(), Some("1"));
        assert_eq!(settings::load(&settings::path(&pc.paths.app_dir)), s);
    }

    #[test]
    fn a_folder_another_computer_started_is_not_started_again() {
        let pc = computer();
        let laptop = computer();
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        let err = start_first(&laptop.conn, &laptop.paths.app_dir, drive.path()).unwrap_err();
        assert!(err.contains("Join"), "{err}");
    }

    #[test]
    fn joining_an_empty_folder_explains_what_to_do_first() {
        let laptop = computer();
        let drive = tempfile::tempdir().unwrap();
        let err = join(&laptop.conn, &laptop.paths, drive.path(), test_at("2026-10-16 09:00:00")).unwrap_err();
        assert!(err.contains("other computer first"), "{err}");
    }

    #[test]
    fn after_joining_and_restarting_the_laptop_has_the_pcs_data_under_its_own_id() {
        let pc = computer();
        pc.conn.execute_batch("INSERT INTO accounts (name,type,currency,created_at) VALUES ('Cash jar','cash','USD','2026-01-01');").unwrap();
        let drive = tempfile::tempdir().unwrap();
        let pc_settings = start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();

        let laptop = computer();
        join(&laptop.conn, &laptop.paths, drive.path(), test_at("2026-10-16 09:00:00")).unwrap();
        let Computer { _dir, paths, conn } = laptop;
        drop(conn); // the restart lets go of the file
        backup::startup::run(&paths, test_at("2026-10-16 09:00:05"));
        let conn = db::open(&paths.db()).unwrap();
        let laptop_settings = settings::load(&settings::path(&paths.app_dir));
        meta::adopt(&conn, &laptop_settings).unwrap();

        let jar: i64 = conn.query_row("SELECT count(*) FROM accounts WHERE name='Cash jar'", [], |r| r.get(0)).unwrap();
        assert_eq!(jar, 1);
        assert_ne!(laptop_settings.device_id, pc_settings.device_id);
        assert_eq!(meta::get(&conn, "device").unwrap(), laptop_settings.device_id);
    }

    #[test]
    fn stopping_turns_recording_off_and_forgets_the_folder() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        stop(&pc.conn, &pc.paths.app_dir).unwrap();
        assert_eq!(meta::get(&pc.conn, "enabled").unwrap().as_deref(), Some("0"));
        assert_eq!(settings::load(&settings::path(&pc.paths.app_dir)).folder, None);
        assert!(files::seed_path(drive.path()).exists(), "the shared folder is left alone");
    }

    #[test]
    fn a_failed_settings_save_leaves_no_staged_restore_behind() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        let laptop = computer();
        // A directory where the settings file belongs makes the save fail.
        std::fs::create_dir(settings::path(&laptop.paths.app_dir)).unwrap();
        let err = join(&laptop.conn, &laptop.paths, drive.path(), test_at("2026-10-16 09:00:00"));
        assert!(err.is_err());
        assert!(!laptop.paths.pending_restore().exists(), "the next launch must not swap the data in");
    }

    #[test]
    fn starting_again_while_syncing_is_refused() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        let first = start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        let other = tempfile::tempdir().unwrap();
        let err = start_first(&pc.conn, &pc.paths.app_dir, other.path()).unwrap_err();
        assert_eq!(err, "Sync is already on. Stop syncing first.");
        assert_eq!(settings::load(&settings::path(&pc.paths.app_dir)), first, "the first start is kept");
        assert_eq!(meta::get(&pc.conn, "device").unwrap(), first.device_id);
        assert!(!files::seed_path(other.path()).exists());
    }

    fn a_backup_of(c: &Computer) -> std::path::PathBuf {
        let file = c.paths.app_dir.join("old.sqlite");
        c.conn.execute("VACUUM INTO ?1", [file.to_string_lossy().into_owned()]).unwrap();
        file
    }

    #[test]
    fn restoring_a_backup_while_syncing_turns_sync_off() {
        let pc = computer();
        let backup = a_backup_of(&pc);
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();

        stage_restore(&pc.conn, &pc.paths, &backup, test_at("2026-10-16 09:00:00")).unwrap();
        assert!(pc.paths.pending_restore().exists());
        let s = settings::load(&settings::path(&pc.paths.app_dir));
        assert_eq!((s.folder, s.device_id), (None, None));
        assert_eq!(meta::get(&pc.conn, "enabled").unwrap().as_deref(), Some("0"));
    }

    #[test]
    fn restoring_a_backup_without_sync_leaves_no_sync_settings() {
        let pc = computer();
        let backup = a_backup_of(&pc);
        stage_restore(&pc.conn, &pc.paths, &backup, test_at("2026-10-16 09:00:00")).unwrap();
        assert!(pc.paths.pending_restore().exists());
        assert!(!settings::path(&pc.paths.app_dir).exists());
    }

    #[test]
    fn a_restore_that_cannot_turn_sync_off_is_not_staged() {
        let pc = computer();
        let backup = a_backup_of(&pc);
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        // A directory where the temp file goes makes the settings save fail.
        std::fs::create_dir(settings::path(&pc.paths.app_dir).with_extension("json.tmp")).unwrap();

        let err = stage_restore(&pc.conn, &pc.paths, &backup, test_at("2026-10-16 09:00:00")).unwrap_err();
        assert!(err.contains("nothing was restored"), "{err}");
        assert!(!pc.paths.pending_restore().exists(), "the old backup must not be swapped in still synced");
    }

    #[test]
    fn a_stale_temporary_copy_is_replaced_and_none_is_left() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        let tmp = drive.path().join("seed.sqlite.tmp");
        std::fs::write(&tmp, "junk from a crashed attempt").unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        assert!(files::seed_path(drive.path()).exists());
        assert!(!tmp.exists());
    }

    #[test]
    fn a_failed_start_turns_recording_back_off() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        // A non-empty directory in the temp name's place: it can be neither
        // removed as a file nor written by VACUUM.
        let tmp = drive.path().join("seed.sqlite.tmp");
        std::fs::create_dir(&tmp).unwrap();
        std::fs::write(tmp.join("x"), "x").unwrap();
        assert!(start_first(&pc.conn, &pc.paths.app_dir, drive.path()).is_err());
        assert_eq!(meta::get(&pc.conn, "enabled").unwrap().as_deref(), Some("0"));
        assert!(!settings::path(&pc.paths.app_dir).exists());
        assert!(!files::seed_path(drive.path()).exists());
    }

    #[test]
    fn a_folder_used_before_is_not_started_again() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(drive.path().join("changes/pc")).unwrap();
        std::fs::write(drive.path().join("changes/pc/0000000000001-1.json"), "{}").unwrap();
        let err = start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap_err();
        assert!(err.contains("already has Ledgerly sync data"), "{err}");
        assert!(!settings::path(&pc.paths.app_dir).exists());
    }

    #[test]
    fn an_empty_changes_folder_does_not_count_as_used() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(drive.path().join("changes")).unwrap();
        std::fs::create_dir_all(drive.path().join("devices")).unwrap();
        assert!(start_first(&pc.conn, &pc.paths.app_dir, drive.path()).is_ok());
    }

    #[test]
    fn the_outbox_the_pc_had_when_the_copy_was_made_is_emptied_on_the_laptop() {
        let pc = computer();
        let drive = tempfile::tempdir().unwrap();
        start_first(&pc.conn, &pc.paths.app_dir, drive.path()).unwrap();
        pc.conn.execute_batch("INSERT INTO accounts (name,type,currency,created_at) VALUES ('Wallet','cash','USD','2026-01-01');").unwrap();
        let queued: i64 = pc.conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get(0)).unwrap();
        assert!(queued > 0, "the PC has unsent edits");
        write_seed(&pc.conn, &files::seed_path(drive.path())).unwrap();

        let laptop = computer();
        join(&laptop.conn, &laptop.paths, drive.path(), test_at("2026-10-16 09:00:00")).unwrap();
        let Computer { _dir, paths, conn } = laptop;
        drop(conn);
        backup::startup::run(&paths, test_at("2026-10-16 09:00:05"));
        let conn = db::open(&paths.db()).unwrap();
        meta::adopt(&conn, &settings::load(&settings::path(&paths.app_dir))).unwrap();
        let left: i64 = conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
