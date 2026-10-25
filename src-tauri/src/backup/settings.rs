//! `backup-settings.json`: where extra copies of each backup go.
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BackupSettings {
    pub extra_folder: Option<String>,
}

/// A missing or unreadable file means "no extra folder". It must never stop a
/// backup from being made in the main folder.
pub fn load(path: &Path) -> BackupSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, settings: &BackupSettings) -> Result<(), String> {
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Couldn't save the backup settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_file_means_no_extra_folder() {
        let (_dir, paths) = crate::backup::test_paths();
        assert_eq!(load(&paths.settings()), BackupSettings::default());
    }

    #[test]
    fn settings_survive_a_save_and_load() {
        let (_dir, paths) = crate::backup::test_paths();
        let s = BackupSettings { extra_folder: Some(r"E:\Tally backups".into()) };
        save(&paths.settings(), &s).unwrap();
        assert_eq!(load(&paths.settings()), s);
    }

    #[test]
    fn an_unreadable_file_means_no_extra_folder_rather_than_an_error() {
        let (_dir, paths) = crate::backup::test_paths();
        std::fs::write(paths.settings(), "{ not json").unwrap();
        assert_eq!(load(&paths.settings()), BackupSettings::default());
    }
}
