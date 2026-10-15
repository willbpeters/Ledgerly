# Backup, Restore and CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ledgerly backs its database up automatically (daily, before migrations, before restores) and on demand, can restore any backup from Settings, and can export its data as CSV.

**Architecture:** A new Rust module `src-tauri/src/backup/` does all the work, split into a pure naming module (file names carry date, time and kind) and small I/O modules for snapshotting (`VACUUM INTO` + `quick_check`), startup, restore staging and CSV export. A startup step runs in `lib.rs` *before* `db::open`, so a pending restore is swapped in and a pending migration is backed up before anything changes the file. The frontend gets one Settings card: a pure `BackupPanel` (tested with props) wrapped by a `BackupCard` that owns the queries and the folder/file pickers.

**Tech Stack:** Rust (rusqlite 0.32, chrono, serde), Tauri v2 with the new `tauri-plugin-dialog`, React 19 + TanStack Query, Vitest + Testing Library. Spec: `docs/superpowers/specs/2026-10-14-backup-and-export-design.md`.

---

## Before you start

- Rust tests: `cd src-tauri` then `cargo test`. Baseline: **177 passed, 9 ignored**.
- TypeScript: `npm test` (baseline **257 passed**) and `npx tsc --noEmit` (clean).
- If `cargo` is "not found", run `$env:Path = "C:\Users\willi\.cargo\bin;" + $env:Path` in that PowerShell window first (see HANDOFF "Gotchas").
- Edit source files with the editor tools, not PowerShell `Set-Content` (it writes a BOM).
- Comments explain *why*, not *what* — the owner is newer to coding.

## File map

| File | Status | Job |
|---|---|---|
| `src-tauri/Cargo.toml` | modify | add `tauri-plugin-dialog`, dev-dependency `tempfile` |
| `package.json` | modify | add `@tauri-apps/plugin-dialog` |
| `src-tauri/capabilities/default.json` | modify | allow `dialog:allow-open` |
| `src-tauri/src/db.rs` | modify | add `migration_pending` |
| `src-tauri/src/backup/mod.rs` | create | `Paths`, `Attempt`, `BackupState`, `now`, `stamp`, test helpers |
| `src-tauri/src/backup/naming.rs` | create | pure file-name logic |
| `src-tauri/src/backup/settings.rs` | create | `backup-settings.json` |
| `src-tauri/src/backup/snapshot.rs` | create | write, check, list, prune, copy to extra folder |
| `src-tauri/src/backup/restore.rs` | create | validate a chosen file, stage it |
| `src-tauri/src/backup/startup.rs` | create | apply a pending restore, take the launch backup |
| `src-tauri/src/backup/export.rs` | create | CSV writer and the seven exports |
| `src-tauri/src/commands/backup.rs` | create | the Tauri commands |
| `src-tauri/src/commands/mod.rs` | modify | `pub mod backup;` |
| `src-tauri/src/lib.rs` | modify | `mod backup;`, dialog plugin, startup step, commands |
| `src/domain/types.ts` | modify | backup types |
| `src/domain/backup.ts` (+ `.test.ts`) | create | pure labels: kind, size, "Today, 09:30" |
| `src/data/api.ts` | modify | `api.backup.*` |
| `src/data/queries.ts` | modify | backup hooks |
| `src/features/settings/BackupPanel.tsx` (+ `.test.tsx`) | create | the card's markup, props only |
| `src/features/settings/BackupCard.tsx` | create | hooks, pickers, confirm |
| `src/features/settings/Settings.tsx` | modify | render `BackupCard` |
| `docs/HANDOFF.md`, `docs/TODO.md` | modify | record what shipped |

---

### Task 1: Dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`, `package.json`, `package-lock.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the Rust crates**

In `src-tauri/Cargo.toml`, under `[dependencies]` after `tauri-plugin-opener = "2"`, add:

```toml
tauri-plugin-dialog = "2"
```

and at the end of the file, before `# Read the optimization guideline…`, add:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Add the npm package**

Run: `npm install @tauri-apps/plugin-dialog@^2`
Expected: `package.json` gains `"@tauri-apps/plugin-dialog": "^2.x.x"` under `dependencies`.

- [ ] **Step 3: Allow the open dialog**

Replace the `permissions` array in `src-tauri/capabilities/default.json` with:

```json
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:allow-open"
  ]
```

- [ ] **Step 4: Register the plugin**

In `src-tauri/src/lib.rs`, after `.plugin(tauri_plugin_opener::init()) // keep whatever plugins scaffold added`, add:

```rust
        .plugin(tauri_plugin_dialog::init())
```

- [ ] **Step 5: Build**

Run: `cd src-tauri; cargo test`
Expected: compiles; **177 passed**.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock package.json package-lock.json src-tauri/capabilities/default.json src-tauri/src/lib.rs
git commit -m "build: add the dialog plugin and tempfile for backups"
```

---

### Task 2: File names (pure)

**Files:**
- Create: `src-tauri/src/backup/mod.rs` (module list only for now)
- Create: `src-tauri/src/backup/naming.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod backup;`)

- [ ] **Step 1: Create the module root**

`src-tauri/src/backup/mod.rs`:

```rust
//! Backups, restore and CSV export.
//! Design: docs/superpowers/specs/2026-10-14-backup-and-export-design.md
pub mod naming;
```

In `src-tauri/src/lib.rs`, add `mod backup;` after `mod market;`.

- [ ] **Step 2: Write the failing tests**

`src-tauri/src/backup/naming.rs`:

```rust
//! Backup file names. The name alone carries the date, the time and the kind,
//! so "is there a backup today?" and "which files does pruning remove?" are
//! answered from a list of names, without touching disk.

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }
    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn daily_on(d: u32) -> String {
        file_name(at(&format!("2026-10-{d:02} 09:00:00")), Kind::Daily, 1)
    }

    #[test]
    fn a_name_carries_date_time_and_kind() {
        assert_eq!(
            file_name(at("2026-10-14 09:30:12"), Kind::Daily, 1),
            "ledgerly-2026-10-14-093012-daily.sqlite"
        );
        assert_eq!(
            file_name(at("2026-10-14 09:30:12"), Kind::PreMigration, 2),
            "ledgerly-2026-10-14-093012-pre-migration-2.sqlite"
        );
    }

    #[test]
    fn every_kind_round_trips_through_its_name() {
        for kind in Kind::ALL {
            for n in [1, 2, 10] {
                let parsed = parse(&file_name(at("2026-10-14 09:30:12"), kind, n)).unwrap();
                assert_eq!(
                    parsed,
                    Parsed {
                        date: day("2026-10-14"),
                        time: NaiveTime::from_hms_opt(9, 30, 12).unwrap(),
                        kind
                    }
                );
            }
        }
    }

    #[test]
    fn files_that_are_not_backups_are_ignored() {
        for name in [
            "finance.sqlite",
            "notes.txt",
            "ledgerly-2026-10-14-093012-weekly.sqlite",
            "ledgerly-2026-13-14-093012-daily.sqlite",
            "ledgerly-2026-10-14-093012-daily-.sqlite",
            "ledgerly-2026-10-14-093012-daily-x.sqlite",
            "ledgerly-2026-10-14-093012-daily.sqlite.tmp",
            "ledgerly-2026-10-14-0930-daily.sqlite",
            "ledgerly-é026-10-14-093012-daily.sqlite",
        ] {
            assert_eq!(parse(name), None, "{name} must not parse");
        }
    }

    #[test]
    fn a_backup_of_any_kind_today_counts_and_yesterday_does_not() {
        let yesterday = file_name(at("2026-10-13 23:59:59"), Kind::Daily, 1);
        let manual_today = file_name(at("2026-10-14 08:00:00"), Kind::Manual, 1);
        let names = vec![yesterday.clone(), manual_today, "finance.sqlite".to_string()];
        assert!(has_backup_on(&names, day("2026-10-14")));
        assert!(!has_backup_on(&[yesterday], day("2026-10-14")));
    }

    #[test]
    fn pruning_removes_only_the_oldest_dailies_beyond_the_limit() {
        let mut names: Vec<String> = (1..=16).map(daily_on).collect();
        for kind in [Kind::Manual, Kind::PreMigration, Kind::PreRestore] {
            names.push(file_name(at("2026-09-01 09:00:00"), kind, 1));
        }
        names.push("finance.sqlite".to_string());

        assert_eq!(to_prune(&names, KEEP_DAILY), vec![daily_on(2), daily_on(1)]);
    }

    #[test]
    fn nothing_is_pruned_at_the_limit() {
        let names: Vec<String> = (1..=14).map(daily_on).collect();
        assert!(to_prune(&names, KEEP_DAILY).is_empty());
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri; cargo test backup::naming`
Expected: compile errors — `file_name`, `Kind`, `parse`, … not found.

- [ ] **Step 4: Implement** (above the tests block)

```rust
use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use serde::Serialize;

/// How many `daily` backups are kept: about two weeks. Every other kind is
/// kept until the owner deletes it, because each marks a moment worth
/// returning to (an update, a restore, a deliberate click).
pub const KEEP_DAILY: usize = 14;

const PREFIX: &str = "ledgerly-";
const EXT: &str = ".sqlite";
/// `2026-10-14-093012-` — the fixed-width part of every name.
const STAMP_LEN: usize = 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Daily,
    PreMigration,
    PreRestore,
    Manual,
}

impl Kind {
    pub const ALL: [Kind; 4] = [Kind::Daily, Kind::PreMigration, Kind::PreRestore, Kind::Manual];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Daily => "daily",
            Kind::PreMigration => "pre-migration",
            Kind::PreRestore => "pre-restore",
            Kind::Manual => "manual",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub date: NaiveDate,
    pub time: NaiveTime,
    pub kind: Kind,
}

/// `ledgerly-2026-10-14-093012-daily.sqlite`. An `n` above 1 appends `-n`,
/// for two backups in the same second: `VACUUM INTO` refuses to overwrite.
pub fn file_name(at: NaiveDateTime, kind: Kind, n: u32) -> String {
    let stem = format!("{PREFIX}{}-{}", at.format("%Y-%m-%d-%H%M%S"), kind.as_str());
    if n > 1 {
        format!("{stem}-{n}{EXT}")
    } else {
        format!("{stem}{EXT}")
    }
}

/// The inverse of `file_name`. Anything else in the folder parses to `None`,
/// which is what keeps pruning away from files Ledgerly did not write.
pub fn parse(name: &str) -> Option<Parsed> {
    let body = name.strip_prefix(PREFIX)?.strip_suffix(EXT)?;
    if !body.is_ascii() || body.len() <= STAMP_LEN {
        return None;
    }
    let (stamp, rest) = body.split_at(STAMP_LEN);
    if &stamp[10..11] != "-" || &stamp[17..18] != "-" {
        return None;
    }
    let date = NaiveDate::parse_from_str(&stamp[..10], "%Y-%m-%d").ok()?;
    let time = NaiveTime::parse_from_str(&stamp[11..17], "%H%M%S").ok()?;
    let kind = Kind::ALL.into_iter().find(|k| {
        rest == k.as_str()
            || rest
                .strip_prefix(k.as_str())
                .and_then(|r| r.strip_prefix('-'))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    })?;
    Some(Parsed { date, time, kind })
}

/// Has a backup of any kind already been made on `day`? Any kind counts: a
/// manual backup this morning makes a daily one this afternoon redundant.
pub fn has_backup_on(names: &[String], day: NaiveDate) -> bool {
    names.iter().filter_map(|n| parse(n)).any(|p| p.date == day)
}

/// The `daily` backups beyond the newest `keep`, oldest last. Only `daily`
/// files are ever returned.
pub fn to_prune(names: &[String], keep: usize) -> Vec<String> {
    let mut daily: Vec<(Parsed, &String)> = names
        .iter()
        .filter_map(|n| parse(n).map(|p| (p, n)))
        .filter(|(p, _)| p.kind == Kind::Daily)
        .collect();
    daily.sort_by(|a, b| (b.0.date, b.0.time, b.1).cmp(&(a.0.date, a.0.time, a.1)));
    daily.into_iter().skip(keep).map(|(_, n)| n.clone()).collect()
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri; cargo test backup::naming`
Expected: **6 passed**.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backup src-tauri/src/lib.rs
git commit -m "feat(backup): name backups so date, time and kind live in the name"
```

---

### Task 3: `db::migration_pending`

**Files:**
- Modify: `src-tauri/src/db.rs` (new function after `apply_migrations`; tests in its `tests` module)

- [ ] **Step 1: Write the failing tests**

Add inside `mod tests` in `src-tauri/src/db.rs`:

```rust
    #[test]
    fn a_fully_migrated_database_has_no_migration_pending() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        assert!(!migration_pending(&conn).unwrap());
    }

    #[test]
    fn a_v1_database_has_a_migration_pending() {
        assert!(migration_pending(&v1_database()).unwrap());
    }

    #[test]
    fn an_empty_database_has_a_migration_pending() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(migration_pending(&conn).unwrap());
    }

    #[test]
    fn a_database_missing_a_market_table_has_a_migration_pending() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch("DROP TABLE index_quotes;").unwrap();
        assert!(migration_pending(&conn).unwrap());
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri; cargo test db::tests::`
Expected: compile error — `migration_pending` not found.

- [ ] **Step 3: Implement**

Add after `apply_migrations` in `src-tauri/src/db.rs`:

```rust
/// Would `open` change this database's structure? Asks exactly the questions
/// `apply_migrations` asks, without acting on the answers, so the backup taken
/// at launch can be labelled `pre-migration`. A new migration must be added
/// here as well as there.
pub fn migration_pending(conn: &Connection) -> rusqlite::Result<bool> {
    Ok(user_version(conn)? < 1
        || !v2_is_complete(conn)?
        || !v3_is_complete(conn)?
        || !v4_is_complete(conn)?
        || !v5_is_complete(conn)?)
}
```

Also add one line to the doc comment above `apply_migrations` (the one that ends "add another `if current < N` block, and"): append to that comment block the sentence
`/// Add the new completeness check to `migration_pending` too.`

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri; cargo test db::`
Expected: all `db` tests pass, including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(db): ask whether opening a database would migrate it"
```

---

### Task 4: Paths, status types and settings

**Files:**
- Modify: `src-tauri/src/backup/mod.rs`
- Create: `src-tauri/src/backup/settings.rs`

- [ ] **Step 1: Fill in `mod.rs`**

Replace `src-tauri/src/backup/mod.rs` with:

```rust
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
```

- [ ] **Step 2: Write the failing settings tests**

`src-tauri/src/backup/settings.rs`:

```rust
//! `backup-settings.json`: where extra copies of each backup go.

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
        let s = BackupSettings { extra_folder: Some(r"E:\Ledgerly backups".into()) };
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
```

Add `pub mod settings;` is already in `mod.rs` from Step 1.

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri; cargo test backup::settings`
Expected: compile errors — `load`, `save`, `BackupSettings` not found.

- [ ] **Step 4: Implement** (above the tests block)

```rust
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
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri; cargo test backup::`
Expected: **9 passed** (6 naming + 3 settings). Warnings about unused `BackupState`, `now`, etc. are expected until Task 8.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backup
git commit -m "feat(backup): paths, attempt status and the extra-folder setting"
```

---

### Task 5: Making, checking and listing backups

**Files:**
- Create: `src-tauri/src/backup/snapshot.rs`
- Modify: `src-tauri/src/backup/mod.rs` (add `pub mod snapshot;`)

- [ ] **Step 1: Register the module**

In `mod.rs`, add `pub mod snapshot;` after `pub mod settings;`.

- [ ] **Step 2: Write the failing tests**

`src-tauri/src/backup/snapshot.rs`:

```rust
//! Making a backup: write it with `VACUUM INTO`, check it, copy it to the extra
//! folder, prune old dailies.

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
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri; cargo test backup::snapshot`
Expected: compile errors — `create`, `check`, `list`, `names_in`, `attempt` not found.

- [ ] **Step 4: Implement** (above the tests block)

```rust
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
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri; cargo test backup::`
Expected: **18 passed**.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backup
git commit -m "feat(backup): write, check, list and prune backups"
```

---

### Task 6: Restore staging and the startup sequence

**Files:**
- Create: `src-tauri/src/backup/restore.rs`, `src-tauri/src/backup/startup.rs`
- Modify: `src-tauri/src/backup/mod.rs` (add both modules)

- [ ] **Step 1: Register the modules**

In `mod.rs`, after `pub mod snapshot;`, add:

```rust
pub mod restore;
pub mod startup;
```

- [ ] **Step 2: Write the failing restore tests**

`src-tauri/src/backup/restore.rs`:

```rust
//! Choosing a backup to restore. The swap itself happens at the next launch,
//! in `startup`, because Windows will not replace a file the app has open.

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
```

- [ ] **Step 3: Write the failing startup tests**

`src-tauri/src/backup/startup.rs`:

```rust
//! What happens at launch, before `db::open`: swap in a staged restore, then
//! take the launch backup — `pre-migration` if opening will change the
//! database, otherwise `daily` if none has been made today.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{populated_db, snapshot, test_at, test_paths};

    fn account_names(paths: &Paths) -> Vec<String> {
        let conn = Connection::open(paths.db()).unwrap();
        let mut stmt = conn.prepare("SELECT name FROM accounts ORDER BY id").unwrap();
        let names = stmt.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect();
        names
    }

    #[test]
    fn the_first_run_has_nothing_to_back_up() {
        let (_dir, paths) = test_paths();
        let report = run(&paths, test_at("2026-10-14 09:00:00"));
        assert_eq!(report.attempt, None);
        assert_eq!(report.restore_error, None);
        assert!(!paths.backups().exists());
    }

    #[test]
    fn one_daily_backup_per_day() {
        let (_dir, paths) = test_paths();
        drop(populated_db(&paths));

        let first = run(&paths, test_at("2026-10-14 09:00:00")).attempt.unwrap();
        assert_eq!(first.kind, Kind::Daily);
        assert!(first.error.is_none());

        assert_eq!(run(&paths, test_at("2026-10-14 15:00:00")).attempt, None);

        let next_day = run(&paths, test_at("2026-10-15 08:00:00")).attempt.unwrap();
        assert_eq!(next_day.kind, Kind::Daily);
    }

    #[test]
    fn a_database_about_to_migrate_gets_a_pre_migration_backup() {
        let (_dir, paths) = test_paths();
        // user_version 0: opening it would apply the whole schema.
        Connection::open(paths.db()).unwrap().execute_batch("CREATE TABLE t (x INTEGER);").unwrap();

        let attempt = run(&paths, test_at("2026-10-14 09:00:00")).attempt.unwrap();
        assert_eq!(attempt.kind, Kind::PreMigration);
        assert!(attempt.error.is_none());
    }

    #[test]
    fn a_staged_restore_replaces_the_database_and_drops_a_stale_journal() {
        let (_dir, paths) = test_paths();
        let conn = populated_db(&paths);
        let backup = snapshot::create(&conn, &paths.backups(), None, Kind::Manual, test_at("2026-10-13 09:00:00"))
            .unwrap()
            .file;
        conn.execute("INSERT INTO accounts (name, type, created_at) VALUES ('Brokerage', 'brokerage', '2026-10-14')", [])
            .unwrap();
        drop(conn);
        fs::copy(&backup, paths.pending_restore()).unwrap();
        let journal = sidecar(&paths.db(), "-journal");
        fs::write(&journal, "a journal from the old database").unwrap();

        let report = run(&paths, test_at("2026-10-14 09:00:00"));

        assert_eq!(report.restore_error, None);
        assert_eq!(account_names(&paths), vec!["Checking".to_string()]);
        assert!(!paths.pending_restore().exists());
        assert!(!journal.exists());
    }

    #[test]
    fn a_broken_staged_restore_is_discarded_and_the_database_kept() {
        let (_dir, paths) = test_paths();
        drop(populated_db(&paths));
        fs::write(paths.pending_restore(), "not a database").unwrap();

        let report = run(&paths, test_at("2026-10-14 09:00:00"));

        assert!(report.restore_error.unwrap().contains("nothing was changed"));
        assert!(!paths.pending_restore().exists());
        assert_eq!(account_names(&paths), vec!["Checking".to_string()]);
    }
}
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd src-tauri; cargo test backup::`
Expected: compile errors — `stage`, `run`, `sidecar` not found.

- [ ] **Step 5: Implement `restore.rs`** (above its tests block)

```rust
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
```

- [ ] **Step 6: Implement `startup.rs`** (above its tests block)

```rust
use super::naming::{self, Kind};
use super::{restore, snapshot, stamp, Attempt, Paths};
use chrono::NaiveDateTime;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
pub struct StartupReport {
    pub restore_error: Option<String>,
    pub attempt: Option<Attempt>,
}

/// Runs before `db::open`. Never fails: problems are reported for Settings to
/// show, because a backup problem must not become a can't-open-the-app problem.
pub fn run(paths: &Paths, at: NaiveDateTime) -> StartupReport {
    let restore_error = apply_pending_restore(paths).err();
    let attempt = if paths.db().exists() { backup_if_due(paths, at) } else { None };
    StartupReport { restore_error, attempt }
}

fn backup_if_due(paths: &Paths, at: NaiveDateTime) -> Option<Attempt> {
    let failed = |e: String| Attempt {
        at: stamp(at),
        kind: Kind::Daily,
        file: None,
        error: Some(format!("Couldn't open the database to back it up: {e}")),
        warning: None,
    };
    let conn = match Connection::open(paths.db()) {
        Ok(c) => c,
        Err(e) => return Some(failed(e.to_string())),
    };
    let kind = match crate::db::migration_pending(&conn) {
        Ok(true) => Kind::PreMigration,
        Ok(false) if naming::has_backup_on(&snapshot::names_in(&paths.backups()), at.date()) => return None,
        Ok(false) => Kind::Daily,
        Err(e) => return Some(failed(e.to_string())),
    };
    Some(snapshot::attempt(&conn, paths, kind, at))
}

/// `finance.sqlite-journal` and friends.
fn sidecar(db: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", db.display()))
}

/// Swap a staged backup in. The old database's journal files go first: SQLite
/// would replay a leftover journal into the restored file and corrupt it.
fn apply_pending_restore(paths: &Paths) -> Result<(), String> {
    let pending = paths.pending_restore();
    if !pending.exists() {
        return Ok(());
    }
    if let Err(e) = restore::validate(&pending) {
        let _ = fs::remove_file(&pending);
        return Err(format!("The backup chosen for restore couldn't be used, so nothing was changed. {e}"));
    }
    let db = paths.db();
    for suffix in ["-journal", "-wal", "-shm"] {
        let file = sidecar(&db, suffix);
        if file.exists() {
            fs::remove_file(&file).map_err(|e| format!("Couldn't clear {}: {e}", file.display()))?;
        }
    }
    rename_with_retry(&pending, &db).map_err(|e| format!("Couldn't swap in the restored backup: {e}"))
}

/// The previous instance is still exiting when the restarted one gets here,
/// and Windows will not replace a file another process still has open, so
/// give it a moment rather than failing the restore.
fn rename_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_) if tries < 10 => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(e),
        }
    }
}
```

- [ ] **Step 7: Run the tests**

Run: `cd src-tauri; cargo test backup::`
Expected: **26 passed**.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/backup
git commit -m "feat(backup): stage restores and back up at launch before opening"
```

---

### Task 7: CSV export

**Files:**
- Create: `src-tauri/src/backup/export.rs`
- Modify: `src-tauri/src/backup/mod.rs` (add `pub mod export;`)

- [ ] **Step 1: Register the module**

In `mod.rs`, add `pub mod export;` as the first line of the module list.

- [ ] **Step 2: Write the failing tests**

`src-tauri/src/backup/export.rs`:

```rust
//! CSV export: one spreadsheet-ready file per kind of data.

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 14).unwrap()
    }

    #[test]
    fn fields_with_commas_quotes_or_line_breaks_are_quoted() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote("a,b"), "\"a,b\"");
        assert_eq!(quote("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(quote("two\nlines"), "\"two\nlines\"");
    }

    #[test]
    fn text_excel_would_run_as_a_formula_is_defused() {
        for risky in ["=SUM(A1)", "+1", "-5 refund", "@cmd", "\tx"] {
            assert_eq!(guard(risky), format!("'{risky}"));
        }
        assert_eq!(guard("Coffee"), "Coffee");
    }

    #[test]
    fn a_query_becomes_csv_with_a_bom_header_and_untouched_numbers() {
        let conn = Connection::open_in_memory().unwrap();
        let csv = query_to_csv(
            &conn,
            "SELECT 'a,b' AS x, -12.5 AS amount, 3 AS n, NULL AS empty, '=SUM(A1)' AS f, 'say \"hi\"' AS q",
        )
        .unwrap();
        assert_eq!(
            csv,
            "\u{FEFF}x,amount,n,empty,f,q\r\n\"a,b\",-12.5,3,,'=SUM(A1),\"say \"\"hi\"\"\"\r\n"
        );
    }

    #[test]
    fn every_file_is_written_with_names_instead_of_ids() {
        let conn = crate::db::open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (id, name, type, created_at) VALUES (1, 'Checking', 'cash', '2026-10-01');
             INSERT INTO securities (id, ticker, type) VALUES (1, 'VTI', 'etf');
             INSERT INTO transactions (account_id, security_id, type, date, quantity, price, amount)
               VALUES (1, 1, 'buy', '2026-10-02', 2, 250, 500);
             INSERT INTO categories (id, name, kind) VALUES (900, 'Test category', 'spending');
             INSERT INTO bank_transactions (account_id, external_id, posted, amount, description, category_id)
               VALUES (1, 'x1', '2026-10-03', -4.5, 'Coffee, large', 900);",
        )
        .unwrap();
        let out = tempfile::tempdir().unwrap();

        let folder = export_all(&conn, out.path(), day()).unwrap();

        assert!(folder.ends_with("Ledgerly export 2026-10-14"));
        for (file, _) in EXPORTS {
            assert!(folder.join(file).exists(), "{file} missing");
        }
        let investments = std::fs::read_to_string(folder.join("investment-transactions.csv")).unwrap();
        assert!(investments.starts_with("\u{FEFF}date,account,ticker,type,quantity,price,amount,fees,note\r\n"));
        assert!(investments.contains("2026-10-02,Checking,VTI,buy,2,250,500,0,\r\n"));
        let bank = std::fs::read_to_string(folder.join("bank-transactions.csv")).unwrap();
        assert!(bank.contains("2026-10-03,Checking,\"Coffee, large\",,,-4.5,Test category,auto,,0\r\n"));
    }

    #[test]
    fn a_second_export_on_the_same_day_gets_its_own_folder() {
        let conn = crate::db::open_in_memory().unwrap();
        let out = tempfile::tempdir().unwrap();
        export_all(&conn, out.path(), day()).unwrap();
        let second = export_all(&conn, out.path(), day()).unwrap();
        assert!(second.ends_with("Ledgerly export 2026-10-14 (2)"));
    }
}
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd src-tauri; cargo test backup::export`
Expected: compile errors — `quote`, `guard`, `query_to_csv`, `export_all`, `EXPORTS` not found.

- [ ] **Step 4: Implement** (above the tests block)

```rust
use chrono::NaiveDate;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

/// Each file and the query that fills it. Columns are named for a person
/// reading the file in Excel, and IDs are joined to names for the same reason.
/// Market caches and snapshots are left out: they are re-fetchable or derived.
pub const EXPORTS: [(&str, &str); 7] = [
    (
        "accounts.csv",
        "SELECT name, type, institution, currency, source, hidden, synced_balance,
                last_synced_at, created_at
         FROM accounts ORDER BY name",
    ),
    (
        "investment-transactions.csv",
        "SELECT t.date, a.name AS account, s.ticker AS ticker, t.type, t.quantity, t.price,
                t.amount, t.fees, t.note
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN securities s ON s.id = t.security_id
         ORDER BY t.date, t.id",
    ),
    (
        "bank-transactions.csv",
        "SELECT b.posted AS date, a.name AS account, b.description, b.payee, b.memo, b.amount,
                c.name AS category, b.category_source, b.mcc, b.pending
         FROM bank_transactions b
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN categories c ON c.id = b.category_id
         ORDER BY b.posted, b.id",
    ),
    (
        "synced-holdings.csv",
        "SELECT a.name AS account, s.ticker, h.shares, h.cost_basis, h.market_value, h.as_of
         FROM synced_holdings h
         JOIN accounts a ON a.id = h.account_id
         JOIN securities s ON s.id = h.security_id
         ORDER BY a.name, s.ticker",
    ),
    (
        "categories.csv",
        "SELECT name, kind, colour, sort, is_builtin FROM categories ORDER BY sort, name",
    ),
    (
        "budgets.csv",
        "SELECT c.name AS category, b.month, b.limit_amount
         FROM budgets b JOIN categories c ON c.id = b.category_id
         ORDER BY c.name, b.month",
    ),
    (
        "category-rules.csv",
        "SELECT r.match_type, r.pattern, c.name AS category, r.created_at
         FROM category_rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.match_type, r.pattern",
    ),
];

/// Bank descriptions are third-party text. Excel runs a cell starting with one
/// of these as a formula, so text gets a leading apostrophe. Numbers never
/// pass through here, which is what keeps a negative amount a number.
fn guard(text: &str) -> String {
    if text.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{text}")
    } else {
        text.to_string()
    }
}

fn quote(text: &str) -> String {
    if text.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

fn cell(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null | ValueRef::Blob(_) => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => quote(&guard(&String::from_utf8_lossy(t))),
    }
}

/// Run `sql` and return it as CSV text. The byte-order mark makes Excel read
/// the file as UTF-8, so accented payee names survive.
pub fn query_to_csv(conn: &Connection, sql: &str) -> rusqlite::Result<String> {
    let mut stmt = conn.prepare(sql)?;
    let header: Vec<String> = stmt.column_names().iter().map(|c| quote(c)).collect();
    let width = header.len();
    let mut out = String::from("\u{FEFF}");
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let cells = (0..width)
            .map(|i| row.get_ref(i).map(cell))
            .collect::<rusqlite::Result<Vec<String>>>()?;
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    }
    Ok(out)
}

/// `Ledgerly export 2026-10-14`, or `… (2)` if that exists already.
fn folder_for(base: &Path, day: NaiveDate) -> PathBuf {
    let stem = format!("Ledgerly export {}", day.format("%Y-%m-%d"));
    (1..)
        .map(|n| if n == 1 { base.join(&stem) } else { base.join(format!("{stem} ({n})")) })
        .find(|p| !p.exists())
        .expect("an unused folder name")
}

/// Write every export into a new dated folder inside `base`; returns the folder.
pub fn export_all(conn: &Connection, base: &Path, day: NaiveDate) -> Result<PathBuf, String> {
    let folder = folder_for(base, day);
    fs::create_dir_all(&folder).map_err(|e| format!("Couldn't create {}: {e}", folder.display()))?;
    for (file, sql) in EXPORTS {
        let csv = query_to_csv(conn, sql).map_err(|e| format!("Couldn't export {file}: {e}"))?;
        fs::write(folder.join(file), csv).map_err(|e| format!("Couldn't write {file}: {e}"))?;
    }
    Ok(folder)
}
```

- [ ] **Step 5: Run the tests**

Run: `cd src-tauri; cargo test backup::`
Expected: **31 passed**.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/backup
git commit -m "feat(backup): export the data as spreadsheet-ready CSV files"
```

---

### Task 8: Commands and the launch hook

**Files:**
- Create: `src-tauri/src/commands/backup.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the commands**

`src-tauri/src/commands/backup.rs`:

```rust
//! Commands for the Backups card in Settings. Anything that writes files runs
//! off the main thread, so a slow USB drive never freezes the window.
use crate::backup::{self, export, naming::Kind, restore, settings, snapshot, Attempt, BackupState};
use crate::db::Db;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize)]
pub struct BackupStatus {
    latest: Option<snapshot::Entry>,
    last_attempt: Option<Attempt>,
    restore_error: Option<String>,
    extra_folder: Option<String>,
    backups_folder: String,
}

#[tauri::command]
pub fn backup_status(state: tauri::State<BackupState>) -> BackupStatus {
    let paths = &state.paths;
    BackupStatus {
        latest: snapshot::list(&paths.backups()).into_iter().next(),
        last_attempt: state.last_attempt.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        restore_error: state.restore_error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        extra_folder: settings::load(&paths.settings()).extra_folder,
        backups_folder: paths.backups().to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn backup_list(state: tauri::State<BackupState>) -> Vec<snapshot::Entry> {
    snapshot::list(&state.paths.backups())
}

#[tauri::command]
pub async fn backup_now(app: tauri::AppHandle) -> Result<Attempt, String> {
    super::off_main_thread(move || {
        let state = app.state::<BackupState>();
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let attempt = snapshot::attempt(&conn, &state.paths, Kind::Manual, backup::now());
        state.record(&attempt);
        match &attempt.error {
            Some(e) => Err(e.clone()),
            None => Ok(attempt),
        }
    })
    .await
}

#[tauri::command]
pub fn backup_set_extra_folder(state: tauri::State<BackupState>, folder: Option<String>) -> Result<(), String> {
    settings::save(&state.paths.settings(), &settings::BackupSettings { extra_folder: folder })
}

/// Stage `path` for restore, then restart so the next launch swaps it in.
/// Does not return on success.
#[tauri::command]
pub async fn backup_restore(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let worker = app.clone();
    super::off_main_thread(move || {
        let state = worker.state::<BackupState>();
        let db = worker.state::<Db>();
        let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let safety = restore::stage(&conn, &state.paths, &PathBuf::from(path), backup::now())?;
        state.record(&safety);
        // Let go of finance.sqlite now: the restarted app must be able to
        // replace it, and Windows will not replace a file that is still open.
        *conn = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await?;
    app.restart();
}

#[tauri::command]
pub async fn export_csv(app: tauri::AppHandle, folder: String) -> Result<String, String> {
    super::off_main_thread(move || {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        export::export_all(&conn, &PathBuf::from(folder), backup::now().date())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// Show a file or folder in Explorer, e.g. a finished export.
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the module**

In `src-tauri/src/commands/mod.rs`, add `pub mod backup;` after `pub mod market;`.

- [ ] **Step 3: Run the launch step before opening the database**

In `src-tauri/src/lib.rs`, replace the body of `.setup(|app| { … })` with:

```rust
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("create app data dir");
            let paths = backup::Paths::new(&dir);
            // Before db::open: a staged restore must be swapped in first, and a
            // database about to be migrated must be backed up while it still
            // is the old version.
            let report = backup::startup::run(&paths, backup::now());
            let conn = db::open(&paths.db()).expect("open db");
            app.manage(db::Db(std::sync::Mutex::new(conn)));
            app.manage(backup::BackupState::new(paths, report.attempt, report.restore_error));
            Ok(())
        })
```

and add to the `generate_handler![…]` list, after `commands::market::market_refresh,`:

```rust
            commands::backup::backup_status,
            commands::backup::backup_list,
            commands::backup::backup_now,
            commands::backup::backup_set_extra_folder,
            commands::backup::backup_restore,
            commands::backup::export_csv,
            commands::backup::reveal_path,
```

- [ ] **Step 4: Build and test**

Run: `cd src-tauri; cargo test`
Expected: compiles with no warnings from `backup/`; **212 passed** (177 + 4 db + 31 backup).

If `reveal_item_in_dir` does not compile, check the signature in `~/.cargo/registry/src/*/tauri-plugin-opener-2.*/src/lib.rs` (`OpenerExt` → `Opener::reveal_item_in_dir`) and adapt the call; do not drop the command.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands src-tauri/src/lib.rs
git commit -m "feat(backup): back up at launch and expose backup commands"
```

---

### Task 9: Frontend data layer and labels

**Files:**
- Modify: `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts`
- Create: `src/domain/backup.ts`, `src/domain/backup.test.ts`

- [ ] **Step 1: Types**

Append to `src/domain/types.ts`:

```ts
export type BackupKind = "daily" | "pre-migration" | "pre-restore" | "manual";

export interface BackupEntry {
  file_name: string; path: string;
  /** Local date and time, `YYYY-MM-DD` and `HH:MM:SS`. */
  date: string; time: string;
  kind: BackupKind; size: number;
}

export interface BackupAttempt {
  at: string; kind: BackupKind; file: string | null;
  error: string | null;
  /** The backup worked, but the extra-folder copy or pruning did not. */
  warning: string | null;
}

export interface BackupStatus {
  latest: BackupEntry | null;
  last_attempt: BackupAttempt | null;
  restore_error: string | null;
  extra_folder: string | null;
  backups_folder: string;
}
```

- [ ] **Step 2: Write the failing label tests**

`src/domain/backup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { kindLabel, formatBytes, whenLabel } from "./backup";

describe("backup labels", () => {
  it("names each kind in plain English", () => {
    expect(kindLabel("daily")).toBe("Daily");
    expect(kindLabel("pre-migration")).toBe("Before an update");
    expect(kindLabel("pre-restore")).toBe("Before a restore");
    expect(kindLabel("manual")).toBe("Manual");
  });

  it("sizes files in B, KB and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("says today and yesterday, and dates anything older", () => {
    expect(whenLabel("2026-10-14", "09:30:12", "2026-10-14")).toBe("Today, 09:30");
    expect(whenLabel("2026-10-13", "18:04:00", "2026-10-14")).toBe("Yesterday, 18:04");
    expect(whenLabel("2026-10-02", "07:15:00", "2026-10-14")).toBe("2 Oct 2026, 07:15");
  });

  it("knows yesterday across a month boundary", () => {
    expect(whenLabel("2026-10-31", "23:00:00", "2026-11-01")).toBe("Yesterday, 23:00");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/domain/backup.test.ts`
Expected: FAIL — cannot find module `./backup`.

- [ ] **Step 4: Implement**

`src/domain/backup.ts`:

```ts
import type { BackupKind } from "./types";

const KIND_LABELS: Record<BackupKind, string> = {
  daily: "Daily",
  "pre-migration": "Before an update",
  "pre-restore": "Before a restore",
  manual: "Manual",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const kindLabel = (kind: BackupKind): string => KIND_LABELS[kind];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The ISO date one day earlier. UTC is right for shifting a date by whole
 *  days; it is only wrong for deciding what "today" is (see `localIsoDate`). */
function dayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** "Today, 09:30", "Yesterday, 18:04" or "2 Oct 2026, 07:15". `today` is the
 *  local ISO date, from `localIsoDate()`. */
export function whenLabel(date: string, time: string, today: string): string {
  const hm = time.slice(0, 5);
  if (date === today) return `Today, ${hm}`;
  if (date === dayBefore(today)) return `Yesterday, ${hm}`;
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}, ${hm}`;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/domain/backup.test.ts`
Expected: **4 passed**.

- [ ] **Step 6: API calls**

In `src/data/api.ts`, add `BackupEntry, BackupAttempt, BackupStatus,` to the type import list, and add this block inside `export const api = { … }` after the `simplefin` block:

```ts
  backup: {
    status: () => invoke<BackupStatus>("backup_status"),
    list: () => invoke<BackupEntry[]>("backup_list"),
    now: () => invoke<BackupAttempt>("backup_now"),
    setExtraFolder: (folder: string | null) => invoke<void>("backup_set_extra_folder", { folder }),
    /** Restarts the app on success, so the promise only ever settles with an error. */
    restore: (path: string) => invoke<void>("backup_restore", { path }),
    exportCsv: (folder: string) => invoke<string>("export_csv", { folder }),
    reveal: (path: string) => invoke<void>("reveal_path", { path }),
  },
```

- [ ] **Step 7: Query hooks**

In `src/data/queries.ts`, add to `keys`:

```ts
  backupStatus: ["backup", "status"] as const,
  backupList: ["backup", "list"] as const,
```

and append to the end of the file:

```ts
export const useBackupStatus = () => useQuery({ queryKey: keys.backupStatus, queryFn: api.backup.status });
export const useBackupList = () => useQuery({ queryKey: keys.backupList, queryFn: api.backup.list });

/** Status and list both describe the backups folder, so they refresh together. */
function useInvalidateBackups() {
  const qc = useQueryClient();
  return () => { qc.invalidateQueries({ queryKey: ["backup"] }); };
}

export function useBackupNow() {
  const invalidate = useInvalidateBackups();
  return useMutation({ mutationFn: () => api.backup.now(), onSettled: invalidate });
}

export function useSetExtraFolder() {
  const invalidate = useInvalidateBackups();
  return useMutation({ mutationFn: (folder: string | null) => api.backup.setExtraFolder(folder), onSuccess: invalidate });
}

export function useRestoreBackup() {
  const invalidate = useInvalidateBackups();
  return useMutation({ mutationFn: (path: string) => api.backup.restore(path), onSettled: invalidate });
}

/** Read-only, so nothing to invalidate. */
export function useExportCsv() {
  return useMutation({ mutationFn: (folder: string) => api.backup.exportCsv(folder) });
}
```

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add src/domain/types.ts src/domain/backup.ts src/domain/backup.test.ts src/data/api.ts src/data/queries.ts
git commit -m "feat(backup): frontend types, calls, hooks and labels"
```

---

### Task 10: The Backups card

**Files:**
- Create: `src/features/settings/BackupPanel.tsx`, `src/features/settings/BackupPanel.test.tsx`, `src/features/settings/BackupCard.tsx`
- Modify: `src/features/settings/Settings.tsx`

- [ ] **Step 1: Write the failing panel tests**

`src/features/settings/BackupPanel.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { BackupPanel, type BackupPanelProps } from "./BackupPanel";
import type { BackupEntry, BackupStatus } from "../../domain/types";

const entry: BackupEntry = {
  file_name: "ledgerly-2026-10-14-093012-manual.sqlite",
  path: "C:\\backups\\ledgerly-2026-10-14-093012-manual.sqlite",
  date: "2026-10-14", time: "09:30:12", kind: "manual", size: 1.5 * 1024 * 1024,
};

const status: BackupStatus = {
  latest: entry, last_attempt: null, restore_error: null, extra_folder: null,
  backups_folder: "C:\\backups",
};

function props(over: Partial<BackupPanelProps> = {}): BackupPanelProps {
  return {
    status, backups: [entry], today: "2026-10-14",
    busy: { backingUp: false, exporting: false, restoring: false },
    exportedTo: null,
    onBackUpNow: vi.fn(), onChooseExtra: vi.fn(), onRemoveExtra: vi.fn(),
    onRestore: vi.fn(), onRestoreFromFile: vi.fn(), onExport: vi.fn(), onRevealExport: vi.fn(),
    ...over,
  };
}

describe("BackupPanel", () => {
  it("shows when the last backup was made", () => {
    render(<BackupPanel {...props()} />);
    expect(screen.getByText(/Last backup: Today, 09:30 \(manual\)/)).toBeInTheDocument();
  });

  it("lists backups with their kind and size", () => {
    render(<BackupPanel {...props()} />);
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("1.5 MB")).toBeInTheDocument();
  });

  it("restores the chosen backup", () => {
    const onRestore = vi.fn();
    render(<BackupPanel {...props({ onRestore })} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith(entry);
  });

  it("explains an empty list", () => {
    render(<BackupPanel {...props({ backups: [], status: { ...status, latest: null } })} />);
    expect(screen.getByText("No backups yet")).toBeInTheDocument();
    expect(screen.getByText(/Last backup: none yet/)).toBeInTheDocument();
  });

  it("says when the last backup failed, and why", () => {
    const failed = { at: "2026-10-14T09:00:00", kind: "daily" as const, file: null, error: "Disk full", warning: null };
    render(<BackupPanel {...props({ status: { ...status, last_attempt: failed } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Last backup failed: Disk full");
  });

  it("says when a restore did not happen", () => {
    render(<BackupPanel {...props({ status: { ...status, restore_error: "That file isn't a Ledgerly backup." } })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Restore didn't happen: That file isn't a Ledgerly backup.");
  });

  it("offers Remove only when an extra folder is set", () => {
    const { rerender } = render(<BackupPanel {...props()} />);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    rerender(<BackupPanel {...props({ status: { ...status, extra_folder: "E:\\Backups" } })} />);
    expect(screen.getByText("E:\\Backups")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("points to a finished export", () => {
    const onRevealExport = vi.fn();
    render(<BackupPanel {...props({ exportedTo: "D:\\Ledgerly export 2026-10-14", onRevealExport })} />);
    expect(screen.getByText(/Exported to D:\\Ledgerly export 2026-10-14/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(onRevealExport).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/settings/BackupPanel.test.tsx`
Expected: FAIL — cannot find module `./BackupPanel`.

- [ ] **Step 3: Implement the panel**

`src/features/settings/BackupPanel.tsx`:

```tsx
import { Card, Button, EmptyState } from "../../ui/components";
import { DataTable } from "../../ui/DataTable";
import { kindLabel, formatBytes, whenLabel } from "../../domain/backup";
import type { BackupEntry, BackupStatus } from "../../domain/types";

export interface BackupPanelProps {
  status: BackupStatus;
  backups: BackupEntry[];
  /** Local ISO date, for "Today" and "Yesterday". */
  today: string;
  busy: { backingUp: boolean; exporting: boolean; restoring: boolean };
  exportedTo: string | null;
  onBackUpNow: () => void;
  onChooseExtra: () => void;
  onRemoveExtra: () => void;
  onRestore: (entry: BackupEntry) => void;
  onRestoreFromFile: () => void;
  onExport: () => void;
  onRevealExport: () => void;
}

/** The Backups card's markup. Takes everything as props so it can be tested
 *  without Tauri; `BackupCard` wires it to the real calls. */
export function BackupPanel(p: BackupPanelProps) {
  const { status, backups, today, busy } = p;
  const latest = status.latest
    ? `${whenLabel(status.latest.date, status.latest.time, today)} (${kindLabel(status.latest.kind).toLowerCase()})`
    : "none yet";
  const failure = status.last_attempt?.error;
  const warning = status.last_attempt?.warning;

  return (
    <Card title="Backups" subtitle="Copies of your data, made automatically each day you open Ledgerly.">
      {status.restore_error && <p className="neg" role="alert">Restore didn't happen: {status.restore_error}</p>}
      {failure && <p className="neg" role="alert">Last backup failed: {failure}</p>}
      {warning && <p className="muted">{warning}</p>}

      <div className="row center" style={{ gap: 12 }}>
        <span>Last backup: {latest}</span>
        <Button onClick={p.onBackUpNow} loading={busy.backingUp}>Back up now</Button>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="row center" style={{ gap: 8 }}>
          <span className="muted">Extra copy folder</span>
          <code>{status.extra_folder ?? "None"}</code>
          <Button variant="secondary" size="sm" onClick={p.onChooseExtra}>Choose…</Button>
          {status.extra_folder && <Button variant="ghost" size="sm" onClick={p.onRemoveExtra}>Remove</Button>}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Each backup is also copied here, such as a USB drive or a cloud folder. Until encryption arrives,
          a cloud folder holds your finances unencrypted.
        </p>
      </div>

      <div style={{ marginTop: 16 }}>
        {backups.length === 0 ? (
          <EmptyState title="No backups yet" body="One is made the next time Ledgerly opens, or now with Back up now." />
        ) : (
          <DataTable
            rows={backups}
            getKey={(b) => b.file_name}
            columns={[
              { key: "when", label: "When", align: "left", render: (b) => whenLabel(b.date, b.time, today) },
              { key: "kind", label: "Kind", align: "left", render: (b) => kindLabel(b.kind) },
              { key: "size", label: "Size", render: (b) => formatBytes(b.size) },
              {
                key: "restore", label: "",
                render: (b) => (
                  <Button variant="ghost" size="sm" disabled={busy.restoring} onClick={() => p.onRestore(b)}>Restore</Button>
                ),
              },
            ]}
          />
        )}
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" size="sm" disabled={busy.restoring} onClick={p.onRestoreFromFile}>
            Restore from a file…
          </Button>
        </div>
      </div>

      <div className="row center" style={{ gap: 12, marginTop: 16 }}>
        <Button variant="secondary" onClick={p.onExport} loading={busy.exporting}>Export to CSV…</Button>
        {p.exportedTo && (
          <>
            <span className="pos">Exported to {p.exportedTo}</span>
            <Button variant="ghost" size="sm" onClick={p.onRevealExport}>Show in folder</Button>
          </>
        )}
      </div>
    </Card>
  );
}
```

- [ ] **Step 4: Run the panel tests**

Run: `npx vitest run src/features/settings/BackupPanel.test.tsx`
Expected: **8 passed**.

- [ ] **Step 5: Wire it up**

`src/features/settings/BackupCard.tsx`:

```tsx
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../data/api";
import {
  useBackupStatus, useBackupList, useBackupNow, useSetExtraFolder, useRestoreBackup, useExportCsv,
} from "../../data/queries";
import { localIsoDate } from "../../domain/dates";
import { whenLabel } from "../../domain/backup";
import { useToast } from "../../ui/toast";
import { BackupPanel } from "./BackupPanel";

export function BackupCard() {
  const status = useBackupStatus();
  const list = useBackupList();
  const backUp = useBackupNow();
  const setExtra = useSetExtraFolder();
  const restore = useRestoreBackup();
  const exportCsv = useExportCsv();
  const toast = useToast();
  const today = localIsoDate();

  if (!status.data) return null;

  const failed = (title: string) => (e: unknown) => toast.push({ tone: "neg", title, body: String(e) });

  // On success the app restarts, so only failure needs handling here.
  const restoreFrom = (path: string, what: string) => {
    if (!confirm(`Replace everything in Ledgerly with ${what}?\n\nYour current data is backed up first, so this can be undone. Ledgerly restarts to finish.`)) return;
    restore.mutate(path, { onError: failed("Restore didn't happen") });
  };

  return (
    <BackupPanel
      status={status.data}
      backups={list.data ?? []}
      today={today}
      busy={{ backingUp: backUp.isPending, exporting: exportCsv.isPending, restoring: restore.isPending }}
      exportedTo={exportCsv.data ?? null}
      onBackUpNow={() => backUp.mutate(undefined, {
        onSuccess: () => toast.push({ tone: "pos", title: "Backed up" }),
        onError: failed("Backup failed"),
      })}
      onChooseExtra={async () => {
        const folder = await open({ directory: true, title: "Choose a folder for extra backup copies" });
        if (typeof folder === "string") setExtra.mutate(folder, { onError: failed("Couldn't save that folder") });
      }}
      onRemoveExtra={() => setExtra.mutate(null, { onError: failed("Couldn't remove that folder") })}
      onRestore={(b) => restoreFrom(b.path, `the backup from ${whenLabel(b.date, b.time, today)}`)}
      onRestoreFromFile={async () => {
        const file = await open({
          title: "Choose a Ledgerly backup",
          filters: [{ name: "Ledgerly backup", extensions: ["sqlite"] }],
        });
        if (typeof file === "string") restoreFrom(file, `the backup in ${file}`);
      }}
      onExport={async () => {
        const folder = await open({ directory: true, title: "Choose where to save the export" });
        if (typeof folder === "string") exportCsv.mutate(folder, { onError: failed("Export failed") });
      }}
      onRevealExport={() => {
        if (exportCsv.data) api.backup.reveal(exportCsv.data).catch(failed("Couldn't open the folder"));
      }}
    />
  );
}
```

- [ ] **Step 6: Add it to Settings**

In `src/features/settings/Settings.tsx`, add `import { BackupCard } from "./BackupCard";` with the other imports, and render `<BackupCard />` between `<CategoriesCard />` and the About card. In the About card, change the `Data` line to:

```tsx
          <div><span className="muted">Data</span> · stored locally in <code>%APPDATA%\com.ledgerly.app\finance.sqlite</code>, backed up to the <code>backups</code> folder beside it</div>
```

- [ ] **Step 7: Run everything**

Run: `npm test` then `npx tsc --noEmit`
Expected: **269 passed** (257 + 4 labels + 8 panel); tsc prints nothing.

- [ ] **Step 8: Commit**

```bash
git add src/features/settings
git commit -m "feat(settings): the Backups card"
```

---

### Task 11: Check it in the running app, then record it

**Files:**
- Modify: `docs/HANDOFF.md`, `docs/TODO.md`

- [ ] **Step 1: Run the app**

Run: `npm run tauri dev`

Check by hand, in this order:
1. Settings shows a **Backups** card; "Last backup" says **Today** (the launch made a daily, since none existed today).
2. `%APPDATA%\com.ledgerly.app\backups\` holds one `…-daily.sqlite`.
3. **Back up now** → toast "Backed up", a Manual row appears.
4. **Choose…** an extra folder (any test folder), **Back up now** again → the file appears in that folder too. **Remove** it.
5. **Export to CSV…** to a test folder → seven CSVs; open `bank-transactions.csv` in Excel and confirm names, amounts and categories read correctly.
6. Note the account count, then **Restore** the Manual backup → confirm → the app restarts with the same data, and the list now has a "Before a restore" row.
7. Close and reopen the app → no new Daily row (one already exists today).

- [ ] **Step 2: Record it in HANDOFF**

In `docs/HANDOFF.md`, under "### What's built", add after the SimpleFIN sync bullet:

```markdown
- **Backups** (`src-tauri/src/backup/`): a checked `VACUUM INTO` copy in
  `%APPDATA%\com.ledgerly.app\backups\` at the first launch each day, before any
  migration, before any restore, and on "Back up now"; the newest 14 dailies are
  kept and every other kind is kept for good. An optional extra folder gets a
  copy of each. **Restore** stages the chosen file as
  `finance.sqlite.restore-pending` and restarts; the swap happens at launch,
  before `db::open`. **Export to CSV** writes seven spreadsheet-ready files.
  Spec: `docs/superpowers/specs/2026-10-14-backup-and-export-design.md`
```

Under "## Gotchas worth knowing", add:

```markdown
- **A new migration must also go into `db::migration_pending`.** That is how the
  launch backup knows to label itself `pre-migration`; forget it and the backup
  before your migration is an ordinary daily that pruning will eventually delete.
- **The launch sequence order matters**: `backup::startup::run` (restore swap,
  then backup) must stay before `db::open` in `lib.rs`.
```

In "### Remaining work", delete item **A. Backup & export** (it is done).

- [ ] **Step 3: Tick it off in TODO**

In `docs/TODO.md`, change `- [ ] **1. Backup & export.**` to `- [x] **1. Backup & export.**` and add at the end of that item: `Done 2026-10-14 — see HANDOFF "Backups".`

- [ ] **Step 4: Final check and commit**

Run: `cd src-tauri; cargo test` (expect **212 passed**), then from the repo root `npm test` (expect **269 passed**) and `npx tsc --noEmit` (clean).

```bash
git add docs/HANDOFF.md docs/TODO.md
git commit -m "docs: record backups, restore and export"
```
