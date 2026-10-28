//! Import from Copilot: a dry-run preview, then the import itself.
use crate::backup::{self, naming::Kind, snapshot, BackupState};
use crate::budget::{copilot, store};
use crate::db::Db;
use tauri::Manager;

fn plan_from(conn: &rusqlite::Connection, path: &str) -> Result<copilot::Plan, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Couldn't read that file: {e}"))?;
    let rows = copilot::parse_csv(&text)?;
    store::copilot_preview(conn, &rows)
}

/// What an import would do, without doing it.
#[tauri::command]
pub async fn copilot_preview(app: tauri::AppHandle, path: String) -> Result<copilot::Plan, String> {
    super::off_main_thread(move || {
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        plan_from(&conn, &path)
    })
    .await
}

/// Backs up first, then writes the whole import in one transaction. The plan
/// is made again here rather than trusted from the preview, so it reflects the
/// database as it is at the moment of writing. `remove_ids` are the rows
/// Copilot does not have that the owner left ticked.
#[tauri::command]
pub async fn copilot_import(
    app: tauri::AppHandle,
    path: String,
    remove_ids: Vec<i64>,
) -> Result<store::CopilotCounts, String> {
    super::off_main_thread(move || {
        let state = app.state::<BackupState>();
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
        let plan = plan_from(&conn, &path)?;
        let safety = snapshot::attempt(&conn, &state.paths, Kind::Manual, backup::now());
        state.record(&safety);
        if let Some(e) = safety.error {
            return Err(format!("Didn't import, because the backup before it failed: {e}"));
        }
        store::apply_copilot_plan(&conn, &plan, &remove_ids).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    /// Runs the planner on a real export against a copy of a real database,
    /// read-only, and prints what an import would do. Ignored by default:
    /// `LEDGERLY_DB=... COPILOT_CSV=... cargo test copilot_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn copilot_live_preview() {
        let db = std::env::var("LEDGERLY_DB").expect("LEDGERLY_DB");
        let csv = std::env::var("COPILOT_CSV").expect("COPILOT_CSV");
        // The preview dry-runs the import (rolled back), so it needs a
        // writable database: a throwaway copy, never the original.
        let copy = std::env::temp_dir().join("tally-copilot-live-preview.sqlite");
        std::fs::copy(&db, &copy).unwrap();
        let conn = rusqlite::Connection::open(&copy).unwrap();
        let plan = super::plan_from(&conn, &csv).unwrap();
        println!(
            "matched {} | added {} | skipped {} | not in copilot {} | pending/excluded {} | new categories {:?} | rules {}",
            plan.matches.len(), plan.additions.len(), plan.skipped.len(), plan.not_in_copilot.len(), plan.pending_or_excluded,
            plan.new_categories.iter().map(|c| &c.name).collect::<Vec<_>>(), plan.rules.len(),
        );
        println!("accounts {:?}", plan.accounts);
        println!(
            "cutoff {} | merges {:?} | deletions {:?} | recategorised {} | untouched after cutoff {}",
            plan.cutoff, plan.merges, plan.deletions, plan.recategorised, plan.untouched_after_cutoff,
        );
        println!("category holds {:?}", plan.category_holds);
        println!("export categories {:?}", plan.export_categories);
    }
}
