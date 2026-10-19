//! Keeping two computers' Ledgerly in step through a shared folder (Google
//! Drive). Each computer keeps its own database and syncs SimpleFIN itself;
//! only the owner's edits travel, as immutable change files.
//! Design: docs/superpowers/plans/2026-10-16-device-sync.md
pub mod meta;
pub mod schema;
pub mod settings;
