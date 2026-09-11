# Alpha versus the S&P — design

**Date:** 2026-09-11
**Status:** approved for implementation
**Branch:** `alphaCalc`
**Supersedes, in part:** the benchmark section of
`docs/superpowers/specs/2026-09-08-risk-analytics-design.md` (see
"Departures from the earlier spec" below)

## What this is for

The concentration card says how few things the portfolio rides on. It says
nothing about whether owning those things has been *worth it*. This module adds
the second half of the risk picture: how much market exposure the portfolio
carries, and how much of its return that exposure fails to explain.

The question to answer is:

> **Am I actually ahead of the S&P, or am I just taking more risk than it?**

A portfolio of 1.4×-beta technology stocks beats the index in any rising
market. That is not skill, it is leverage on the same bet. Jensen's alpha is
the number that separates the two, which is why it is the one this module
computes.

## Design principle: describe, do not advise

Inherited unchanged from the risk analytics spec. Every figure here is a
**descriptive statistic about data already owned**. The module never says what
to buy, sell or hold, and never implies a forecast. Phrasing is "your portfolio
returned 3.1%/yr more than its market exposure explains", never "your stock
picking is working, keep going".

Every figure is also backward-looking and noisy. The card says so plainly,
once, where it can be read — not in a footnote.

## Scope

Phase 2 of the risk analytics spec, in full:

- **Jensen's alpha**, annualised — the headline.
- **Beta** against the S&P 500 — required context; alpha is meaningless
  without it.
- **R²** — how much of the portfolio's movement the market explains.
- **Annualised volatility** of the portfolio series.

Beta and R² fall out of the same regression as alpha at no extra cost.
Volatility is a few lines from the same return series. Splitting them across
branches would mean assembling the return series twice.

Out of scope: max drawdown, VaR/CVaR (Phase 3), correlation matrix and ETF
overlap detection (Phase 4), configurable benchmark, sector exposure.

## The benchmark: `^GSPC` through `index_quotes`

`index_quotes` already exists, keyed `(symbol, date)` with a `close`, and
already holds `^GSPC`. `market/indices.rs` states the reasoning in its own
header comment:

> These deliberately do not go in `securities`: the S&P would then appear in
> Holdings and in the allocation chart as though it were owned.

The table holds only five days of history because `fetch_closes` requests
`RECENT_RANGE`. The fix is to fetch `HISTORY_RANGE` ("2y", already defined in
`prices/yahoo.rs`) on a backfill, keeping the 5-day range for the ordinary
refresh so the polling timer does not rewrite two years of rows every minute.

**No schema change. No new parsing.** `upsert_index_closes` already stores
every row it is handed and `parse_chart_json` already returns every
`(date, close)` pair.

### Departures from the earlier spec

The 2026-09-08 spec recommended inserting `SPY` as an ordinary row in
`securities` so that `refresh_all` would fetch it for free. That was written
before `index_quotes` existed. It is rejected here: it puts a security nobody
owns into the table that everything else derives holdings from, and relies on a
test to catch the leak rather than making the leak impossible. `index_quotes`
makes it structurally impossible.

The earlier spec also proposed 60 observations as the minimum window. This
design uses the 200 already defined as `MIN_HISTORY_DAYS` in
`data/priceHistory.ts` — one threshold in the codebase, not two.

## The portfolio return series

`r_p[t] = Σ wᵢ · rᵢ[t]`, where `wᵢ` are **today's** weights and `rᵢ[t]` is each
holding's daily return from its own price history.

This is a constraint, not a preference. `domain/history.ts` reconstructs actual
portfolio value only 90 days back, and says why in its own comment: SimpleFIN
reports the holdings held *right now* and carries no holdings history, so
"over two years it would be fiction". Two years of genuine account history does
not exist and cannot be manufactured.

So the honest question the card answers is:

> How would the portfolio I hold **today** have behaved over the last two years?

Not "how did my account actually do". **The card must say this in plain
words** — it is the difference between a useful statistic and a
misunderstanding.

Applying weights to holding returns and regressing the result is also the
correct construction on its own merits: it captures the correlation between
holdings for free, whereas averaging each holding's individual beta or
volatility ignores correlation and overstates risk.

Cash enters the series at return 0. It genuinely does not move with the market,
and excluding it would overstate exposure.

## Architecture

Unchanged seams. Pure maths in the domain layer, no React and no I/O; the hook
assembles inputs; the card renders.

```
index_quotes (^GSPC, 2y)  ─┐
prices (per security, 2y) ─┼→ data/useRiskSeries.ts  →  aligned daily returns
holdings + cash (today)   ─┘                                    ↓
                                          domain/regression.ts  (pure statistics)
                                          domain/risk.ts        (alpha/beta/vol/R²)
                                                    ↓
                                     features/dashboard/MarketExposureCard.tsx
```

### New units

| Unit | Purpose | Depends on |
|---|---|---|
| `domain/regression.ts` | mean, variance, covariance, OLS slope and intercept, R². Knows nothing about finance. | nothing |
| `domain/risk.ts` (extended) | `marketExposure()` — turns aligned return series into alpha, beta, R², volatility. Knows nothing about React or SQLite. | `regression.ts` |
| `data/useRiskSeries.ts` | Reads price history and index quotes, aligns them on the benchmark calendar, returns per-holding return series plus the benchmark's. | `queries.ts` |
| `features/dashboard/MarketExposureCard.tsx` | Renders the four figures and the caveats. | `risk.ts` |

`regression.ts` is separate so that `risk.ts` does not grow a statistics library
inside itself; the statistics are testable against textbook answers with no
finance vocabulary in the way.

### Backend change

`market/indices.rs` gains a backfill path requesting `HISTORY_RANGE`, exposed as
a Tauri command alongside `prices_backfill`, and run from the same first-launch
path in `data/priceHistory.ts` that already backfills security prices.

## The maths

```
r_p[t]   = Σ wᵢ · rᵢ[t]        cash included at return 0
β        = cov(r_p, r_m) / var(r_m)
α_daily  = mean(r_p) − β · mean(r_m)
α_annual = α_daily × 252
R²       = corr(r_p, r_m)²
vol      = stdev(r_p) × √252
```

Returns are simple daily returns, `close[t] / close[t−1] − 1`, computed on the
aligned calendar.

**Risk-free rate is treated as zero.** Textbook Jensen's alpha subtracts it from
both sides. The app has no rate source, adding one means another network
dependency and another politeness budget, and at daily granularity the omission
shifts annualised alpha by well under a percentage point. This is a deliberate
simplification, recorded here so it is not later mistaken for a bug.

## Honesty rules

Every function returns `null` — never `0`, never `NaN` — when it cannot answer
honestly. This is the rule already stated at the top of `risk.ts` and it
matters more here than anywhere else in the app.

- **Fewer than `MIN_HISTORY_DAYS` (200) aligned observations** → every metric
  suppressed. The card says how many days it has instead of showing a number.
- **Flat benchmark** (`var(r_m) == 0`) → beta undefined, and therefore alpha
  undefined. Not 0.
- **Cash-only portfolio** → beta 0 and alpha 0, arrived at deliberately rather
  than by dividing by zero.
- **Holdings with no usable price history** — money-market funds, some mutual
  funds, anything Yahoo does not know — are excluded from the regression,
  remaining weights are renormalised over what is left, and the card states the
  exclusion: *"3 of 11 holdings excluded: no price history"*. Silently dropping
  them would misstate exposure.
- **Calendar alignment.** Every series is aligned on the benchmark's trading
  dates. A date missing a price for any included holding is dropped, never
  forward-filled: forward-filling repeats a close, produces a false zero return,
  and depresses volatility.
- **Credit-card debt is not netted off** before the regression. Debt does not
  reduce market exposure, it leverages it; netting would make borrowing look
  like risk reduction.
- **Hidden accounts** are excluded automatically, because the card reads from
  `derivePortfolio()` like everything else.

## The card

`MarketExposureCard`, on the dashboard below the concentration card.

- **Alpha (annualised)** as the headline figure, with the plain-English gloss:
  "returned X%/yr more (or less) than its market exposure explains".
- **Beta**, immediately beside it — alpha without beta is misleading.
- **R²** and **annualised volatility** as supporting figures.
- **A caveat line, always visible:** the window length, that the figures assume
  today's holdings throughout, and that past behaviour is not a forecast.
- **An empty state** when there is not enough history, saying what is missing
  rather than showing zeros.

## Testing

TDD. The domain layer is the point of this design: pure functions with answers
checkable by hand, no network and no database.

### `domain/regression.ts`

| Case | Expected |
|---|---|
| variance of a constant series | exactly 0 |
| covariance of a series with itself | equals its variance |
| OLS of `y = 2x + 3` | slope 2, intercept 3 |
| R² of a perfect linear fit | exactly 1 |
| R² of a series against its negation | exactly 1 (β negative, fit still perfect) |
| any input shorter than 2 points | `null` |
| mismatched series lengths | throws — a programming error, not a data condition |

### `domain/risk.ts` — `marketExposure()`

| Case | Expected |
|---|---|
| series regressed against itself | β exactly 1, α exactly 0, R² exactly 1 |
| against a 2× leveraged copy | β exactly 2 |
| against a flat benchmark | `null`, not 0 or NaN |
| portfolio = benchmark plus 0.01 each day | α = 0.01 × 252, β unchanged at 1 |
| cash-only portfolio | β 0, α 0 |
| constant portfolio series | volatility exactly 0 |
| 150 aligned days | every metric `null` |
| single holding, 100% weight | that holding's β exactly |
| one holding with no history | excluded, weights renormalised, count reported |

### `data/useRiskSeries.ts`

| Case | Expected |
|---|---|
| holding trades on a date the benchmark does not | date dropped |
| benchmark trades on a date a holding is missing | date dropped, not forward-filled |
| holding with zero price rows | reported as excluded, not treated as flat |

### Rust

| Case | Expected |
|---|---|
| index backfill | two years of `^GSPC` rows land in `index_quotes` |
| after backfill | `^GSPC` appears in no row of `securities` |
| after backfill | holdings, allocation and net worth are unchanged |
| ordinary refresh | still requests `RECENT_RANGE`, does not rewrite history |

## Build order

1. **Benchmark history.** `indices.rs` backfill at 2y, Tauri command, wired into
   the existing first-launch backfill. Prerequisite for everything else.
2. **`domain/regression.ts`.** Pure statistics, tested against textbook answers.
3. **`domain/risk.ts` — `marketExposure()`.** Alpha, beta, R², volatility, with
   every null path tested.
4. **`data/useRiskSeries.ts`.** Alignment, exclusions, renormalisation.
5. **`MarketExposureCard`.** Rendering, caveats, empty state.

Each step is independently testable. Steps 2 and 3 need no data and no backend.

## Open questions

1. **Configurable benchmark.** `^IXIC` and `^DJI` are already in
   `index_quotes`, so offering a choice is cheap. Recommend hard-coding
   `^GSPC` here and adding the setting only if it is actually wanted.
2. **Window length.** Two years, matching `HISTORY_RANGE` and the security
   backfill. Shown on the card so the figure is interpretable.
3. **Risk-free rate.** Zero, as above. Revisit only if a rate source arrives in
   the app for another reason.
