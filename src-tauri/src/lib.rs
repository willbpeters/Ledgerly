mod db;
mod http;
mod models;
mod commands;
mod prices;
mod secrets;
mod simplefin;
mod budget;
mod market;
mod backup;
mod devicesync;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // keep whatever plugins scaffold added
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("create app data dir");
            let paths = backup::Paths::new(&dir);
            // Before db::open: a staged restore must be swapped in first, and a
            // database about to be migrated must be backed up while it still
            // is the old version.
            let report = backup::startup::run(&paths, backup::now());
            let conn = db::open(&paths.db()).expect("open db");
            // After open, so a just-joined copy of the other computer's
            // database takes this computer's identity before anything is recorded.
            let sync_settings = devicesync::settings::load(&devicesync::settings::path(&dir));
            if let Err(e) = devicesync::meta::adopt(&conn, &sync_settings) {
                eprintln!("device sync: {e}");
                // A just-joined copy must never record under the other
                // computer's id. Off until the next launch adopts cleanly.
                let _ = devicesync::meta::disable(&conn);
            }
            app.manage(db::Db(std::sync::Mutex::new(conn)));
            app.manage(devicesync::DeviceSyncState::new(dir.clone()));
            app.manage(backup::BackupState::new(paths, report.attempt, report.restore_error));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts::accounts_list,
            commands::accounts::accounts_create,
            commands::accounts::accounts_delete,
            commands::accounts::accounts_set_hidden,
            commands::securities::securities_list,
            commands::securities::securities_get_or_create,
            commands::transactions::transactions_list,
            commands::transactions::transactions_create,
            commands::transactions::transactions_create_many,
            commands::transactions::transactions_delete,
            commands::prices::prices_latest,
            commands::prices::prices_previous,
            commands::prices::prices_set_manual,
            commands::prices::prices_refresh,
            commands::prices::prices_backfill,
            commands::prices::prices_history_depth,
            commands::prices::prices_history,
            commands::snapshots::snapshots_list,
            commands::snapshots::snapshots_record,
            commands::simplefin::simplefin_status,
            commands::simplefin::simplefin_connect,
            commands::simplefin::simplefin_sync,
            commands::simplefin::simplefin_backfill,
            commands::simplefin::simplefin_diagnose,
            commands::simplefin::simplefin_disconnect,
            commands::simplefin::synced_holdings_list,
            commands::budget::categories_list,
            commands::budget::categories_create,
            commands::budget::categories_update,
            commands::budget::categories_delete,
            commands::budget::bank_transactions_list,
            commands::budget::bank_transactions_range,
            commands::budget::bank_transaction_set_category,
            commands::budget::bank_transactions_to_review,
            commands::budget::bank_transactions_approve,
            commands::budget::bank_transactions_set_removed,
            commands::budget::bank_transactions_restore,
            commands::budget::rules_list,
            commands::budget::rules_delete,
            commands::budget::budgets_list,
            commands::budget::budget_set,
            commands::budget::accounts_set_type,
            commands::market::market_news_list,
            commands::market::market_earnings_list,
            commands::market::market_profiles_list,
            commands::market::market_indices,
            commands::market::market_index_history,
            commands::market::market_index_depth,
            commands::market::market_index_backfill,
            commands::market::market_refresh,
            commands::backup::backup_status,
            commands::backup::backup_list,
            commands::backup::backup_now,
            commands::backup::backup_set_extra_folder,
            commands::backup::backup_restore,
            commands::backup::export_csv,
            commands::backup::reveal_path,
            commands::copilot::copilot_preview,
            commands::copilot::copilot_import,
            commands::devicesync::device_sync_status,
            commands::devicesync::device_sync_start_first,
            commands::devicesync::device_sync_join,
            commands::devicesync::device_sync_now,
            commands::devicesync::device_sync_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
