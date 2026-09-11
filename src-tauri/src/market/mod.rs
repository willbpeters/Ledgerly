//! The Markets module: headlines, earnings and index levels for held
//! securities. Laid out like `simplefin/` — HTTP, pure parsing and SQLite are
//! separate files, so the parsing is fixture-testable with no network.
pub mod benchmarks;
pub mod profile;
pub mod rss;
pub mod store;
pub mod yahoo_news;
