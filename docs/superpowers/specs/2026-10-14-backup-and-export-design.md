# Backup, restore and CSV export

**Date:** 2026-10-14
**Status:** design agreed, not yet implemented
**TODO item:** 1 (Phase 1, protect your data)

## The problem

Everything Ledgerly knows lives in one unencrypted SQLite file,
`%APPDATA%\com.ledgerly.app\finance.sqlite`. The only copy of it is
`finance.sqlite.backup-pre-v2`, made by hand weeks ago. A bad migration, a bug
that deletes rows, a corrupt write or a failed disk loses everything, and nothing
in the app can bring the data back. Separately, there is no way to get the data
*out* in a form another tool can read.

## Decisions taken

1. **Backups are made with `VACUUM INTO`.** It is one SQL statement that writes a
   consistent copy even while the app is writing, compacts the copy, and needs no
   new dependency. Rejected: the `rusqlite` online-backup API (equally safe, more
   code, a new cargo feature) and a plain file copy (can capture a half-written
   file).
2. **Every backup is checked after it is written**: open it read-only and run
   `PRAGMA quick_check`. A backup that fails is deleted and reported. A backup
   nobody has checked is not a backup.
3. **Location: the app's own folder, plus an optional extra folder.** Backups
   always go to `%APPDATA%\com.ledgerly.app\backups\`. If the owner picks an extra
   folder (USB drive, OneDrive), each finished backup is also copied there.
   Until item 19 (encryption) lands, a cloud folder holds the finances
   unencrypted; the Settings card says so beside the folder picker.
4. **In-app restore, always preceded by a safety backup**, so any restore can be
   undone.
5. **Export is CSV files in a dated folder** the owner chooses.

## When a backup is made

Each backup has a **kind**, which is part of its file name and decides whether it
is ever pruned.

| Kind | When | Pruned? |
|---|---|---|
| `daily` | At launch, if no backup of any kind exists yet with today's local date | Yes — the newest 14 are kept |
| `pre-migration` | At launch, before `db::open` changes the database's structure | Never |
| `pre-restore` | Immediately before a restore replaces the database | Never |
| `manual` | The "Back up now" button | Never |

"Today" is the **local** date (`chrono::Local`), for the same reason the frontend
uses `localIsoDate()`: a UTC date is already tomorrow on a Pacific-time evening.

A daily backup happens only at launch. If the app stays open across midnight,
the next daily is taken at the next launch. That is acceptable: the risky moments
(launch-time migrations, restores) are covered by their own kinds.

### File names

```
ledgerly-2026-10-14-093012-daily.sqlite
ledgerly-2026-10-14-180455-manual.sqlite
```

`ledgerly-<local date>-<HHMMSS>-<kind>.sqlite`. The name alone carries the date
and the kind, so listing, "already backed up today?" and pruning are pure
functions over a list of file names, testable without touching disk. Files in
the folder that do not match the pattern are ignored, never pruned. If a name is
already taken (two backups in one second), `-2`, `-3`, … are appended before
`.sqlite`; `VACUUM INTO` refuses to write over an existing file, so this matters.

### Pruning

After every successful backup, `daily` files beyond the newest 14 are deleted,
in the backups folder and in the extra folder alike. Nothing else is ever
deleted automatically.

## Startup sequence

Today `lib.rs` calls `db::open`, which migrates as it opens. The new sequence,
in a `backup::startup` function called from `setup` before `db::open`:

1. **Apply a pending restore**, if `finance.sqlite.restore-pending` exists (see
   Restore). This happens first, so everything after it sees the restored file.
2. If `finance.sqlite` does not exist (first run), stop here: there is nothing to
   back up.
3. Open the file **without migrating** and ask `db::migration_pending(&conn)`
   whether opening it normally would change it.
4. If a migration is pending → make a `pre-migration` backup.
   Otherwise, if no backup is dated today → make a `daily` backup.
5. Close that connection. `lib.rs` then calls `db::open` exactly as now.

`db::migration_pending` is new. It returns true when `user_version < 1` or any of
the existing `v2_is_complete` … `v5_is_complete` checks is false — the same
questions `apply_migrations` asks, without acting on the answers. Any future
migration must be added to both, and a test pins that a fully migrated database
reports `false` while a v1 database reports `true`.

**A failed backup never stops the app from opening.** Startup failures are
recorded in the in-memory backup status (below) and shown in Settings. A failed
`pre-migration` backup does not block the migration either: refusing to open
the app would turn a backup problem into a lost-access problem.

## Restore

1. Settings lists the backups in the backups folder, newest first, with date,
   time, kind and size. A separate **"Restore from a file…"** button opens a
   file picker, for a backup living only in the extra folder (the case where
   the PC's drive died and this is a fresh install).
2. The owner confirms: *"Replace everything in Ledgerly with the backup from
   14 Oct 2026, 09:30? Your current data is backed up first, so this can be
   undone."*
3. The command, holding the database lock:
   - checks the chosen file with `quick_check` and confirms it has an
     `accounts` table (so a random `.sqlite` file is refused with a clear
     message);
   - makes a `pre-restore` backup of the current database;
   - copies the chosen file to `finance.sqlite.restore-pending` in the app data
     folder. Copying first means a USB drive can be unplugged safely after
     this point.
4. The app restarts (`AppHandle::restart`).
5. On launch, step 1 of the startup sequence deletes `finance.sqlite-journal`,
   `-wal` and `-shm` if present — a leftover journal from the *old* database
   would otherwise be replayed into the restored one and corrupt it — then
   renames `restore-pending` over `finance.sqlite`. `db::open` then runs, so a
   backup from an older version is migrated forward as usual.

If the pending file fails its check at launch, it is deleted, the current
database is left untouched, and the failure appears in Settings.

## Export

"Export to CSV…" opens a folder picker. Ledgerly creates
`Ledgerly export 2026-10-14` inside it (with ` (2)` etc. if that exists) and
writes:

| File | Rows | Readable columns instead of IDs |
|---|---|---|
| `accounts.csv` | every account, hidden ones included, with a `hidden` column | — |
| `investment-transactions.csv` | `transactions` | account name, ticker |
| `bank-transactions.csv` | `bank_transactions` | account name, category name |
| `synced-holdings.csv` | `synced_holdings` | account name, ticker |
| `categories.csv` | `categories` | — |
| `budgets.csv` | `budgets` | category name |
| `category-rules.csv` | `category_rules` | category name |

Market caches (prices, news, earnings, profiles, index quotes) and snapshots
are not exported: they are re-fetchable or derived.

CSV rules: UTF-8 with a byte-order mark (so Excel reads accented payees
correctly), comma-separated, a header row, fields containing a comma, quote or
line break wrapped in quotes with quotes doubled. Dates are ISO `YYYY-MM-DD`;
money is the plain stored number. **Text fields starting with `=`, `+`, `-` or
`@` get a leading `'`**, because bank descriptions are third-party text and
Excel would otherwise run them as formulas. Numeric columns are never prefixed,
so a negative amount stays a number.

## Settings

`backup-settings.json` in the app data folder holds `{ "extra_folder": string | null }`.
It lives **beside** the database rather than in it, so restoring an older backup
does not forget where the extra copies go.

## Status shown to the owner

A `BackupStatus` held in Tauri state (not persisted) records the outcome of the
last backup attempt this session: when, which kind, and an error if it failed,
plus a separate warning if the extra-folder copy failed. "Last backup" in
Settings is the newest file in the backups folder, so it is right across
restarts.

## Code layout

Rust, a new `src-tauri/src/backup/` module, following the project's split of pure
logic from I/O:

| File | Job |
|---|---|
| `backup/naming.rs` | **Pure.** Build a file name; parse one into (date, time, kind); "is there a backup today?"; which files pruning removes. |
| `backup/snapshot.rs` | `VACUUM INTO` a new file, `quick_check` it, copy to the extra folder, prune. |
| `backup/startup.rs` | The startup sequence, including applying a pending restore. |
| `backup/restore.rs` | Validate a chosen file and stage it as `restore-pending`. |
| `backup/export.rs` | The CSV writer (quoting, BOM, formula guard) and the seven queries. |
| `backup/settings.rs` | Read and write `backup-settings.json`. |
| `backup/mod.rs` | Paths (`backups/`, pending file, settings file) and `BackupStatus`. |
| `commands/backup.rs` | `backup_status`, `backup_list`, `backup_now`, `backup_set_extra_folder`, `backup_restore`, `export_csv`. |

Commands that touch disk are `async` and use `commands::off_main_thread`, like the
network commands, so a slow USB drive never freezes the window. They lock the
database only for the `VACUUM INTO` and the export queries.

Frontend: `src/features/settings/BackupCard.tsx`, built from the existing UI kit
(`Card`, `Button`, `DataTable`, `EmptyState`, toasts), with query and mutation
hooks beside the others in `src/data/`.

New dependency: **`tauri-plugin-dialog`** (Rust) and **`@tauri-apps/plugin-dialog`**
(npm), the official Tauri plugin, for the folder and file pickers. The capability
file gains `dialog:allow-open`.

## The Backups card

- **Last backup:** "Today, 09:30 (daily)", or a warning row if the last attempt
  failed, with the reason.
- **Back up now** button.
- **Extra copy folder:** the path or "None", with **Choose…** and **Remove**,
  plus the one-line note that a cloud folder holds the data unencrypted.
- **Backups list:** date, kind, size, and a **Restore** button per row; an empty
  state before the first backup. **Restore from a file…** below the list.
- **Export to CSV…** button; on success a toast with the folder path and an
  "Open folder" action through the opener plugin already installed.

## Testing

Rust, against temporary folders and real SQLite files:

- `naming`: round-trips a name; ignores files that do not match; "backed up
  today" is true for a backup of any kind dated today and false for yesterday;
  pruning removes only `daily` files beyond the newest 14 and never touches
  other kinds or unknown files; a taken name gets `-2`.
- `snapshot`: a backup of a populated database has the same rows; the backup is
  written to the extra folder too; an unreachable extra folder gives a warning
  and still leaves the main backup.
- `db::migration_pending`: false for a freshly migrated database, true for a v1
  database.
- `startup`: a pending restore replaces the database and removes a stale
  `-journal` file; a corrupt pending file is deleted and the database is left
  alone; a pending migration produces a `pre-migration` backup; a second launch
  on the same day makes no new daily.
- `restore`: a non-Ledgerly SQLite file is refused; a valid one produces a
  `pre-restore` backup and a pending file.
- `export`: quoting of commas, quotes and line breaks; the BOM; the formula
  guard prefixes text but not negative numbers; each file's header and a row
  with names joined in.

Frontend: `BackupCard` renders the empty state, a list, and the failure warning.

## Deliberately out of scope

- Encrypting backups — comes with item 19, which should make the backups
  encrypted too.
- Scheduled backups while the app stays open, and a configurable count to keep.
- Importing the CSV export back in. Restore covers getting data back; the
  export is for reading and leaving.
