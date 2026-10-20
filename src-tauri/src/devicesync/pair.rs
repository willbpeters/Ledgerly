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
    let seed = files::seed_path(folder);
    if seed.exists() {
        return Err("That folder already has Ledgerly data from another computer. Choose Join on this computer instead.".into());
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
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().into_owned()])
        .map_err(|e| format!("Couldn't copy your data to the folder: {e}"))?;
    std::fs::rename(&tmp, seed).map_err(|e| format!("Couldn't finish copying your data to the folder: {e}"))
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
    settings::save(
        &settings::path(&paths.app_dir),
        &DeviceSyncSettings { folder: Some(folder.to_string_lossy().into_owned()), device_id: Some(id) },
    )?;
    Ok(safety)
}

/// Stop recording and forget the folder. The folder's files are left alone,
/// so the other computer keeps working and this one can join again.
pub fn stop(conn: &Connection, app_dir: &Path) -> Result<(), String> {
    meta::disable(conn).map_err(|e| e.to_string())?;
    settings::save(&settings::path(app_dir), &DeviceSyncSettings::default())
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
}
