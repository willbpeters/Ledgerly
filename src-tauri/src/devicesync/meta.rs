//! The `sync_meta` table: this computer's device id as the triggers see it,
//! and the `enabled` / `applying` switches the `sync_on` view reads.
use super::settings::DeviceSyncSettings;
use rusqlite::{Connection, OptionalExtension};

pub fn get(conn: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM sync_meta WHERE name=?1", [name], |r| r.get(0)).optional()
}

pub fn set(conn: &Connection, name: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO sync_meta (name, value) VALUES (?1, ?2)", [name, value])?;
    Ok(())
}

/// 16 hex characters. SQLite's randomblob, so no extra crate.
pub fn new_device_id(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT lower(hex(randomblob(8)))", [], |r| r.get(0))
}

pub fn enable(conn: &Connection, device_id: &str) -> rusqlite::Result<()> {
    set(conn, "device", device_id)?;
    set(conn, "enabled", "1")
}

pub fn disable(conn: &Connection) -> rusqlite::Result<()> {
    set(conn, "enabled", "0")
}

/// Run at every launch, after the database opens. The settings file, not the
/// database, says who this computer is. A database whose device id differs
/// is a copy from the other computer (just joined), so its outbox holds the
/// other computer's edits, which that computer sends itself, and is emptied.
/// A folder without a device id (or a blank folder) deliberately means
/// recording is off: without an id this computer can't tell its edits apart.
pub fn adopt(conn: &Connection, settings: &DeviceSyncSettings) -> rusqlite::Result<()> {
    let folder = settings.folder.as_deref().filter(|f| !f.trim().is_empty());
    match (folder, &settings.device_id) {
        (Some(_), Some(id)) => {
            if get(conn, "device")?.as_deref() != Some(id.as_str()) {
                conn.execute("DELETE FROM sync_outbox", [])?;
            }
            set(conn, "applying", "0")?;
            enable(conn, id)
        }
        _ => disable(conn),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn outbox_len(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM sync_outbox", [], |r| r.get(0)).unwrap()
    }

    fn syncing(id: &str) -> DeviceSyncSettings {
        DeviceSyncSettings { folder: Some(r"G:\Sync".into()), device_id: Some(id.into()) }
    }

    #[test]
    fn device_ids_are_sixteen_hex_characters_and_differ() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        let a = new_device_id(&conn).unwrap();
        let b = new_device_id(&conn).unwrap();
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
        assert_ne!(a, b);
    }

    #[test]
    fn adopting_turns_recording_on_with_this_computers_id() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        adopt(&conn, &syncing("laptop")).unwrap();
        assert_eq!(get(&conn, "device").unwrap().as_deref(), Some("laptop"));
        assert_eq!(get(&conn, "enabled").unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn a_copy_from_the_other_computer_forgets_that_computers_unsent_edits() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        enable(&conn, "pc").unwrap();
        conn.execute_batch("UPDATE categories SET colour='chart-9' WHERE name='Dining';").unwrap();
        assert_eq!(outbox_len(&conn), 1);

        adopt(&conn, &syncing("laptop")).unwrap();

        assert_eq!(outbox_len(&conn), 0, "the PC sends its own edits; the laptop must not resend them");
        assert_eq!(get(&conn, "device").unwrap().as_deref(), Some("laptop"));
    }

    #[test]
    fn this_computers_own_unsent_edits_survive_a_restart() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        adopt(&conn, &syncing("pc")).unwrap();
        conn.execute_batch("UPDATE categories SET colour='chart-9' WHERE name='Dining';").unwrap();
        adopt(&conn, &syncing("pc")).unwrap();
        assert_eq!(outbox_len(&conn), 1);
    }

    #[test]
    fn a_folder_without_a_device_id_means_recording_is_off() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        enable(&conn, "pc").unwrap();
        let s = DeviceSyncSettings { folder: Some(r"G:\Sync".into()), device_id: None };
        adopt(&conn, &s).unwrap();
        assert_eq!(get(&conn, "enabled").unwrap().as_deref(), Some("0"));
    }

    #[test]
    fn an_empty_folder_means_recording_is_off() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        enable(&conn, "pc").unwrap();
        for folder in ["", "   "] {
            let s = DeviceSyncSettings { folder: Some(folder.into()), device_id: Some("pc".into()) };
            adopt(&conn, &s).unwrap();
            assert_eq!(get(&conn, "enabled").unwrap().as_deref(), Some("0"));
            enable(&conn, "pc").unwrap();
        }
    }

    #[test]
    fn adopting_clears_a_stuck_applying_flag() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        set(&conn, "applying", "1").unwrap();
        adopt(&conn, &syncing("pc")).unwrap();
        assert_eq!(get(&conn, "applying").unwrap().as_deref(), Some("0"));
        conn.execute_batch("UPDATE categories SET colour='chart-9' WHERE name='Dining';").unwrap();
        assert_eq!(outbox_len(&conn), 1);
    }

    #[test]
    fn no_folder_means_recording_is_off() {
        let conn = db::open_in_memory().unwrap();
        crate::budget::seed::test_categories(&conn);
        enable(&conn, "pc").unwrap();
        adopt(&conn, &DeviceSyncSettings::default()).unwrap();
        assert_eq!(get(&conn, "enabled").unwrap().as_deref(), Some("0"));
    }
}
