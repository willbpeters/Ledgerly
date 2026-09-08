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

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips a value through the real Windows Credential Manager under a
    /// throwaway key, then removes it. Ignored by default because it touches
    /// the machine's credential store; run with
    /// `cargo test credential_store_round_trip -- --ignored`.
    #[test]
    #[ignore = "touches the OS credential store"]
    fn credential_store_round_trip() {
        const KEY: &str = "ledgerly_test_round_trip";
        // Start clean even if a previous run died halfway.
        delete(KEY).unwrap();
        assert_eq!(get(KEY).unwrap(), None, "should start with nothing stored");

        set(KEY, "https://user:pass@example.com/simplefin").unwrap();
        assert_eq!(
            get(KEY).unwrap().as_deref(),
            Some("https://user:pass@example.com/simplefin")
        );

        // Overwriting replaces rather than erroring.
        set(KEY, "https://user:pass2@example.com/simplefin").unwrap();
        assert_eq!(
            get(KEY).unwrap().as_deref(),
            Some("https://user:pass2@example.com/simplefin")
        );

        delete(KEY).unwrap();
        assert_eq!(get(KEY).unwrap(), None, "delete should remove the entry");
        // Deleting again is a no-op, not an error.
        delete(KEY).unwrap();
    }
}
