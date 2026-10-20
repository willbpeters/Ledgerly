//! Keeping two computers' Ledgerly in step through a shared folder (Google
//! Drive). Each computer keeps its own database and syncs SimpleFIN itself;
//! only the owner's edits travel, as immutable change files.
//! Design: docs/superpowers/plans/2026-10-16-device-sync.md
pub mod apply;
pub mod clock;
pub mod files;
pub mod meta;
pub mod outbox;
pub mod pair;
pub mod pull;
pub mod run;
pub mod schema;
pub mod settings;

use std::path::PathBuf;
use std::sync::Mutex;

/// What this session knows beyond the files: the last round's result, and a
/// guard so the timer and the "Sync now" button never run two rounds at once.
pub struct DeviceSyncState {
    pub app_dir: PathBuf,
    pub last: Mutex<Option<run::RunReport>>,
    pub last_error: Mutex<Option<String>>,
    pub running: Mutex<()>,
}

impl DeviceSyncState {
    pub fn new(app_dir: PathBuf) -> Self {
        DeviceSyncState { app_dir, last: Mutex::new(None), last_error: Mutex::new(None), running: Mutex::new(()) }
    }
}

/// This computer's name as Windows knows it, for the other computer's card.
pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "This computer".into())
}
