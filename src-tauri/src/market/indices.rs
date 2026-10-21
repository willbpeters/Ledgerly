//! The market board: index, volatility, yield and sector levels for the Markets
//! screen. Fetched in batches from Yahoo's spark endpoint, whose per-symbol
//! results have the chart endpoint's shape, so the existing close parser is
//! reused and only the batching and the symbol table are new.
//!
//! These deliberately do not go in `securities`: the S&P would then appear in
//! Holdings and in the allocation chart as though it were owned.

use serde_json::Value;

/// One symbol on the board. `group` tells the UI how to show it: `index` and
/// `sector` changes are coloured percentages, `volatility` an uncoloured
/// percentage, `yield` a change in basis points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoardSymbol {
    pub symbol: &'static str,
    pub label: &'static str,
    pub group: &'static str,
}

const fn s(symbol: &'static str, label: &'static str, group: &'static str) -> BoardSymbol {
    BoardSymbol { symbol, label, group }
}

/// Everything the board shows, in display order. Large cap, the tech-heavy
/// Nasdaq, the Dow, small cap, broad international (VXUS: there is no keyless
/// ex-US index symbol), the VIX, two Treasury yields, then the eleven SPDR
/// sector funds for the heatmap. A 2-year yield was wanted, but Yahoo's only
/// keyless 2-year symbol is a futures contract that reported stale moves.
pub const INDICES: &[BoardSymbol] = &[
    s("^GSPC", "S&P 500", "index"),
    s("^IXIC", "Nasdaq", "index"),
    s("^DJI", "Dow", "index"),
    s("^RUT", "Russell 2000", "index"),
    s("VXUS", "International", "index"),
    s("^VIX", "VIX", "volatility"),
    s("^TNX", "10-yr yield", "yield"),
    s("^FVX", "5-yr yield", "yield"),
    s("XLK", "Technology", "sector"),
    s("XLF", "Financials", "sector"),
    s("XLV", "Health care", "sector"),
    s("XLY", "Consumer discretionary", "sector"),
    s("XLP", "Consumer staples", "sector"),
    s("XLE", "Energy", "sector"),
    s("XLI", "Industrials", "sector"),
    s("XLB", "Materials", "sector"),
    s("XLU", "Utilities", "sector"),
    s("XLRE", "Real estate", "sector"),
    s("XLC", "Communication", "sector"),
];

/// Yahoo's spark endpoint refuses more than 20 symbols per request.
pub const SPARK_BATCH: usize = 20;

/// The benchmark every risk figure is measured against. It is one of the
/// `INDICES` above, so the ordinary board refresh keeps it current and only the
/// initial two-year backfill is extra work.
pub const BENCHMARK: &str = "^GSPC";

/// The two-year chart URL for one index. Split out from `fetch_history` so the
/// range can be asserted without a network call.
pub fn history_url(symbol: &str) -> String {
    crate::prices::yahoo::chart_url(symbol, crate::prices::yahoo::HISTORY_RANGE)
}

/// Two years of daily closes for one index, oldest first. Run once, not on a
/// timer: the board refresh stays a 5-day window.
pub fn fetch_history(symbol: &str) -> anyhow::Result<Vec<(String, f64)>> {
    let body = crate::http::client()?.get(history_url(symbol)).send()?.text()?;
    Ok(crate::prices::yahoo::parse_chart_json(&body))
}

/// The batch URL for up to `SPARK_BATCH` symbols, five days of daily closes.
/// `^` and `=` are percent-encoded by hand: they are legal in a query string,
/// and leaving them to the HTTP client's judgement is how a symbol goes missing.
pub fn spark_url(symbols: &[&str]) -> String {
    let list = symbols
        .iter()
        .map(|sym| sym.trim().to_uppercase().replace('^', "%5E").replace('=', "%3D"))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "https://query1.finance.yahoo.com/v7/finance/spark?symbols={list}&range={}&interval=1d",
        crate::prices::yahoo::RECENT_RANGE,
    )
}

/// Each symbol in a spark response with its closes, oldest first. A symbol
/// Yahoo could not serve is simply absent, so the caller can name it.
pub fn parse_spark_json(body: &str) -> Vec<(String, Vec<(String, f64)>)> {
    let v: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let Some(results) = v["spark"]["result"].as_array() else { return vec![] };
    results
        .iter()
        .filter_map(|r| {
            let symbol = r["symbol"].as_str()?.to_string();
            let closes = crate::prices::yahoo::parse_chart_result(&r["response"][0]);
            (!closes.is_empty()).then_some((symbol, closes))
        })
        .collect()
}

/// One batch request: the last few daily closes for each symbol.
pub fn fetch_board(symbols: &[&str]) -> anyhow::Result<Vec<(String, Vec<(String, f64)>)>> {
    let body = crate::http::client()?.get(spark_url(symbols)).send()?.text()?;
    Ok(parse_spark_json(&body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prices::yahoo::RECENT_RANGE;

    /// Hits the network. Run with:
    /// `cargo test --lib live_board -- --ignored --nocapture`
    #[test]
    #[ignore = "hits the network"]
    fn live_board_returns_every_symbol_with_at_least_two_days() {
        for chunk in INDICES.chunks(SPARK_BATCH) {
            let symbols: Vec<&str> = chunk.iter().map(|b| b.symbol).collect();
            let got = fetch_board(&symbols).unwrap();
            for sym in &symbols {
                let closes = got.iter().find(|(s, _)| s == sym).map(|(_, c)| c);
                assert!(closes.is_some_and(|c| c.len() >= 2), "{sym} came back short: {closes:?}");
            }
        }
    }

    #[test]
    fn the_benchmark_is_the_sp_500_and_is_on_the_board() {
        assert_eq!(BENCHMARK, "^GSPC");
        assert!(
            INDICES.iter().any(|b| b.symbol == BENCHMARK),
            "the benchmark must already be fetched by the ordinary board refresh",
        );
    }

    #[test]
    fn every_symbol_has_a_group_the_ui_knows() {
        for b in INDICES {
            assert!(["index", "volatility", "yield", "sector"].contains(&b.group), "{b:?}");
        }
        assert_eq!(INDICES.iter().filter(|b| b.group == "sector").count(), 11);
    }

    #[test]
    fn the_board_fits_in_one_request() {
        // One spark request per refresh, down from one chart request per index.
        assert!(INDICES.len() <= SPARK_BATCH, "{} symbols now need more than one request", INDICES.len());
    }

    #[test]
    fn the_spark_url_encodes_symbols_and_asks_for_five_daily_closes() {
        let url = spark_url(&["^gspc", "2YY=F", "XLK"]);
        assert!(url.contains("symbols=%5EGSPC,2YY%3DF,XLK&"), "{url}");
        assert!(url.contains("range=5d"), "{url}");
        assert!(url.contains("interval=1d"), "{url}");
        assert!(url.starts_with("https://query1.finance.yahoo.com/v7/finance/spark?"), "{url}");
    }

    #[test]
    fn spark_results_are_parsed_per_symbol_and_failures_dropped() {
        let body = r#"{"spark":{"result":[
          {"symbol":"^RUT","response":[{"meta":{"regularMarketPrice":2789.4},
             "timestamp":[1792416600,1792503000],
             "indicators":{"quote":[{"close":[2729.5,2789.4]}]}}]},
          {"symbol":"NOPE","response":null}
        ],"error":null}}"#;
        let got = parse_spark_json(body);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "^RUT");
        assert_eq!(got[0].1.iter().map(|(_, c)| *c).collect::<Vec<_>>(), vec![2729.5, 2789.4]);
        assert!(got[0].1[0].0 < got[0].1[1].0, "closes must come oldest first");
    }

    #[test]
    fn a_refused_batch_parses_to_nothing_rather_than_panicking() {
        let body = r#"{"spark":{"result":null,"error":{"code":"Bad Request"}}}"#;
        assert!(parse_spark_json(body).is_empty());
        assert!(parse_spark_json("not json").is_empty());
    }

    #[test]
    fn history_is_requested_over_two_years_and_the_board_is_not() {
        assert!(history_url(BENCHMARK).contains("range=2y"), "{}", history_url(BENCHMARK));
        assert_eq!(RECENT_RANGE, "5d", "the board refresh must not rewrite two years of rows");
    }
}
