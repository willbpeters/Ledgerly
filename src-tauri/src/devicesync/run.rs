//! One sync round. The database lock is held only for the quick parts;
//! reading and writing the shared folder happens without it, because Google
//! Drive may download a file before it can be read (the rule from commit
//! 2fc0f46: never hold the database lock across a download).
use super::files::{self, ChangeFile, DeviceInfo, FORMAT};
use super::{outbox, pair, pull, settings};
use crate::db::{Db, TARGET_VERSION};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct RunReport {
    pub at: String,
    pub pushed: usize,
    pub applied: usize,
    pub waiting: usize,
    pub skipped: usize,
    pub newer_files: usize,
}

/// Send this computer's edits, then take the other computer's.
pub fn round(db: &Db, folder: &Path, device: &str, device_name: &str) -> Result<RunReport, String> {
    let lock = || db.0.lock().unwrap_or_else(|e| e.into_inner());
    let now = chrono::Utc::now().timestamp_millis();

    let (taken, applied) = {
        let conn = lock();
        (
            outbox::take(&conn).map_err(|e| e.to_string())?,
            pull::applied_names(&conn).map_err(|e| e.to_string())?,
        )
    };

    let mut report = RunReport { at: crate::backup::stamp(crate::backup::now()), ..Default::default() };
    if let Some(taken) = taken {
        let name = files::file_name(device, now, taken.last_seq);
        let file = ChangeFile { format: FORMAT, schema: TARGET_VERSION, device: device.into(), changes: taken.changes.clone() };
        files::write_change_file(folder, &name, &file)?;
        outbox::commit(&lock(), device, &name, &taken).map_err(|e| e.to_string())?;
        report.pushed = taken.changes.len();
    }

    // `applied` only saves reading files already taken; apply_all checks
    // again under the lock, in case another round applied one meanwhile.
    let fetched = pull::fetch(folder, device, &applied);
    let pulled = pull::apply_all(&lock(), &fetched, TARGET_VERSION, now).map_err(|e| e.to_string())?;
    report.applied = pulled.applied;
    report.waiting = pulled.waiting;
    report.skipped = pulled.skipped;
    report.newer_files = pulled.newer_files;

    // Only for the other computer's card. A failure here is not a failed sync.
    let _ = files::write_device(folder, &DeviceInfo { id: device.into(), name: device_name.into(), last_sync: report.at.clone() });
    Ok(report)
}

/// Stop syncing, after one last round so edits not yet sent reach the folder
/// for the other computer. That round is best effort: an unreachable folder
/// must never keep the owner from turning sync off. Its failure comes back as
/// `Some(warning)`, so the owner knows the last edits stayed on this computer.
pub fn stop(db: &Db, app_dir: &Path, device_name: &str) -> Result<Option<String>, String> {
    let s = settings::load(&settings::path(app_dir));
    let mut warning = None;
    if let (Some(folder), Some(id)) = (&s.folder, &s.device_id) {
        if let Err(e) = round(db, Path::new(folder), id, device_name) {
            warning = Some(format!("Sync is off, but your last edits couldn't be sent to the other computer. {e}"));
        }
    }
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    pair::stop(&conn, app_dir)?;
    Ok(warning)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{self, test_at, Paths};
    use crate::db;
    use crate::devicesync::meta;
    use std::sync::Mutex;

    struct Computer {
        _dir: tempfile::TempDir,
        db: Db,
        id: String,
    }

    /// The PC, with one SimpleFIN card and one coffee on it, started as the
    /// first computer; and the laptop, joined and restarted.
    fn pair_up(drive: &Path) -> (Computer, Computer) {
        let pc_dir = tempfile::tempdir().unwrap();
        let pc_paths = Paths::new(pc_dir.path());
        let pc = db::open(&pc_paths.db()).unwrap();
        crate::budget::seed::test_categories(&pc);
        pc.execute_batch(
            "INSERT INTO accounts (name,type,currency,created_at,source,external_id)
               VALUES ('Card','credit','USD','2026-01-01','simplefin','ACT-1');
             INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
               VALUES (1,'TRN-1','2026-10-01',-5,'Coffee');",
        )
        .unwrap();
        let pc_id = pair::start_first(&pc, &pc_paths.app_dir, drive).unwrap().device_id.unwrap();

        let laptop_dir = tempfile::tempdir().unwrap();
        let laptop_paths = Paths::new(laptop_dir.path());
        let laptop = db::open(&laptop_paths.db()).unwrap();
        crate::budget::seed::test_categories(&laptop);
        pair::join(&laptop, &laptop_paths, drive, test_at("2026-10-16 09:00:00")).unwrap();
        drop(laptop);
        backup::startup::run(&laptop_paths, test_at("2026-10-16 09:00:05"));
        let laptop = db::open(&laptop_paths.db()).unwrap();
        crate::budget::seed::test_categories(&laptop);
        let s = settings::load(&settings::path(&laptop_paths.app_dir));
        meta::adopt(&laptop, &s).unwrap();

        (
            Computer { _dir: pc_dir, db: Db(Mutex::new(pc)), id: pc_id },
            Computer { _dir: laptop_dir, db: Db(Mutex::new(laptop)), id: s.device_id.unwrap() },
        )
    }

    fn exec(c: &Computer, sql: &str) {
        c.db.0.lock().unwrap().execute_batch(sql).unwrap();
    }

    fn text(c: &Computer, sql: &str) -> Option<String> {
        c.db.0.lock().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn an_edit_on_either_computer_reaches_the_other() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, laptop) = pair_up(drive.path());

        exec(&pc, "UPDATE bank_transactions SET category_id=(SELECT id FROM categories WHERE name='Dining'),
                     category_source='manual' WHERE external_id='TRN-1';");
        assert_eq!(round(&pc.db, drive.path(), &pc.id, "PC").unwrap().pushed, 1);
        assert_eq!(round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap().applied, 1);
        assert_eq!(
            text(&laptop, "SELECT c.name FROM bank_transactions b JOIN categories c ON c.id=b.category_id").as_deref(),
            Some("Dining")
        );

        exec(&laptop, "UPDATE bank_transactions SET note='with Sam' WHERE external_id='TRN-1';");
        assert_eq!(round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap().pushed, 1);
        round(&pc.db, drive.path(), &pc.id, "PC").unwrap();
        assert_eq!(text(&pc, "SELECT note FROM bank_transactions").as_deref(), Some("with Sam"));

        // A file is applied once: the next round on either side finds nothing new.
        assert_eq!(round(&pc.db, drive.path(), &pc.id, "PC").unwrap().applied, 0);
        assert_eq!(round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap().applied, 0);
    }

    #[test]
    fn an_edit_to_a_transaction_the_laptop_has_not_fetched_lands_after_its_bank_sync() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, laptop) = pair_up(drive.path());
        let new_row = "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
                         VALUES ((SELECT id FROM accounts WHERE external_id='ACT-1'),'TRN-2','2026-10-02',-30,'Dinner');";

        exec(&pc, new_row);
        exec(&pc, "UPDATE bank_transactions SET removed=1 WHERE external_id='TRN-2';");
        round(&pc.db, drive.path(), &pc.id, "PC").unwrap();
        assert_eq!(round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap().waiting, 1);

        exec(&laptop, new_row); // the laptop's SimpleFIN sync
        let report = round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap();
        assert_eq!((report.applied, report.waiting), (1, 0));
        assert_eq!(text(&laptop, "SELECT CAST(removed AS TEXT) FROM bank_transactions WHERE external_id='TRN-2'").as_deref(), Some("1"));
    }

    #[test]
    fn stopping_sends_the_edits_not_yet_sent_first() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, laptop) = pair_up(drive.path());
        exec(&pc, "UPDATE bank_transactions SET note='last one' WHERE external_id='TRN-1';");

        assert_eq!(stop(&pc.db, pc._dir.path(), "PC").unwrap(), None);
        assert_eq!(settings::load(&settings::path(pc._dir.path())).folder, None);
        assert_eq!(round(&laptop.db, drive.path(), &laptop.id, "LAPTOP").unwrap().applied, 1);
        assert_eq!(text(&laptop, "SELECT note FROM bank_transactions").as_deref(), Some("last one"));
    }

    #[test]
    fn stopping_works_when_the_folder_cannot_be_reached() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, _laptop) = pair_up(drive.path());
        exec(&pc, "UPDATE bank_transactions SET note='stuck' WHERE external_id='TRN-1';");
        // A file where the folder should be: the last round can't write there.
        let blocker = drive.path().join("blocker");
        std::fs::write(&blocker, "x").unwrap();
        let unreachable = settings::DeviceSyncSettings {
            folder: Some(blocker.join("Sync").to_string_lossy().into_owned()),
            device_id: Some(pc.id.clone()),
        };
        settings::save(&settings::path(pc._dir.path()), &unreachable).unwrap();

        let warning = stop(&pc.db, pc._dir.path(), "PC").unwrap();
        assert!(warning.is_some_and(|w| w.contains("couldn't be sent")), "the owner hears the last edits stayed here");
        assert_eq!(settings::load(&settings::path(pc._dir.path())).folder, None);
        assert_eq!(text(&pc, "SELECT value FROM sync_meta WHERE name='enabled'").as_deref(), Some("0"));
    }

    #[test]
    fn each_computer_sees_the_other_in_the_folder() {
        let drive = tempfile::tempdir().unwrap();
        let (pc, laptop) = pair_up(drive.path());
        round(&pc.db, drive.path(), &pc.id, "PC").unwrap();
        let others = files::list_devices(drive.path(), &laptop.id);
        assert_eq!(others.len(), 1);
        assert_eq!(others[0].name, "PC");
    }
}
