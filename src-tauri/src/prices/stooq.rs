/// Parse Stooq daily CSV; return (date, close) rows in file order (oldest first).
pub fn parse_daily_csv(csv: &str) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    for line in csv.lines().skip(1) {
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 5 { continue; }
        if let Ok(close) = cols[4].parse::<f64>() {
            out.push((cols[0].to_string(), close));
        }
    }
    out
}

/// The Stooq URL for a US ticker's daily history.
pub fn daily_url(ticker: &str) -> String {
    format!("https://stooq.com/q/d/l/?s={}.us&i=d", ticker.trim().to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_last_two_closes() {
        let csv = "Date,Open,High,Low,Close,Volume\n\
                   2026-01-01,10,11,9,10.5,1000\n\
                   2026-01-02,10.5,12,10,11.25,1200\n";
        let rows = parse_daily_csv(csv);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1], ("2026-01-02".to_string(), 11.25));
    }

    #[test]
    fn builds_lowercase_us_url() {
        assert_eq!(daily_url("AAPL"), "https://stooq.com/q/d/l/?s=aapl.us&i=d");
    }
}
