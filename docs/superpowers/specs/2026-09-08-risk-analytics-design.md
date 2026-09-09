# Risk analytics for the dashboard — design

**Date:** 2026-09-08
**Status:** proposed, not yet approved for implementation

## What this is for

The dashboard says what you *have*. It says nothing about what you are
*exposed to*. Two portfolios worth the same $250,000 can behave completely
differently: one spread across bonds and cash, one entirely in three tech
stocks. This module adds the second dimension — how much market risk the
portfolio carries, and where it is concentrated.

The single question to answer on the dashboard is:

> **If the market drops 10%, roughly what happens to me?**

## Design principle: describe, do not advise

Every number here is a **descriptive statistic about data you already own**.
The module must never tell the owner what to buy, sell or hold, and must not
imply a forecast. Phrasing is "your portfolio has historically moved 1.2× the
market", never "you should reduce your tech exposure". This keeps the feature
useful and keeps Ledgerly out of the business of giving financial advice.

Every metric is also **backward-looking and noisy**. The UI must say so, once,
plainly — not bury it.

## The blocker: there is no price history

This is the crux of the whole design, and it needs solving first.

- `yahoo::chart_url` requests `range=5d`.
- `refresh_all` keeps only the two most recent closes per security
  (`rows.iter().rev().take(2)`), because all it needed was "latest" and
  "previous" for the day-change figure.
- The `snapshots` table has three rows, and only grows one row per day going
  forward.

So today the app holds **two data points per holding**. Volatility, beta,
drawdown, correlation and VaR are all impossible — or worse, computable and
meaningless. Nothing in Phase 2 onward can start until this is fixed.

The fix is small. Yahoo's chart endpoint already accepts a longer range in the
same single request: `?interval=1d&range=2y`. The parser in `yahoo.rs` already
returns every `(date, close)` row it finds; only the `.take(2)` at the storage
end throws them away.

## Architecture

Unchanged seams. All risk maths is **pure TypeScript in `src/domain/risk.ts`**,
with no React and no I/O, unit-tested like the rest of the domain layer. The
Rust core gains only price-history fetching and storage. The dashboard reads
the results through a hook, exactly as it reads `usePortfolio` today.

```
Rust: prices/mod.rs   → fetch 2y of daily closes, store all of them
      prices table    → (security_id, date, close) — already the right shape
        ↓
TS:   data/useReturns → assemble a daily return series per holding
      domain/risk.ts  → pure functions: weights, beta, vol, drawdown, VaR, corr
        ↓
      features/dashboard/RiskCard.tsx
```

### Data model

**No schema change is required.** The `prices` table is already keyed
`(security_id, date)` with a `close` — it simply needs more rows. A 2-year
backfill across ~10 holdings is roughly 5,000 rows, which is nothing for
SQLite.

One addition is needed: a **benchmark**. Beta needs something to measure
against, and the natural choice is `SPY` (S&P 500). The cheapest way to get its
history is to insert `SPY` as an ordinary row in `securities` — `refresh_all`
already fetches every security, so its prices arrive for free, and because
holdings are derived from *positions* (of which SPY has none), it will not
appear anywhere in Holdings, allocation or net worth. This needs a test
asserting exactly that, since it is the kind of thing that quietly breaks.

## The metrics

### Tier 1 — Concentration (works today, no history needed)

These can ship before the backfill lands, and answer "are my eggs in one
basket?".

| Metric | Definition | Why it earns its place |
|---|---|---|
| **Position weights** | each holding ÷ total portfolio value | The base for everything else |
| **Top holding %** | largest single weight | The number people actually feel |
| **Top 5 %** | sum of five largest weights | Catches "diversified into five tech stocks" |
| **Effective number of positions** | `1 / Σ(wᵢ²)` — the inverse Herfindahl index | Twenty holdings where one is 80% has an effective count near 1.5. One honest number instead of a count that flatters. |
| **Account concentration** | weights by account | Already computed as `allocationByAccount` |

### Tier 2 — Market exposure (needs history; this is the headline)

**Beta** is the direct answer to the question at the top. For each holding,
regress its daily returns against SPY's daily returns over the window:

```
βᵢ = covariance(rᵢ, r_market) / variance(r_market)
```

Then the **portfolio beta** is the value-weighted average, `β_p = Σ wᵢ βᵢ`,
where weights include cash at β = 0 (cash genuinely does not move with the
market, and ignoring it overstates exposure).

The headline figure on the dashboard should be **beta-adjusted market
exposure** — beta expressed in the owner's own money, which is far more
legible than a bare number:

> Holdings $100,000 at β 1.15 + $20,000 cash = **$115,000 effective market
> exposure** on $120,000 of net worth (96%). A 10% market fall would
> historically have cost about **$11,500**.

Alongside it:

- **Annualised volatility** — `stdev(daily portfolio returns) × √252`.
  Computed from the *reconstructed portfolio series* (weights applied to
  holding returns), not by averaging individual volatilities — the portfolio
  calculation captures correlation for free, whereas averaging ignores it and
  always overstates risk.
- **R² against the benchmark** — what share of the portfolio's movement the
  market explains. High R² (>0.9) means "you own the market, whatever the
  tickers say". Low R² means real idiosyncratic risk.

### Tier 3 — Downside

Averages hide the thing people care about. These describe bad days.

- **Maximum drawdown** — the largest peak-to-trough fall in the reconstructed
  portfolio series, with the dates. "Between 3 Feb and 14 Mar you would have
  been down 18%."
- **Historical VaR (95%, 1-day)** — the 5th percentile of daily returns, in
  dollars. "On the worst day in twenty, a loss of about $2,400 or more."
  Historical (empirical percentile), *not* the normal-distribution formula:
  market returns have fat tails and the normal version understates them badly.
- **Conditional VaR / expected shortfall** — the mean loss *given* you are past
  the VaR threshold. More honest than VaR, which says nothing about how bad the
  tail gets. Worth showing both.

### Tier 4 — Diversification quality

This is where a personal tracker can say something genuinely non-obvious.

- **Pairwise correlation matrix** across holdings.
- **Average pairwise correlation** as a single diversification score.
- **Overlap detection**: flag pairs correlating above ~0.95. VOO, VTI and SPLG
  are near-identical; a portfolio holding all three looks diversified by count
  and is not. A plain sentence — "VOO and VTI have moved together 99% of the
  time" — is more useful than any chart.

## Handling the awkward cases

These are the details that decide whether the numbers are trustworthy.

- **Holdings with no usable history.** Money-market funds, some mutual funds,
  and anything Yahoo does not know return no rows. Exclude them from beta and
  volatility, include them in concentration, and **say so on screen** ("2 of 11
  holdings excluded: no price history"). Silently dropping them would misstate
  exposure.
- **Short history.** A holding listed three months ago has ~60 data points.
  Compute on the overlapping window only, and suppress any metric with fewer
  than ~60 observations rather than showing a confident-looking wrong number.
- **Cash and credit-card debt.** Cash enters at β 0. Card debt is negative net
  worth but carries no market exposure, so it must not be netted against
  holdings before computing beta — otherwise debt would appear to *reduce*
  market risk, when it does the opposite by leveraging the position.
- **Hidden accounts** are excluded, exactly as everywhere else — the risk
  module reads from `derivePortfolio()`, so this is automatic.
- **Non-trading days and mismatched calendars.** Align every series on the
  benchmark's trading dates and drop any date missing a price, rather than
  forward-filling; forward-filled zeros depress volatility artificially.

## Suggested build order

Each phase is independently useful and independently shippable.

**Phase 0 — price history.** Change the Yahoo range to `2y`, add a
`prices_backfill` command that stores every returned row, and keep the ordinary
60-second refresh writing only the latest two (a 60s refresh must not rewrite
5,000 rows). Run the backfill on first launch after upgrade and whenever a new
security appears. *Prerequisite for everything below.*

**Phase 1 — concentration.** `domain/risk.ts` with weights, top-N, and
effective position count. A dashboard card. Needs no history, so it ships
first and delivers value immediately.

**Phase 2 — market exposure.** SPY as benchmark, daily returns, beta per
holding, portfolio beta, beta-adjusted exposure, annualised volatility, R².
This is the phase that answers the original question.

**Phase 3 — downside.** Max drawdown, historical VaR, conditional VaR.

**Phase 4 — diversification.** Correlation matrix, average correlation,
overlap warnings.

## Testing

The domain layer is the whole point of this design — pure functions with known
answers.

- Beta of a series against **itself** is exactly 1. Against a 2× leveraged copy,
  exactly 2. Against a flat series, undefined and must be reported as such, not
  as 0 or NaN.
- Volatility of a constant series is 0.
- Max drawdown of a known peak-and-trough sequence is arithmetic that can be
  asserted by hand.
- VaR at 95% over 100 known daily returns is the 5th-smallest value.
- Correlation of a series with itself is 1; with its negation, −1.
- A portfolio of one holding has that holding's beta exactly.
- Cash-only portfolios have beta 0, not NaN — a division-by-zero trap.

Every one of these is checkable without a network call or a database.

## Open questions

1. **Benchmark choice.** SPY is the obvious default. Should it be
   configurable in Settings (QQQ, VT for global)? Recommend: hard-code SPY for
   Phase 2, make it a setting only if it is actually wanted.
2. **Window length.** 2 years balances responsiveness against stability. 1 year
   is jumpier; 5 years is slow to react to a changed portfolio. Recommend 2,
   shown in the UI so the number is interpretable.
3. **Sector exposure** would be valuable ("62% technology") but the chart
   endpoint does not carry it — it needs a second Yahoo endpoint
   (`quoteSummary`/`assetProfile`) and therefore another request per security
   against the same politeness budget. Out of scope here; worth its own spec.
