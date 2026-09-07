mod db;
mod models;
mod commands;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init()) // keep whatever plugins scaffold added
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("no app data dir");
            std::fs::create_dir_all(&dir).expect("create app data dir");
            let conn = db::open(&dir.join("finance.sqlite")).expect("open db");
            app.manage(db::Db(std::sync::Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::accounts::accounts_list,
            commands::accounts::accounts_create,
            commands::accounts::accounts_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
