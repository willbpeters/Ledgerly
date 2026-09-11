//! What a fund tracks, as a small static map in the spirit of `budget/mcc.rs`.
//! An unknown fund gets no label rather than a guess.

const MAP: &[(&str, &str)] = &[
    ("SWPPX", "S&P 500"),
    ("VOO", "S&P 500"),
    ("SPY", "S&P 500"),
    ("IVV", "S&P 500"),
    ("SWLGX", "US large-cap growth"),
    ("SWSSX", "US small-cap"),
    ("SWISX", "MSCI EAFE (international)"),
    ("SWTSX", "US total market"),
    ("VTI", "US total market"),
    ("QQQ", "Nasdaq 100"),
];

pub fn tracks_for(ticker: &str) -> Option<&'static str> {
    let t = ticker.trim().to_uppercase();
    MAP.iter().find(|(sym, _)| *sym == t).map(|(_, label)| *label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_funds_get_a_label_and_unknown_ones_get_nothing() {
        assert_eq!(tracks_for("SWPPX"), Some("S&P 500"));
        assert_eq!(tracks_for("swppx"), Some("S&P 500"), "case-insensitive");
        assert_eq!(tracks_for("SOMEFUND"), None, "never guess");
    }
}
