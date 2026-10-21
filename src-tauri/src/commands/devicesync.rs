//! Commands for the "Sync between computers" card. Everything that touches
//! the shared folder runs off the main thread.
use crate::backup::{self, BackupState};
use crate::db::Db;
use crate::devicesync::{self, files, pair, run::RunReport, settings, DeviceSyncState};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::TryLockError;
use tauri::Manager;

#[derive(Serialize)]
pub struct DeviceSyncStatus {
    enabled: bool,
    folder: Option<String>,
    this_computer: String,
    others: Vec<files::DeviceInfo>,
    waiting: i64,
    unsent: i64,
    last: Option<RunReport>,
    last_error: Option<String>,
}

fn count(conn: &rusqlite::Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap_or(0)
}

#[tauri::command]
pub async fn device_sync_status(app: tauri::AppHandle) -> Result<DeviceSyncStatus, String> {
    super::off_main_thread(move || {
        let state = app.state::<DeviceSyncState>();
        let s = settings::load(&settings::path(&state.app_dir));
        let (waiting, unsent) = {
            let db = app.state::<Db>();
            let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
            (count(&conn, "sync_pending"), count(&conn, "sync_outbox"))
        };
        let others = match (&s.folder, &s.device_id) {
            (Some(f), Some(id)) => files::list_devices(&PathBuf::from(f), id),
            _ => vec![],
        };
        // Read into locals: guards in the tail expression would outlive `state`.
        let last = state.last.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let last_error = state.last_error.lock().unwrap_or_else(|e| e.into_inner()).clone();
        Ok(DeviceSyncStatus {
            enabled: s.folder.is_some() && s.device_id.is_some(),
            folder: s.folder,
            this_computer: devicesync::computer_name(),
            others,
            waiting,
            unsent,
            last,
            last_error,
        })
    })
    .await
}

#[tauri::command]
pub async fn device_sync_start_first(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    super::off_main_thread(move || {
        let state = app.state::<DeviceSyncState>();
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        pair::start_first(&conn, &state.app_dir, &PathBuf::from(folder)).map(|_| ())
    })
    .await
}

/// Stage the other computer's copy, then restart so it is swapped in.
/// Does not return on success.
#[tauri::command]
pub async fn device_sync_join(app: tauri::AppHandle, folder: String) -> Result<(), String> {
    let worker = app.clone();
    super::off_main_thread(move || {
        let backups = worker.state::<BackupState>();
        let db = worker.state::<Db>();
        let mut conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let safety = pair::join(&conn, &backups.paths, &PathBuf::from(folder), backup::now())?;
        backups.record(&safety);
        // Let go of finance.sqlite so the restarted app can replace it.
        *conn = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await?;
    app.restart();
}

/// One round now. If a round is already running, report the last one.
#[tauri::command]
pub async fn device_sync_now(app: tauri::AppHandle) -> Result<Option<RunReport>, String> {
    super::off_main_thread(move || {
        let state = app.state::<DeviceSyncState>();
        // A panic in an earlier round poisons the guard. That must not turn
        // "Sync now" off for the rest of the session, so only busy counts.
        let _guard = match state.running.try_lock() {
            Ok(g) => g,
            Err(TryLockError::Poisoned(p)) => p.into_inner(),
            Err(TryLockError::WouldBlock) => {
                return Ok(state.last.lock().unwrap_or_else(|e| e.into_inner()).clone());
            }
        };
        // Read under the guard, as stop does, so a round that raced Stop sees
        // sync is off instead of running after it.
        let s = settings::load(&settings::path(&state.app_dir));
        let (Some(folder), Some(id)) = (s.folder, s.device_id) else { return Ok(None) };
        let result = devicesync::run::round(&app.state::<Db>(), &PathBuf::from(folder), &id, &devicesync::computer_name());
        match &result {
            Ok(r) => {
                *state.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(r.clone());
                *state.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
            }
            Err(e) => *state.last_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(e.clone()),
        }
        result.map(Some)
    })
    .await
}

/// Send what's left, then stop. Off the main thread: the last round touches
/// the shared folder. `Some(warning)` means sync is off but the last edits
/// couldn't be sent.
#[tauri::command]
pub async fn device_sync_stop(app: tauri::AppHandle) -> Result<Option<String>, String> {
    super::off_main_thread(move || {
        let state = app.state::<DeviceSyncState>();
        // Wait for a round already running, so the last one doesn't race it.
        let _guard = state.running.lock().unwrap_or_else(|e| e.into_inner());
        let warning = devicesync::run::stop(&app.state::<Db>(), &state.app_dir, &devicesync::computer_name())?;
        // The last round belongs to the sync that just ended.
        *state.last.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *state.last_error.lock().unwrap_or_else(|e| e.into_inner()) = None;
        Ok(warning)
    })
    .await
}
