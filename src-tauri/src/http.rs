//! The one place outbound HTTP clients are built for the market and price
//! fetchers.
//!
//! Every request gets a timeout. Without one a single stuck request to Yahoo
//! or Nasdaq hangs its refresh for as long as the socket stays open, and while
//! that refresh holds the database lock, every screen hangs with it.
use std::time::Duration;

/// Yahoo and Nasdaq answer in well under a second when healthy; anything past
/// this is stuck, and the cached value on screen is the better answer.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Yahoo rejects plain clients; a browser-like User-Agent works.
pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Ledgerly/0.1";

/// The client every market and price fetch uses.
pub fn client() -> reqwest::Result<reqwest::blocking::Client> {
    client_with_timeout(REQUEST_TIMEOUT)
}

/// `client` with a chosen timeout, so the test can wait milliseconds, not 15s.
pub fn client_with_timeout(timeout: Duration) -> reqwest::Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .user_agent(UA)
        .timeout(timeout)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A server that accepts a connection and then never answers — the shape
    /// of a stuck upstream. Returns its URL.
    fn silent_server() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming().flatten() {
                held.push(stream); // keep it open, say nothing
            }
        });
        format!("http://{addr}/")
    }

    #[test]
    fn a_request_to_a_server_that_never_answers_gives_up() {
        let url = silent_server();
        let started = Instant::now();
        let result = client_with_timeout(Duration::from_millis(300)).unwrap().get(url).send();
        assert!(result.is_err(), "a silent server must produce an error, not a hang");
        assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    }

    #[test]
    fn the_standard_timeout_is_short_enough_not_to_stall_a_refresh() {
        assert!(REQUEST_TIMEOUT <= Duration::from_secs(15));
    }
}
