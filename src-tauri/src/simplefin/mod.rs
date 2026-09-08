//! SimpleFIN Bridge integration: token claim, account fetch, and sync into
//! SQLite. `parse` is pure and fixture-tested; `client` does HTTP; `sync`
//! writes to the database.
pub mod parse;
pub mod client;
pub mod sync;

pub use parse::{SfAccount, SfAccountSet, SfHolding};
// pub use sync::SyncReport; // restored in Task 5
