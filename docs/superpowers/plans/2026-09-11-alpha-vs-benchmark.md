# Alpha versus the S&P — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show, on the dashboard, whether the portfolio has beaten the S&P 500 after accounting for how much market risk it carries — Jensen's alpha, with beta, R² and annualised volatility alongside it.

**Architecture:** Two years of `^GSPC` closes are backfilled into the existing `index_quotes` table, so the index is never a row in `securities` and can never appear as a holding. A pure domain function aligns every holding's price history onto the benchmark's trading calendar and turns it into daily returns; a second pure function weights those into one portfolio series and regresses it against the benchmark. A thin React hook feeds the domain layer from SQLite; a card renders the result. All maths is pure TypeScript with no React and no I/O, tested against answers checkable by hand.

**Tech Stack:** Rust (Tauri 2, rusqlite), TypeScript, React 18, TanStack Query, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-11-alpha-vs-benchmark-design.md`

---

## Background for the engineer

Read this before Task 1. It is the domain knowledge the tasks assume.

**What alpha is.** Regress the portfolio's daily returns on the benchmark's daily returns. The slope is **beta** — how much the portfolio moves for each 1% the market moves. The intercept is **alpha** — the average daily return left over that the market does not explain. A portfolio holding 1.4×-beta technology stocks beats the S&P in any rising market; alpha is the number that says whether it beat it by *more than that extra risk accounts for*. Multiply the daily intercept by 252 (trading days in a year) to annualise.

**Why every function returns `null`.** This is a personal-finance app. A confident-looking wrong number is worse than no number. `src/domain/risk.ts` already states this rule at the top of the file and this plan follows it everywhere: when a figure cannot be computed honestly the answer is `null`, never `0` and never `NaN`.

**The benchmark is not a security.** `src-tauri/src/market/indices.rs` says in its header comment that indices deliberately do not go in `securities`, because the S&P would then show up in Holdings and the allocation chart as though it were owned. The `index_quotes` table `(symbol, date, close)` exists for exactly this. Do not add `SPY` or `^GSPC` to `securities` at any point in this plan.

**Weights are today's weights.** The app cannot reconstruct what was held two years ago — SimpleFIN reports only current holdings, which is why `src/domain/history.ts` limits its chart to 90 days. So the portfolio return series applies **today's** weights to each holding's historical returns. The card must say so in words; Task 8 does that.

**Conventions used throughout:** sample variance and sample standard deviation (divide by `n − 1`), simple daily returns (`close[t] / close[t−1] − 1`), risk-free rate treated as zero, 252 trading days per year.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src-tauri/src/market/indices.rs` | modify | Add `BENCHMARK` symbol and a 2-year `fetch_history`, alongside the existing 5-day `fetch_closes`. |
| `src-tauri/src/market/store.rs` | modify | Add `index_history` (all closes for one symbol) and `index_history_depth` (row count). |
| `src-tauri/src/market/mod.rs` | modify | Add `backfill_indices` — the 2-year fetch-and-store pass. |
| `src-tauri/src/commands/market.rs` | modify | Expose `market_index_history` and `market_index_backfill`. |
| `src-tauri/src/lib.rs` | modify | Register the two new commands. |
| `src/data/api.ts` | modify | `api.market.indexHistory` and `api.market.indexBackfill`. |
| `src/data/queries.ts` | modify | `useIndexHistory`, `useIndexHistoryDepth`-equivalent, `useBackfillIndices`. |
| `src/domain/regression.ts` | **create** | Pure statistics: mean, variance, stdev, covariance, ordinary least squares, R². Knows nothing about finance. |
| `src/domain/regression.test.ts` | **create** | Textbook answers, no finance vocabulary. |
| `src/domain/returns.ts` | **create** | Align holdings' price history onto the benchmark calendar and turn it into daily returns. Reports what it excluded and why. |
| `src/domain/returns.test.ts` | **create** | Alignment, exclusion and no-forward-filling tests. |
| `src/domain/risk.ts` | modify | Add `marketExposure()` and the shared `MIN_HISTORY_DAYS` constant. Keeps the existing `concentration()` untouched. |
| `src/domain/risk.test.ts` | modify | Add a `marketExposure` describe block. |
| `src/data/priceHistory.ts` | modify | Re-export `MIN_HISTORY_DAYS` from the domain layer instead of defining its own; trigger the index backfill alongside the price backfill. |
| `src/data/useRiskSeries.ts` | **create** | Thin hook: read rows from SQLite, hand them to `alignedReturns`. Mirrors how `useValueSeries.ts` wraps `reconstructSeries`. |
| `src/features/dashboard/MarketExposureCard.tsx` | **create** | Render alpha, beta, R², volatility, the caveats and the empty state. |
| `src/features/dashboard/MarketExposureCard.test.tsx` | **create** | Rendering and empty-state tests. |
| `src/features/dashboard/Dashboard.tsx` | modify | Mount the card below `RiskCard`. |
| `docs/HANDOFF.md` | modify | Mark risk Phase 2 done. |

### Two refinements to the spec, decided here

1. **The spec put alignment in `data/useRiskSeries.ts` and listed unit tests for it.** React hooks are awkward to unit test, and the codebase already solves this: `useValueSeries.ts` is a thin hook over the pure `domain/history.ts`. So alignment lives in `src/domain/returns.ts` (pure, tested) and `useRiskSeries.ts` is a wrapper. The spec's tests for it move to `returns.test.ts` unchanged in substance.

2. **The spec excluded only holdings with *no* price history.** A holding bought three months ago has history, just not enough — and if it were included, the overlapping window would collapse to 60 days and blank the entire card for every other holding. So a holding is excluded when its own history covers fewer than `MIN_HISTORY_DAYS` of the benchmark calendar, with the reason recorded (`"no history"` vs `"short history"`) and shown on the card. This is stricter than the spec and strictly more honest.

---

## Task 1: Two years of benchmark history in `index_quotes`

**Files:**
- Modify: `src-tauri/src/market/indices.rs`
- Modify: `src-tauri/src/market/store.rs`
- Test: both files' inline `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing tests**

Append to the `mod tests` block at the bottom of `src-tauri/src/market/indices.rs`:

```rust
    #[test]
    fn the_benchmark_is_the_sp_500_and_is_one_of_the_strip_indices() {
        assert_eq!(BENCHMARK, "^GSPC");
        assert!(
            INDICES.iter().any(|(sym, _)| *sym == BENCHMARK),
            "the benchmark must already be fetched by the ordinary strip refresh",
        );
    }

    #[test]
    fn history_is_requested_over_two_years_and_the_strip_is_not() {
        assert!(history_url(BENCHMARK).contains("range=2y"), "{}", history_url(BENCHMARK));
        assert!(
            crate::prices::yahoo::chart_url(BENCHMARK, RECENT_RANGE).contains("range=5d"),
            "the 60-second refresh must not rewrite two years of rows",
        );
    }
```

Append to the `mod tests` block at the bottom of `src-tauri/src/market/store.rs`:

```rust
    #[test]
    fn index_history_returns_every_close_oldest_first() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[
            ("2026-09-10".into(), 7591.7),
            ("2026-09-08".into(), 7500.0),
            ("2026-09-09".into(), 7550.0),
        ]).unwrap();

        let rows = index_history(&conn, "^GSPC").unwrap();

        assert_eq!(rows, vec![
            ("2026-09-08".to_string(), 7500.0),
            ("2026-09-09".to_string(), 7550.0),
            ("2026-09-10".to_string(), 7591.7),
        ], "the return series is built forwards, so the rows must arrive forwards");
    }

    #[test]
    fn index_history_depth_counts_rows_for_that_symbol_only() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[
            ("2026-09-08".into(), 7500.0), ("2026-09-09".into(), 7550.0),
        ]).unwrap();
        upsert_index_closes(&conn, "^IXIC", &[("2026-09-09".into(), 23000.0)]).unwrap();

        assert_eq!(index_history_depth(&conn, "^GSPC").unwrap(), 2);
        assert_eq!(index_history_depth(&conn, "^DJI").unwrap(), 0, "never fetched is zero, not an error");
    }

    #[test]
    fn storing_index_closes_never_creates_a_security() {
        let conn = db::open_in_memory().unwrap();
        upsert_index_closes(&conn, "^GSPC", &[("2026-09-09".into(), 7550.0)]).unwrap();

        let securities: i64 = conn
            .query_row("SELECT count(*) FROM securities", [], |r| r.get(0))
            .unwrap();
        assert_eq!(securities, 0, "the S&P must never be something the owner appears to hold");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd src-tauri && cargo test --lib index_ benchmark history_is_requested storing_index
```

Expected: compile errors — `cannot find value BENCHMARK`, `cannot find function history_url`, `cannot find function index_history`, `cannot find function index_history_depth`.

- [ ] **Step 3: Add the benchmark symbol and the 2-year fetch**

In `src-tauri/src/market/indices.rs`, below the `INDICES` constant, add:

```rust
/// The benchmark every risk figure is measured against. It is one of the
/// `INDICES` above, so the ordinary strip refresh keeps it current and only the
/// initial two-year backfill is extra work.
pub const BENCHMARK: &str = "^GSPC";

/// The two-year chart URL for one index. Split out from `fetch_history` so the
/// range can be asserted without a network call.
pub fn history_url(symbol: &str) -> String {
    crate::prices::yahoo::chart_url(symbol, crate::prices::yahoo::HISTORY_RANGE)
}

/// Two years of daily closes for one index, oldest first. Run once, not on a
/// timer: `fetch_closes` stays the 5-day call the market strip uses.
pub fn fetch_history(symbol: &str) -> anyhow::Result<Vec<(String, f64)>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent(crate::market::yahoo_news::UA)
        .build()?;
    let body = client.get(history_url(symbol)).send()?.text()?;
    Ok(crate::prices::yahoo::parse_chart_json(&body))
}
```

The test references `RECENT_RANGE`; add it to the existing `use super::*;` scope by adding this line at the top of `indices.rs`'s `mod tests`:

```rust
    use crate::prices::yahoo::RECENT_RANGE;
```

- [ ] **Step 4: Add the two storage reads**

In `src-tauri/src/market/store.rs`, immediately after `list_index_quotes`, add:

```rust
/// Every stored close for one index, oldest first. The risk maths walks this
/// forwards turning closes into daily returns, so the order is load-bearing.
pub fn index_history(conn: &Connection, symbol: &str) -> rusqlite::Result<Vec<(String, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT date, close FROM index_quotes WHERE symbol=?1 ORDER BY date")?;
    let rows = stmt.query_map([symbol], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// How many closes are stored for one index. The frontend uses this to decide
/// whether the two-year backfill still needs running.
pub fn index_history_depth(conn: &Connection, symbol: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT count(*) FROM index_quotes WHERE symbol=?1", [symbol], |r| r.get(0))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd src-tauri && cargo test --lib index_ benchmark history_is_requested storing_index
```

Expected: 5 passed. If `the_benchmark_is_the_sp_500...` fails, `^GSPC` was removed from `INDICES` — restore it rather than changing `BENCHMARK`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/market/indices.rs src-tauri/src/market/store.rs
git commit -m "feat(risk): read two years of benchmark closes from index_quotes" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The backfill pass and its commands

**Files:**
- Modify: `src-tauri/src/market/mod.rs`
- Modify: `src-tauri/src/commands/market.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Append to the `mod tests` block at the bottom of `src-tauri/src/market/mod.rs`. If that file has no `mod tests` block, add one at the end of the file:

```rust
#[cfg(test)]
mod backfill_tests {
    use super::*;
    use crate::db;

    #[test]
    fn a_backfill_stores_every_close_it_is_given_and_counts_them() {
        let conn = db::open_in_memory().unwrap();
        // Distinct dates across four months, so the count is a real count.
        let closes: Vec<(String, f64)> = (0..120)
            .map(|i| (format!("2025-{:02}-{:02}", (i / 30) + 1, (i % 30) + 1), 7000.0 + i as f64))
            .collect();

        let stored = store_benchmark_history(&conn, &closes).unwrap();

        assert_eq!(stored, 120, "every distinct date is a row");
        assert_eq!(
            stored,
            store::index_history_depth(&conn, indices::BENCHMARK).unwrap() as usize,
        );
    }

    #[test]
    fn a_second_backfill_replaces_rows_rather_than_doubling_them() {
        let conn = db::open_in_memory().unwrap();
        let closes = [("2025-01-02".to_string(), 7000.0), ("2025-01-03".to_string(), 7050.0)];

        store_benchmark_history(&conn, &closes).unwrap();
        let stored = store_benchmark_history(&conn, &closes).unwrap();

        assert_eq!(stored, 2, "(symbol, date) is the primary key; re-running is safe");
    }

    #[test]
    fn a_backfill_does_not_create_a_security_for_the_benchmark() {
        let conn = db::open_in_memory().unwrap();
        store_benchmark_history(&conn, &[("2025-01-02".into(), 7000.0)]).unwrap();

        let securities: i64 = conn
            .query_row("SELECT count(*) FROM securities", [], |r| r.get(0))
            .unwrap();
        assert_eq!(securities, 0);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src-tauri && cargo test --lib backfill_tests
```

Expected: `cannot find function store_benchmark_history in this scope`.

- [ ] **Step 3: Add the backfill functions**

In `src-tauri/src/market/mod.rs`, after `refresh_all`, add:

```rust
/// Store a run of benchmark closes and report how many rows the table now
/// holds. Split from `backfill_benchmark` so the storage half is testable
/// without a network call.
pub fn store_benchmark_history(
    conn: &Connection,
    closes: &[(String, f64)],
) -> rusqlite::Result<usize> {
    store::upsert_index_closes(conn, indices::BENCHMARK, closes)?;
    Ok(store::index_history_depth(conn, indices::BENCHMARK)? as usize)
}

/// Download two years of benchmark closes. Run once after upgrade, never on a
/// timer — the ordinary market refresh keeps the last few days current.
pub fn backfill_benchmark(conn: &Connection) -> Result<usize, String> {
    let closes = indices::fetch_history(indices::BENCHMARK).map_err(|e| e.to_string())?;
    store_benchmark_history(conn, &closes).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd src-tauri && cargo test --lib backfill_tests
```

Expected: 3 passed.

- [ ] **Step 5: Expose the two commands**

Append to `src-tauri/src/commands/market.rs`:

```rust
/// Two years of benchmark closes, oldest first, as (date, close).
#[tauri::command]
pub fn market_index_history(db: tauri::State<Db>) -> Result<Vec<(String, f64)>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::index_history(&conn, market::indices::BENCHMARK).map_err(|e| e.to_string())
}

/// How many benchmark closes are stored. The frontend backfills when this is
/// short, so it is not re-downloaded on every launch.
#[tauri::command]
pub fn market_index_depth(db: tauri::State<Db>) -> Result<i64, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::index_history_depth(&conn, market::indices::BENCHMARK).map_err(|e| e.to_string())
}

/// Download the benchmark's two-year history. Run rarely — see
/// `backfill_benchmark`.
#[tauri::command]
pub fn market_index_backfill(db: tauri::State<Db>) -> Result<usize, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    market::backfill_benchmark(&conn)
}
```

- [ ] **Step 6: Register the commands**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![...]`, immediately after the line `commands::market::market_indices,` add:

```rust
            commands::market::market_index_history,
            commands::market::market_index_depth,
            commands::market::market_index_backfill,
```

- [ ] **Step 7: Verify the whole crate still builds and all tests pass**

```bash
cd src-tauri && cargo test --lib
```

Expected: the full suite passes. A `no method named ...` error here means a `pub` was missed in Task 1.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/market/mod.rs src-tauri/src/commands/market.rs src-tauri/src/lib.rs
git commit -m "feat(risk): backfill two years of benchmark history" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `domain/regression.ts` — pure statistics

No finance in this file. Every answer is checkable against a textbook.

**Files:**
- Create: `src/domain/regression.ts`
- Test: `src/domain/regression.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/regression.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mean, variance, stdev, covariance, fit } from "./regression";

describe("summary statistics", () => {
  it("takes the mean of a series", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("gives a constant series exactly zero variance, not a rounding artefact", () => {
    expect(variance([5, 5, 5, 5])).toBe(0);
    expect(stdev([5, 5, 5, 5])).toBe(0);
  });

  it("uses the sample convention, dividing by n-1", () => {
    // [2,4,4,4,5,5,7,9]: deviations squared sum to 32, over n-1 = 7.
    expect(variance([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(32 / 7, 12);
  });

  it("treats the covariance of a series with itself as its variance", () => {
    const xs = [1, 4, 2, 8, 5, 7];
    expect(covariance(xs, xs)).toBeCloseTo(variance(xs)!, 12);
  });

  it("returns null rather than a number when there is nothing to measure", () => {
    expect(mean([])).toBeNull();
    expect(variance([3])).toBeNull();
    expect(stdev([])).toBeNull();
    expect(covariance([1], [1])).toBeNull();
  });

  it("throws on mismatched lengths, because that is a bug and not a data condition", () => {
    expect(() => covariance([1, 2, 3], [1, 2])).toThrow(/same length/);
  });
});

describe("fit", () => {
  it("recovers the slope and intercept of a straight line", () => {
    const xs = [1, 2, 3, 4, 5];
    const ys = xs.map((x) => 2 * x + 3);
    const f = fit(xs, ys)!;
    expect(f.slope).toBeCloseTo(2, 12);
    expect(f.intercept).toBeCloseTo(3, 12);
    expect(f.r2).toBeCloseTo(1, 12);
  });

  it("fits a series against itself as slope 1, intercept 0", () => {
    const xs = [0.01, -0.02, 0.005, 0.03, -0.01, 0.002];
    const f = fit(xs, xs)!;
    expect(f.slope).toBeCloseTo(1, 12);
    expect(f.intercept).toBeCloseTo(0, 12);
    expect(f.r2).toBeCloseTo(1, 12);
  });

  it("fits a series against its negation as a perfect fit with a negative slope", () => {
    const xs = [0.01, -0.02, 0.005, 0.03, -0.01, 0.002];
    const f = fit(xs, xs.map((x) => -x))!;
    expect(f.slope).toBeCloseTo(-1, 12);
    expect(f.r2).toBeCloseTo(1, 12, "a mirror image is still perfectly explained");
  });

  it("refuses to regress against a flat independent series", () => {
    expect(fit([1, 1, 1, 1], [2, 4, 6, 8])).toBeNull();
  });

  it("says the market explains none of a series that never moves", () => {
    const f = fit([0.01, -0.02, 0.005, 0.03], [7, 7, 7, 7])!;
    expect(f.slope).toBe(0);
    expect(f.r2).toBe(0);
  });

  it("returns null for fewer than two points", () => {
    expect(fit([1], [2])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/domain/regression.test.ts
```

Expected: FAIL — `Failed to resolve import "./regression"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/regression.ts`:

```ts
/**
 * Ordinary least squares and the summary statistics it needs. Deliberately
 * free of any finance vocabulary: this file knows about `xs` and `ys`, not
 * about markets, so its answers can be checked against a textbook.
 *
 * Everything returns `null` when there is not enough data to answer, never 0
 * and never NaN — see the note at the top of `risk.ts` for why that matters
 * here more than in most codebases.
 *
 * Variance and standard deviation use the sample convention (divide by n-1).
 * Beta is a ratio of two of these, so the convention cancels; volatility is
 * not, and the sample form is the standard one to report.
 */

export interface Fit {
  /** Beta, when xs is the market and ys the portfolio. */
  slope: number;
  /** Alpha per period, when xs is the market and ys the portfolio. */
  intercept: number;
  /** Share of the variation in ys that xs explains, 0..1. */
  r2: number;
}

function sameLength(xs: number[], ys: number[]): void {
  if (xs.length !== ys.length) {
    throw new Error(`regression: series must be the same length (${xs.length} vs ${ys.length})`);
  }
}

export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

export function variance(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const ss = xs.reduce((sum, x) => sum + (x - m) * (x - m), 0);
  return ss / (xs.length - 1);
}

export function stdev(xs: number[]): number | null {
  const v = variance(xs);
  return v === null ? null : Math.sqrt(v);
}

export function covariance(xs: number[], ys: number[]): number | null {
  sameLength(xs, ys);
  if (xs.length < 2) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += (xs[i] - mx) * (ys[i] - my);
  return sum / (xs.length - 1);
}

/**
 * Regress `ys` on `xs`.
 *
 * `null` when there are fewer than two points, or when `xs` never moves —
 * there is no slope through a vertical line of points, and reporting 0 would
 * claim the two series are unrelated when the truth is that the question was
 * unanswerable.
 *
 * When `ys` never moves the fit is real: slope 0, and an R² of 0 saying that
 * `xs` explains none of a series that did nothing.
 */
export function fit(xs: number[], ys: number[]): Fit | null {
  sameLength(xs, ys);
  if (xs.length < 2) return null;

  const vx = variance(xs)!;
  if (vx === 0) return null;

  const cov = covariance(xs, ys)!;
  const slope = cov / vx;
  const intercept = mean(ys)! - slope * mean(xs)!;

  const vy = variance(ys)!;
  const r2 = vy === 0 ? 0 : (cov * cov) / (vx * vy);

  return { slope, intercept, r2 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/domain/regression.test.ts
```

Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add src/domain/regression.ts src/domain/regression.test.ts
git commit -m "feat(risk): least-squares regression and summary statistics" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `domain/risk.ts` — `marketExposure()`

**Files:**
- Modify: `src/domain/risk.ts`
- Modify: `src/data/priceHistory.ts:1-16` (move the shared constant)
- Test: `src/domain/risk.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/risk.test.ts`. Add `marketExposure`, `MIN_HISTORY_DAYS` and `TRADING_DAYS` to the existing import from `./risk`:

```ts
// Add to the existing import at the top of the file:
// import { concentration, marketExposure, MIN_HISTORY_DAYS, TRADING_DAYS } from "./risk";

/** A benchmark that moves enough to regress against, long enough to qualify. */
function benchmarkSeries(days: number = MIN_HISTORY_DAYS): number[] {
  // Deterministic and not a straight line: a sine keeps variance well away
  // from zero without needing a random seed.
  return Array.from({ length: days }, (_, i) => Math.sin(i) * 0.01);
}

function asset(ticker: string, value: number, returns: number[] | null) {
  return { securityId: ticker.charCodeAt(0), ticker, value, returns };
}

describe("marketExposure", () => {
  const market = benchmarkSeries();

  it("scores a portfolio that is the market as beta 1, alpha 0, R-squared 1", () => {
    const e = marketExposure({
      assets: [asset("SPX", 1000, market)], cash: 0, benchmark: market,
    });
    expect(e.beta).toBeCloseTo(1, 10);
    expect(e.alpha).toBeCloseTo(0, 10);
    expect(e.r2).toBeCloseTo(1, 10);
  });

  it("scores a twice-leveraged copy of the market as beta 2", () => {
    const e = marketExposure({
      assets: [asset("LEV", 1000, market.map((r) => r * 2))], cash: 0, benchmark: market,
    });
    expect(e.beta).toBeCloseTo(2, 10);
  });

  it("annualises a steady daily edge into alpha", () => {
    const e = marketExposure({
      assets: [asset("EDGE", 1000, market.map((r) => r + 0.0001))], cash: 0, benchmark: market,
    });
    expect(e.alpha).toBeCloseTo(0.0001 * TRADING_DAYS, 10);
    expect(e.beta).toBeCloseTo(1, 10, "an added constant shifts alpha, never beta");
  });

  it("halves beta when half the portfolio is cash", () => {
    const e = marketExposure({
      assets: [asset("SPX", 1000, market)], cash: 1000, benchmark: market,
    });
    expect(e.beta).toBeCloseTo(0.5, 10, "cash does not move with the market and dilutes exposure");
  });

  it("gives a cash-only portfolio beta 0 rather than dividing by zero", () => {
    const e = marketExposure({ assets: [], cash: 5000, benchmark: market });
    expect(e.beta).toBe(0);
    expect(e.alpha).toBe(0);
    expect(e.volatility).toBe(0);
  });

  it("refuses to report anything against a benchmark that never moved", () => {
    const flat = Array(MIN_HISTORY_DAYS).fill(0);
    const e = marketExposure({ assets: [asset("A", 1000, market)], cash: 0, benchmark: flat });
    expect(e.beta).toBeNull();
    expect(e.alpha).toBeNull();
    expect(e.r2).toBeNull();
  });

  it("suppresses every figure when the window is too short", () => {
    const short = benchmarkSeries(MIN_HISTORY_DAYS - 1);
    const e = marketExposure({ assets: [asset("A", 1000, short)], cash: 0, benchmark: short });
    expect(e.alpha).toBeNull();
    expect(e.beta).toBeNull();
    expect(e.r2).toBeNull();
    expect(e.volatility).toBeNull();
    expect(e.observations).toBe(MIN_HISTORY_DAYS - 1);
  });

  it("gives a constant portfolio series exactly zero volatility", () => {
    const e = marketExposure({
      assets: [asset("FLAT", 1000, Array(MIN_HISTORY_DAYS).fill(0))], cash: 0, benchmark: market,
    });
    expect(e.volatility).toBe(0);
  });

  it("annualises volatility by the square root of the trading year", () => {
    const wobble = Array.from({ length: MIN_HISTORY_DAYS }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const e = marketExposure({
      assets: [asset("W", 1000, wobble)], cash: 0, benchmark: market,
    });
    // stdev of an alternating +/-1% series is ~0.01 (sample, n-1).
    expect(e.volatility!).toBeCloseTo(0.01 * Math.sqrt(TRADING_DAYS), 2);
  });

  it("leaves out an asset with no returns and says how many it left out", () => {
    const e = marketExposure({
      assets: [asset("SPX", 1000, market), asset("SWVXX", 1000, null)],
      cash: 0, benchmark: market,
    });
    expect(e.excludedTickers).toEqual(["SWVXX"]);
    expect(e.includedCount).toBe(1);
    expect(e.beta).toBeCloseTo(1, 10, "the remaining weight is renormalised, not diluted by a stub");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/domain/risk.test.ts
```

Expected: FAIL — `marketExposure is not a function` / `MIN_HISTORY_DAYS is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/domain/risk.ts`, and add this import at the top of the file below the existing `import type { Holding }` line:

```ts
import { fit, stdev } from "./regression";
```

Then append:

```ts
/**
 * Trading days in a year. Daily figures are multiplied by this (for a mean,
 * like alpha) or by its square root (for a deviation, like volatility) to get
 * the annual figures people actually quote.
 */
export const TRADING_DAYS = 252;

/**
 * How many daily observations a figure needs before it is worth reporting.
 * Roughly a quarter of a trading decade; below this, beta and volatility are
 * noise wearing a number's clothes.
 *
 * This lives here rather than in the data layer because it is a statement
 * about the maths, not about downloading. `data/priceHistory.ts` re-exports it
 * so there is one threshold in the codebase and not two.
 */
export const MIN_HISTORY_DAYS = 200;

/** One thing the portfolio holds, with its own daily return series. */
export interface ExposureAsset {
  securityId: number;
  ticker: string;
  /** Market value today, in dollars. */
  value: number;
  /** Daily returns aligned to the benchmark, or null when there are none. */
  returns: number[] | null;
}

export interface ExposureInputs {
  assets: ExposureAsset[];
  /** Cash, which enters the series at a return of 0. */
  cash: number;
  /** The benchmark's daily returns. */
  benchmark: number[];
}

export interface MarketExposure {
  /** Jensen's alpha, annualised. Null when it cannot be computed honestly. */
  alpha: number | null;
  /** Sensitivity to the benchmark. 1.0 is "moves with the market". */
  beta: number | null;
  /** Share of the portfolio's movement the benchmark explains, 0..1. */
  r2: number | null;
  /** Annualised standard deviation of the portfolio's daily returns. */
  volatility: number | null;
  /** Daily observations the figures rest on. */
  observations: number;
  /** Assets that made it into the maths. */
  includedCount: number;
  /** Assets left out for want of history, named so the UI can say so. */
  excludedTickers: string[];
}

/**
 * Market exposure: how much of the portfolio's behaviour is the market, and
 * what is left over once that is accounted for.
 *
 * The portfolio's return series is today's weights applied to each asset's
 * historical returns — the app cannot know what was held two years ago, so
 * this answers "how would what I hold now have behaved", and the UI must say
 * so. Weighting and *then* regressing also captures the correlation between
 * holdings for free; averaging each holding's own beta would ignore it and
 * overstate risk.
 *
 * The risk-free rate is treated as zero. Textbook Jensen's alpha subtracts it
 * from both sides; the app has no rate source, and at daily granularity the
 * omission moves annualised alpha by well under a point. Deliberate, not an
 * oversight — see the spec.
 *
 * Cash enters at a return of 0 and so dilutes exposure, which is correct.
 * Assets with no usable history are dropped and named: the remaining weights
 * are renormalised over what is left, because silently treating an unknown
 * holding as cash-like would understate exposure.
 */
export function marketExposure(i: ExposureInputs): MarketExposure {
  const usable = i.assets.filter(
    (a) => a.returns !== null && a.returns.length === i.benchmark.length && a.value > 0,
  );
  const excludedTickers = i.assets
    .filter((a) => !usable.includes(a))
    .map((a) => a.ticker);

  const cash = Math.max(i.cash, 0);
  const base = usable.reduce((sum, a) => sum + a.value, 0) + cash;

  const observations = i.benchmark.length;
  const nothing: MarketExposure = {
    alpha: null, beta: null, r2: null, volatility: null,
    observations, includedCount: usable.length, excludedTickers,
  };

  if (observations < MIN_HISTORY_DAYS || base <= 0) return nothing;

  // Cash contributes a return of 0 on every day, so it never appears in the
  // sum — it only enlarges `base`, which is exactly how it dilutes.
  const portfolio = Array.from({ length: observations }, (_, t) =>
    usable.reduce((sum, a) => sum + (a.value / base) * a.returns![t], 0),
  );

  const sd = stdev(portfolio);
  const annualVol = sd === null ? null : sd * Math.sqrt(TRADING_DAYS);

  // Volatility does not depend on the benchmark, so a broken benchmark takes
  // alpha, beta and R-squared with it but leaves volatility standing.
  const f = fit(i.benchmark, portfolio);
  if (f === null) return { ...nothing, volatility: annualVol };

  return {
    alpha: f.intercept * TRADING_DAYS,
    beta: f.slope,
    r2: f.r2,
    volatility: annualVol,
    observations,
    includedCount: usable.length,
    excludedTickers,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/domain/risk.test.ts
```

Expected: all `concentration` tests still pass plus 11 new `marketExposure` tests.

If `refuses to report anything against a benchmark that never moved` fails on `volatility`, note the test only asserts `beta`, `alpha` and `r2` are null — volatility is still real when the benchmark is broken, because it does not depend on the benchmark. That is deliberate.

- [ ] **Step 5: Point the data layer at the shared constant**

Replace lines 1–16 of `src/data/priceHistory.ts` (the import, the `MIN_HISTORY_DAYS` doc comment and its `export const`) with:

```ts
import { useEffect, useRef } from "react";
import { useBackfillPrices, usePriceHistoryDepth } from "./queries";
import { MIN_HISTORY_DAYS } from "../domain/risk";

/**
 * Re-exported so callers in the data layer keep their import, while the
 * threshold itself is defined once, in the maths that depends on it.
 */
export { MIN_HISTORY_DAYS };

/**
 * Whether to download price history. `undefined` means the depth query has not
 * answered yet; backfilling then would re-download on every launch.
 */
export function shouldBackfill(depth: number | undefined): boolean {
  if (depth === undefined) return false;
  return depth < MIN_HISTORY_DAYS;
}
```

- [ ] **Step 6: Run the whole suite to confirm nothing else moved**

```bash
npm test
```

Expected: all tests pass, including the existing `src/data/priceHistory.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/risk.ts src/domain/risk.test.ts src/data/priceHistory.ts
git commit -m "feat(risk): Jensen's alpha, beta, R-squared and volatility" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: `domain/returns.ts` — align history onto the benchmark calendar

**Files:**
- Create: `src/domain/returns.ts`
- Test: `src/domain/returns.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/returns.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { alignedReturns } from "./returns";
import type { Holding } from "./types";

function holding(ticker: string, security_id: number, marketValue: number): Holding {
  return {
    security_id, ticker, type: "etf",
    shares: 1, avgCost: marketValue, costBasis: marketValue,
    lastPrice: marketValue, marketValue,
    unrealized: 0, unrealizedPct: 0, realized: 0,
  };
}

function day(n: number): string {
  const d = new Date(Date.UTC(2025, 0, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** `days` closes that rise 1% a day from 100. */
function closes(days: number, securityId: number) {
  return Array.from({ length: days }, (_, i) => ({
    security_id: securityId, date: day(i), close: 100 * Math.pow(1.01, i),
  }));
}

const LONG = 260;

describe("alignedReturns", () => {
  it("turns closes into simple daily returns, one fewer than the closes", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: closes(LONG, 1),
      benchmark: closes(LONG, 0).map(({ date, close }) => ({ date, close })),
      minObservations: 10,
    });

    expect(a.dates).toHaveLength(LONG - 1);
    expect(a.benchmark).toHaveLength(LONG - 1);
    expect(a.assets[0].returns[0]).toBeCloseTo(0.01, 12);
  });

  it("drops a date the benchmark did not trade on", () => {
    const bench = closes(LONG, 0)
      .filter((_, i) => i !== 5)
      .map(({ date, close }) => ({ date, close }));

    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: closes(LONG, 1),
      benchmark: bench,
      minObservations: 10,
    });

    expect(a.dates).not.toContain(day(5));
    expect(a.dates).toHaveLength(bench.length - 1);
  });

  it("drops a date a holding is missing rather than carrying the last close forward", () => {
    const gappy = closes(LONG, 1).filter((_, i) => i !== 7);

    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: gappy,
      benchmark: closes(LONG, 0).map(({ date, close }) => ({ date, close })),
      minObservations: 10,
    });

    expect(a.dates).not.toContain(day(7));
    // Forward-filling would have produced a 0% day; the return across the gap
    // must be the real two-day move instead.
    const i = a.dates.indexOf(day(8));
    expect(a.assets[0].returns[i]).toBeCloseTo(Math.pow(1.01, 2) - 1, 12);
  });

  it("passes a holding with no price rows through with null returns, and says why", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1000), holding("SWVXX", 2, 500)],
      prices: closes(LONG, 1),
      benchmark: closes(LONG, 0).map(({ date, close }) => ({ date, close })),
      minObservations: 10,
    });

    // Every holding comes through. `marketExposure` owns the decision to drop
    // one, so it can also report how much of the portfolio went with it.
    expect(a.assets.map((x) => x.ticker)).toEqual(["A", "SWVXX"]);
    expect(a.assets.find((x) => x.ticker === "SWVXX")!.returns).toBeNull();
    expect(a.assets.find((x) => x.ticker === "SWVXX")!.value).toBe(500);
    expect(a.excluded).toEqual([{ ticker: "SWVXX", reason: "no history" }]);
  });

  it("excludes a holding too new to measure rather than shortening everyone's window", () => {
    const newcomer = closes(LONG, 2).slice(-20).map((p) => ({ ...p, security_id: 2 }));

    const a = alignedReturns({
      holdings: [holding("A", 1, 1000), holding("NEW", 2, 500)],
      prices: [...closes(LONG, 1), ...newcomer],
      benchmark: closes(LONG, 0).map(({ date, close }) => ({ date, close })),
      minObservations: 200,
    });

    expect(a.excluded).toEqual([{ ticker: "NEW", reason: "short history" }]);
    expect(a.assets.find((x) => x.ticker === "NEW")!.returns).toBeNull();
    expect(a.dates.length).toBeGreaterThan(200);
  });

  it("carries each holding's market value through for weighting", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1234)],
      prices: closes(LONG, 1),
      benchmark: closes(LONG, 0).map(({ date, close }) => ({ date, close })),
      minObservations: 10,
    });
    expect(a.assets[0].value).toBe(1234);
    expect(a.assets[0].securityId).toBe(1);
  });

  it("returns an empty alignment when there is no benchmark at all", () => {
    const a = alignedReturns({
      holdings: [holding("A", 1, 1000)],
      prices: closes(LONG, 1),
      benchmark: [],
      minObservations: 10,
    });
    expect(a.dates).toEqual([]);
    expect(a.benchmark).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/domain/returns.test.ts
```

Expected: FAIL — `Failed to resolve import "./returns"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/returns.ts`:

```ts
import type { Holding } from "./types";
import { MIN_HISTORY_DAYS, type ExposureAsset } from "./risk";

/**
 * Turning stored closes into the aligned daily return series the risk maths
 * needs. Pure and I/O-free; `data/useRiskSeries.ts` is the thin hook that
 * feeds it rows from SQLite.
 *
 * The awkward part is the calendar. Holdings, funds and the index do not all
 * trade on exactly the same days, and a missing close is never filled in from
 * the day before: a repeated close reads as a 0% day, and enough of those
 * flatten volatility and drag beta toward zero. Dates that are not complete
 * across the benchmark and every included holding are dropped instead.
 */

export interface PriceRow { security_id: number; date: string; close: number; }
export interface BenchmarkRow { date: string; close: number; }

export type ExclusionReason = "no history" | "short history";
export interface Exclusion { ticker: string; reason: ExclusionReason; }

export interface AlignInputs {
  holdings: Holding[];
  prices: PriceRow[];
  benchmark: BenchmarkRow[];
  /** Overridable so tests need not build 200 days of fixtures. */
  minObservations?: number;
}

export interface Aligned {
  /** The common trading calendar, oldest first, one entry per return. */
  dates: string[];
  /** The benchmark's daily returns over `dates`. */
  benchmark: number[];
  /**
   * Every holding, ready to hand to `marketExposure` — measurable ones with
   * their aligned returns, the rest with `returns: null`.
   *
   * The unmeasurable ones are deliberately passed through rather than dropped
   * here. `marketExposure` has to make the exclusion decision anyway, and
   * keeping it in one place is what lets it also report how much of the
   * portfolio's value was excluded. Dropping them here would leave that
   * function reporting full coverage of a portfolio it had only seen part of.
   */
  assets: ExposureAsset[];
  /** Why each unmeasurable holding was unmeasurable. */
  excluded: Exclusion[];
}

function toReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

export function alignedReturns(i: AlignInputs): Aligned {
  const min = i.minObservations ?? MIN_HISTORY_DAYS;
  const empty: Aligned = { dates: [], benchmark: [], assets: [], excluded: [] };

  const benchByDate = new Map(i.benchmark.map((b) => [b.date, b.close]));
  const benchDates = [...benchByDate.keys()].sort();
  if (benchDates.length < 2) return empty;

  const bySecurity = new Map<number, Map<string, number>>();
  for (const p of i.prices) {
    let m = bySecurity.get(p.security_id);
    if (!m) { m = new Map(); bySecurity.set(p.security_id, m); }
    m.set(p.date, p.close);
  }

  // A holding is measured only if its own history covers enough of the
  // benchmark's calendar. Including a three-month-old position would collapse
  // the common window to three months for every other holding too.
  const included: { holding: Holding; closes: Map<string, number> }[] = [];
  const excluded: Exclusion[] = [];

  for (const h of i.holdings) {
    const closes = bySecurity.get(h.security_id);
    const covered = closes ? benchDates.filter((d) => closes.has(d)).length : 0;
    if (!closes || covered === 0) {
      excluded.push({ ticker: h.ticker, reason: "no history" });
    } else if (covered < min + 1) {
      excluded.push({ ticker: h.ticker, reason: "short history" });
    } else {
      included.push({ holding: h, closes });
    }
  }

  const dates = benchDates.filter((d) => included.every(({ closes }) => closes.has(d)));
  if (dates.length < 2) return { ...empty, excluded };

  const measured = new Map(
    included.map(({ holding, closes }) => [
      holding.security_id,
      toReturns(dates.map((d) => closes.get(d)!)),
    ]),
  );

  return {
    dates: dates.slice(1),
    benchmark: toReturns(dates.map((d) => benchByDate.get(d)!)),
    // Every holding, measurable or not — see the note on `Aligned.assets`.
    assets: i.holdings.map((h) => ({
      securityId: h.security_id,
      ticker: h.ticker,
      value: h.marketValue,
      returns: measured.get(h.security_id) ?? null,
    })),
    excluded,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/domain/returns.test.ts
```

Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/domain/returns.ts src/domain/returns.test.ts
git commit -m "feat(risk): align holding history onto the benchmark calendar" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Frontend access to the benchmark

**Files:**
- Modify: `src/data/api.ts:48-54`
- Modify: `src/data/queries.ts:5-19` and `:224-240`

- [ ] **Step 1: Add the API calls**

In `src/data/api.ts`, inside the `market: { ... }` object, after the `refresh:` line, add:

```ts
    indexHistory: () => invoke<[string, number][]>("market_index_history"),
    indexDepth: () => invoke<number>("market_index_depth"),
    indexBackfill: () => invoke<number>("market_index_backfill"),
```

- [ ] **Step 2: Add the query keys**

In `src/data/queries.ts`, inside the `keys` object after `marketIndices`, add:

```ts
  indexHistory: ["market", "indexHistory"] as const,
  indexDepth: ["market", "indexDepth"] as const,
```

- [ ] **Step 3: Add the hooks**

In `src/data/queries.ts`, after `useMarketIndices`, add:

```ts
export const useIndexHistory = () =>
  useQuery({ queryKey: keys.indexHistory, queryFn: api.market.indexHistory });

export const useIndexDepth = () =>
  useQuery({ queryKey: keys.indexDepth, queryFn: api.market.indexDepth });

/** The benchmark's two-year backfill. Run once, not on the refresh timer. */
export function useBackfillIndices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.market.indexBackfill(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.indexDepth });
      qc.invalidateQueries({ queryKey: keys.indexHistory });
      qc.invalidateQueries({ queryKey: keys.marketIndices });
    },
  });
}
```

- [ ] **Step 4: Trigger the benchmark backfill alongside the price backfill**

In `src/data/priceHistory.ts`, replace the whole `usePriceHistory` function with:

```ts
/**
 * Fill in price history once, when the database does not already have it.
 * Two years of daily closes is one request per security plus one for the
 * benchmark — the same cost as an ordinary refresh — so this must not run on
 * the polling timer.
 */
export function usePriceHistory() {
  const { data: depth } = usePriceHistoryDepth();
  const { data: indexDepth } = useIndexDepth();
  const backfill = useBackfillPrices();
  const backfillIndices = useBackfillIndices();
  const started = useRef(false);
  const startedIndices = useRef(false);

  useEffect(() => {
    if (started.current || !shouldBackfill(depth)) return;
    started.current = true;
    // Offline or rate-limited is not fatal: the risk card says what is missing.
    backfill.mutateAsync().catch(() => {});
    // backfill.mutateAsync is stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depth]);

  useEffect(() => {
    if (startedIndices.current || !shouldBackfill(indexDepth)) return;
    startedIndices.current = true;
    backfillIndices.mutateAsync().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexDepth]);
}
```

And extend the import on line 2 of that file to:

```ts
import {
  useBackfillPrices, usePriceHistoryDepth, useIndexDepth, useBackfillIndices,
} from "./queries";
```

- [ ] **Step 5: Verify the project type-checks and the suite still passes**

```bash
npx tsc --noEmit && npm test
```

Expected: no type errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/data/api.ts src/data/queries.ts src/data/priceHistory.ts
git commit -m "feat(risk): fetch and backfill benchmark history from the frontend" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: `data/useRiskSeries.ts` — the hook

A thin wrapper, mirroring `useValueSeries.ts`. No logic worth unit-testing lives here; the logic is in Task 5.

**Files:**
- Create: `src/data/useRiskSeries.ts`

- [ ] **Step 1: Write the hook**

Create `src/data/useRiskSeries.ts`:

```ts
import { useMemo } from "react";
import { usePriceHistoryRows, useIndexHistory } from "./queries";
import { alignedReturns, type PriceRow, type Aligned } from "../domain/returns";
import type { Holding } from "../domain/types";

/**
 * How far back the risk figures reach. Two years, matching the `HISTORY_RANGE`
 * the Rust side backfills — long enough for beta to settle down, short enough
 * that it still describes roughly the portfolio you have.
 */
export const RISK_YEARS = 2;

function isoYearsAgo(years: number, now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * The aligned daily return series the risk maths runs on: every holding's
 * history and the benchmark's, on one shared calendar.
 *
 * A thin wrapper on purpose. The alignment rules — which dates survive, which
 * holdings are excluded and why — live in `domain/returns.ts` where they can
 * be unit-tested, exactly as `useValueSeries` wraps `reconstructSeries`.
 */
export function useRiskSeries(holdings: Holding[]): { aligned: Aligned; isLoading: boolean } {
  const from = isoYearsAgo(RISK_YEARS);

  const { data: rows = [], isLoading: l1 } = usePriceHistoryRows(from);
  const { data: index = [], isLoading: l2 } = useIndexHistory();

  const aligned = useMemo(() => {
    const prices: PriceRow[] = rows.map(([security_id, date, close]) => ({ security_id, date, close }));
    const benchmark = index
      .map(([date, close]) => ({ date, close }))
      .filter((b) => b.date >= from);
    return alignedReturns({ holdings, prices, benchmark });
  }, [holdings, rows, index, from]);

  return { aligned, isLoading: l1 || l2 };
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors. An error on `Aligned` not being exported means Task 5's `export interface Aligned` was missed.

- [ ] **Step 3: Commit**

```bash
git add src/data/useRiskSeries.ts
git commit -m "feat(risk): hook feeding stored history to the alignment" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: `MarketExposureCard`

**Files:**
- Create: `src/features/dashboard/MarketExposureCard.tsx`
- Test: `src/features/dashboard/MarketExposureCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/features/dashboard/MarketExposureCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MarketExposureCard } from "./MarketExposureCard";
import type { MarketExposure } from "../../domain/risk";

function exposure(over: Partial<MarketExposure> = {}): MarketExposure {
  return {
    alpha: 0.031, beta: 1.15, r2: 0.88, volatility: 0.19,
    observations: 480, includedCount: 8, excludedTickers: [],
    includedValueShare: 1,
    ...over,
  };
}

describe("MarketExposureCard", () => {
  it("leads with alpha and says what it means in words", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText("+3.1%")).toBeInTheDocument();
    expect(screen.getByText(/market exposure explains/i)).toBeInTheDocument();
  });

  it("shows beta next to alpha, because alpha alone is misleading", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText("1.15")).toBeInTheDocument();
  });

  it("shows R-squared and volatility as supporting figures", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText("88.0%")).toBeInTheDocument();
    expect(screen.getByText("19.0%")).toBeInTheDocument();
  });

  it("says the figures assume today's holdings, every time", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.getByText(/hold today/i)).toBeInTheDocument();
    expect(screen.getByText(/not a forecast/i)).toBeInTheDocument();
  });

  it("names the holdings it could not measure", () => {
    render(
      <MarketExposureCard
        exposure={exposure({ excludedTickers: ["SWVXX", "FDRXX"], includedValueShare: 0.82 })}
        isLoading={false}
      />,
    );
    expect(screen.getByText(/SWVXX, FDRXX/)).toBeInTheDocument();
  });

  it("says how much of the portfolio the figures cover when some was unmeasurable", () => {
    // A confident beta computed over 40% of someone's money reads exactly like
    // one computed over all of it. This line is what tells them apart.
    render(
      <MarketExposureCard
        exposure={exposure({ excludedTickers: ["SWVXX"], includedValueShare: 0.4 })}
        isLoading={false}
      />,
    );
    expect(screen.getByText(/40.0% of your portfolio/i)).toBeInTheDocument();
  });

  it("does not clutter the card with a coverage note when it measured everything", () => {
    render(<MarketExposureCard exposure={exposure()} isLoading={false} />);
    expect(screen.queryByText(/of your portfolio/i)).not.toBeInTheDocument();
  });

  it("says what is missing instead of showing zeros when there is not enough history", () => {
    render(
      <MarketExposureCard
        exposure={exposure({ alpha: null, beta: null, r2: null, volatility: null, observations: 40 })}
        isLoading={false}
      />,
    );
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
    expect(screen.getByText(/Not enough price history/i)).toBeInTheDocument();
    expect(screen.getByText(/40 days/)).toBeInTheDocument();
  });

  it("shows a negative alpha as a loss against the market, not a gain", () => {
    render(<MarketExposureCard exposure={exposure({ alpha: -0.042 })} isLoading={false} />);
    expect(screen.getByText("-4.2%")).toBeInTheDocument();
    expect(screen.getByText(/less than its market exposure explains/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test -- src/features/dashboard/MarketExposureCard.test.tsx
```

Expected: FAIL — `Failed to resolve import "./MarketExposureCard"`.

- [ ] **Step 3: Write the component**

Create `src/features/dashboard/MarketExposureCard.tsx`:

```tsx
import { pct, share } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import type { MarketExposure } from "../../domain/risk";

/**
 * Market exposure: how much of the portfolio is just the market, and what is
 * left over once that is paid for.
 *
 * Like the concentration card, this describes and never advises. It also
 * carries a caveat the other cards do not need: the figures apply today's
 * holdings to two years of history, because the app cannot know what was held
 * two years ago. That is stated on the card, not buried — it is the difference
 * between a useful statistic and a misunderstanding.
 */
export function MarketExposureCard(
  { exposure, isLoading }: { exposure: MarketExposure; isLoading: boolean },
) {
  const { alpha, beta, r2, volatility, observations, excludedTickers, includedValueShare } = exposure;

  if (isLoading) {
    return <Card title="Versus the S&P 500"><p className="muted">Loading…</p></Card>;
  }

  if (alpha == null || beta == null || r2 == null) {
    return (
      <Card title="Versus the S&P 500">
        <EmptyState
          title="Not enough price history yet"
          body={`These figures need about a year of daily closes shared by every holding and the index. There ${observations === 1 ? "is" : "are"} ${observations} days so far — they fill in as prices are downloaded.`}
        />
      </Card>
    );
  }

  const ahead = alpha >= 0;

  return (
    <Card
      title="Versus the S&P 500"
      subtitle={`${observations} trading days of shared history`}
    >
      <div className="stat-row">
        <div className="stat">
          <div className="stat-label">Alpha (per year)</div>
          <div className={`stat-value ${ahead ? "pos" : "neg"}`}>{pct(alpha * 100)}</div>
          <div className="cell-secondary">after adjusting for risk</div>
        </div>
        <div className="stat">
          <div className="stat-label">Beta</div>
          <div className="stat-value">{beta.toFixed(2)}</div>
          <div className="cell-secondary">vs the index at 1.00</div>
        </div>
        <div className="stat">
          <div className="stat-label">Explained by the market</div>
          <div className="stat-value">{share(r2)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Volatility (per year)</div>
          <div className="stat-value">{volatility == null ? "—" : share(volatility)}</div>
        </div>
      </div>

      <p className="muted">
        Your portfolio returned {share(Math.abs(alpha))} a year{" "}
        {ahead ? "more" : "less"} than its market exposure explains. It has moved{" "}
        {beta.toFixed(2)}× the index, so {beta >= 1 ? "more" : "less"} of its
        swing is the market's than the market's own.
      </p>

      {excludedTickers.length > 0 && (
        <p className="muted">
          {excludedTickers.length} holding{excludedTickers.length === 1 ? "" : "s"} left out
          for want of price history: {excludedTickers.join(", ")}. The figures above cover{" "}
          {share(includedValueShare)} of your portfolio.
        </p>
      )}

      <p className="muted" style={{ marginBottom: 0 }}>
        Measured by applying the holdings you hold today to the last two years of
        prices — not a record of what the account actually did, and not a forecast.
      </p>
    </Card>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- src/features/dashboard/MarketExposureCard.test.tsx
```

Expected: 7 passed.

If `leads with alpha` fails on `"+3.1%"`, check `pct` in `src/ui/format.ts` — it takes a number already in percentage points and formats to one decimal, which is why the component passes `alpha * 100`.

- [ ] **Step 5: Commit**

```bash
git add src/features/dashboard/MarketExposureCard.tsx src/features/dashboard/MarketExposureCard.test.tsx
git commit -m "feat(risk): market exposure card" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Mount the card on the dashboard

**Files:**
- Modify: `src/features/dashboard/Dashboard.tsx:1-15` (imports), `:43-44` (hooks), `:160` (render)

- [ ] **Step 1: Add the imports**

In `src/features/dashboard/Dashboard.tsx`, below the existing `import { RiskCard } from "./RiskCard";` line, add:

```tsx
import { MarketExposureCard } from "./MarketExposureCard";
import { useRiskSeries } from "../../data/useRiskSeries";
import { marketExposure } from "../../domain/risk";
```

- [ ] **Step 2: Compute the exposure**

In the `Dashboard` component, immediately after the line `const { series: fullSeries } = useValueSeries();`, add:

```tsx
  const { aligned, isLoading: riskLoading } = useRiskSeries(holdings);
  const exposure = marketExposure({
    assets: aligned.assets,
    cash: summary.cash,
    benchmark: aligned.benchmark,
  });
```

No merging of excluded tickers is needed. `alignedReturns` passes every holding through — unmeasurable ones carry `returns: null` — so `marketExposure` sees the whole portfolio and is the single place that decides what to exclude, names it, and reports the share of value covered.

`summary.cash` is the right thing to pass, and `summary.liabilities` deliberately is not: credit-card debt carries no market exposure, and netting it off would make borrowing look like it reduced risk.

- [ ] **Step 3: Render the card**

Immediately after the existing `<RiskCard holdings={holdings} cash={summary.cash} />` line, add:

```tsx
      <MarketExposureCard exposure={exposure} isLoading={riskLoading} />
```

- [ ] **Step 4: Verify the project type-checks and the full suite passes**

```bash
npx tsc --noEmit && npm test
```

Expected: no type errors; every test in the repository passes.

- [ ] **Step 5: Run the app and look at the card**

```bash
npm run tauri dev
```

Expected on the dashboard, below Concentration: a "Versus the S&P 500" card. On a fresh database it shows the empty state and fills in once the backfill finishes — give it a minute and reload. Check that Holdings and the allocation chart still show only what is actually owned, with no S&P row anywhere.

- [ ] **Step 6: Commit**

```bash
git add src/features/dashboard/Dashboard.tsx
git commit -m "feat(risk): show market exposure on the dashboard" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Update the handoff

**Files:**
- Modify: `docs/HANDOFF.md` (the "Remaining work" section, item 5)

- [ ] **Step 1: Rewrite item 5**

Replace item 5 of "Remaining work" with:

```markdown
5. **Risk analytics phases 3-4** — downside (max drawdown, historical VaR/CVaR)
   and diversification (correlation matrix, ETF-overlap detection). Phase 0
   (price history), Phase 1 (concentration) and Phase 2 (alpha, beta, R² and
   volatility versus `^GSPC`) are done. Specs:
   `docs/superpowers/specs/2026-09-08-risk-analytics-design.md` and
   `docs/superpowers/specs/2026-09-11-alpha-vs-benchmark-design.md`
```

- [ ] **Step 2: Note the benchmark in the reference documents list**

Append to the "Reference documents" section:

```markdown
- **Benchmark data:** the S&P 500 lives in `index_quotes` as `^GSPC`, never in
  `securities` — see the header comment in `src-tauri/src/market/indices.rs`.
  Two years of closes are backfilled once by `market_index_backfill`; the
  60-second market refresh keeps only the last few days current.
```

- [ ] **Step 3: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: handoff for alpha versus the S&P" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full TypeScript suite**

```bash
npm test
```

Expected: every test passes, including the pre-existing ones.

- [ ] **Full Rust suite**

```bash
cd src-tauri && cargo test
```

Expected: every test passes.

- [ ] **Type check**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **The benchmark is not a holding**

```bash
cd src-tauri && cargo test --lib storing_index_closes_never_creates_a_security a_backfill_does_not_create_a_security
```

Expected: 2 passed. This is the test that matters most: it is the one that stops the S&P quietly appearing in someone's net worth.
