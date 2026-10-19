//! `device-sync.json` beside the database: which shared folder, and this
//! computer's device id. Beside rather than inside the database, because
//! joining replaces the database with the other computer's copy, and that copy
//! must not decide who this computer is.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeviceSyncSettings {
    pub folder: Option<String>,
    pub device_id: Option<String>,
}

pub fn path(app_dir: &Path) -> PathBuf {
    app_dir.join("device-sync.json")
}

/// Missing or unreadable means "not syncing": it must never stop the app opening.
pub fn load(path: &Path) -> DeviceSyncSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &DeviceSyncSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // Write a temp file and swap it in, so a crash mid-write can't leave a torn
    // file that `load` would read as "not syncing" and forget the device id.
    // rename replaces an existing file in one step (on Windows too), so there is
    // no moment when the settings file is missing.
    let tmp = path.with_extension("json.tmp");
    let err = |e: std::io::Error| format!("Couldn't save the sync settings: {e}");
    std::fs::write(&tmp, json).map_err(err)?;
    std::fs::rename(&tmp, path).map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_means_not_syncing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&path(dir.path())), DeviceSyncSettings::default());
    }

    #[test]
    fn a_torn_file_loads_as_not_syncing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), "{").unwrap();
        assert_eq!(load(&path(dir.path())), DeviceSyncSettings::default());
    }

    #[test]
    fn saving_over_an_existing_file_replaces_it_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = DeviceSyncSettings { folder: Some("a".into()), device_id: Some("1".into()) };
        let second = DeviceSyncSettings { folder: Some("b".into()), device_id: Some("2".into()) };
        save(&path(dir.path()), &first).unwrap();
        save(&path(dir.path()), &second).unwrap();
        assert_eq!(load(&path(dir.path())), second);
        assert!(!dir.path().join("device-sync.json.tmp").exists());
    }

    #[test]
    fn settings_survive_a_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let s = DeviceSyncSettings { folder: Some(r"G:\My Drive\Ledgerly Sync".into()), device_id: Some("ab12".into()) };
        save(&path(dir.path()), &s).unwrap();
        assert_eq!(load(&path(dir.path())), s);
    }
}
