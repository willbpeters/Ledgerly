//! The shared folder's layout and the change file format. Every file has one
//! writer and is never changed after it is written, so Google Drive never has
//! to merge two computers' edits to one file.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Bumped only if the file layout itself changes. Schema changes are carried
/// by `ChangeFile::schema` instead.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub tbl: String,
    pub key: String,
    pub field: String,
    /// `null` on `_row` means deleted.
    pub value: serde_json::Value,
    /// Milliseconds since 1970 when the edit was made.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeFile {
    pub format: u32,
    /// The writer's `db::TARGET_VERSION`.
    pub schema: i64,
    pub device: String,
    pub changes: Vec<Change>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    /// Local time, `2026-10-16T09:30:12`.
    pub last_sync: String,
}

pub fn seed_path(folder: &Path) -> PathBuf {
    folder.join("seed.sqlite")
}

fn changes_dir(folder: &Path) -> PathBuf {
    folder.join("changes")
}

fn devices_dir(folder: &Path) -> PathBuf {
    folder.join("devices")
}

/// Write beside `path` under a `.tmp` name, then rename, so no reader (this
/// computer, the other one, or Google Drive's uploader) ever sees half a file.
pub fn write_atomically(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    // No remove first: Rust's rename already replaces an existing file on
    // Windows in one step, and removing would leave a moment with no file.
    fs::rename(&tmp, path).map_err(|e| format!("Couldn't finish writing {}: {e}", path.display()))
}

/// `<device>/<written at, ms>-<last outbox seq>.json`: the path below
/// `changes/`, and the name a file is recorded under once applied.
pub fn file_name(device: &str, written_at: i64, last_seq: i64) -> String {
    format!("{device}/{written_at:013}-{last_seq}.json")
}

pub fn write_change_file(folder: &Path, name: &str, file: &ChangeFile) -> Result<(), String> {
    let json = serde_json::to_vec(file).map_err(|e| e.to_string())?;
    write_atomically(&changes_dir(folder).join(name), &json)
}

/// Every change file written by a computer other than `me`, by recorded
/// name, oldest first. Half-written `.tmp` files are skipped.
pub fn list_others(folder: &Path, me: &str) -> Vec<String> {
    let mut names = Vec::new();
    let Ok(devices) = fs::read_dir(changes_dir(folder)) else { return names };
    for device in devices.filter_map(|d| d.ok()) {
        let Ok(device_name) = device.file_name().into_string() else { continue };
        if device_name == me || !device.path().is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(device.path()) else { continue };
        for f in files.filter_map(|f| f.ok()) {
            if let Ok(n) = f.file_name().into_string() {
                if n.ends_with(".json") {
                    names.push(format!("{device_name}/{n}"));
                }
            }
        }
    }
    names.sort();
    names
}

pub fn read(folder: &Path, name: &str) -> Result<ChangeFile, String> {
    let bytes = fs::read(changes_dir(folder).join(name)).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub fn write_device(folder: &Path, info: &DeviceInfo) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(info).map_err(|e| e.to_string())?;
    write_atomically(&devices_dir(folder).join(format!("{}.json", info.id)), &json)
}

/// The other computers that have synced through `folder`.
pub fn list_devices(folder: &Path, me: &str) -> Vec<DeviceInfo> {
    let Ok(rd) = fs::read_dir(devices_dir(folder)) else { return vec![] };
    let mut found: Vec<DeviceInfo> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|e| fs::read(e.path()).ok())
        .filter_map(|b| serde_json::from_slice::<DeviceInfo>(&b).ok())
        .filter(|d| d.id != me)
        .collect();
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(device: &str) -> ChangeFile {
        ChangeFile {
            format: FORMAT,
            schema: 9,
            device: device.into(),
            changes: vec![Change {
                tbl: "bank_transactions".into(), key: "sf:A|T".into(), field: "note".into(),
                value: serde_json::json!("lunch"), at: 1_760_000_000_000,
            }],
        }
    }

    #[test]
    fn a_change_file_reads_back_as_written() {
        let dir = tempfile::tempdir().unwrap();
        let name = file_name("pc", 1_760_000_000_000, 7);
        write_change_file(dir.path(), &name, &sample("pc")).unwrap();
        assert_eq!(read(dir.path(), &name).unwrap(), sample("pc"));
    }

    #[test]
    fn listing_skips_this_computers_files_and_half_written_ones() {
        let dir = tempfile::tempdir().unwrap();
        write_change_file(dir.path(), &file_name("pc", 2, 1), &sample("pc")).unwrap();
        write_change_file(dir.path(), &file_name("pc", 1, 1), &sample("pc")).unwrap();
        write_change_file(dir.path(), &file_name("laptop", 1, 1), &sample("laptop")).unwrap();
        fs::write(dir.path().join("changes/pc/0000000000003-1.tmp"), "{").unwrap();

        assert_eq!(
            list_others(dir.path(), "laptop"),
            vec!["pc/0000000000001-1.json".to_string(), "pc/0000000000002-1.json".to_string()]
        );
    }

    #[test]
    fn writing_atomically_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b.json");
        write_atomically(&path, b"{}").unwrap();
        write_atomically(&path, b"{\"x\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"x\":1}");
        assert!(!dir.path().join("a/b.tmp").exists());
    }

    #[test]
    fn the_other_computers_are_listed_but_not_this_one() {
        let dir = tempfile::tempdir().unwrap();
        let pc = DeviceInfo { id: "pc".into(), name: "WILL-PC".into(), last_sync: "2026-10-16T09:00:00".into() };
        let me = DeviceInfo { id: "laptop".into(), name: "WILL-LAPTOP".into(), last_sync: "2026-10-16T09:01:00".into() };
        write_device(dir.path(), &pc).unwrap();
        write_device(dir.path(), &me).unwrap();
        assert_eq!(list_devices(dir.path(), "laptop"), vec![pc]);
    }
}
