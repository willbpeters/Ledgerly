//! Secrets live in the OS credential store (Windows Credential Manager),
//! never in SQLite or logs. Keys are short identifiers like
//! "simplefin_access_url".
use keyring::{Entry, Error};

const SERVICE: &str = "Ledgerly";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| format!("Credential store unavailable: {e}"))
}

/// Read a secret. `Ok(None)` when nothing is stored under `key`.
pub fn get(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Couldn't read from the credential store: {e}")),
    }
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|e| format!("Couldn't save to the credential store: {e}"))
}

/// Remove a secret. Succeeds if it was already absent.
pub fn delete(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Couldn't remove from the credential store: {e}")),
    }
}
