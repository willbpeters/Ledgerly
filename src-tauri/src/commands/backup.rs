//! Commands for the Backups card in Settings. Anything that writes files runs
//! off the main thread, so a slow USB drive never freezes the window.
use crate::backup::{self, export, naming::Kind, settings, snapshot, Attempt, BackupState};
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
        // Through devicesync, which turns sync between computers off too: the
        // backup would otherwise have every change file replayed onto it.
        let safety = crate::devicesync::pair::stage_restore(&conn, &state.paths, &PathBuf::from(path), backup::now())?;
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
