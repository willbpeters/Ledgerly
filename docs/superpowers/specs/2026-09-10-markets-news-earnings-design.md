# Markets screen — news and earnings — design

**Date:** 2026-09-10
**Status:** proposed, not yet approved for implementation

## What this is for

The Dashboard says what the portfolio is *worth*. Holdings says what is *in*
it. Neither says what **happened**. When a position moves 4% in a day the app
is silent about why, and about whether the rest of the market moved too.

This module answers two questions, chosen by the owner over deep-dive research
and forward-looking calendars:

> **What happened to the things I own today?**
> **Is this me, or is it everything?**

## The portfolio this is being built for

Reading the live database shaped the design more than any assumption did. There
are 11 securities, and they split cleanly in two:

| Individual companies | Index funds |
| --- | --- |
| GOOG, LLY, INTC, MU, SNOW, MSFT | SWPPX, SWLGX, SWSSX, SWISX, VOO |

More than half the money sits in index funds, which have **no company news and
no earnings**. SWPPX *is* the S&P 500. So the two questions above map onto the
two halves of the portfolio: news and earnings answer the first for the six
companies, market context answers the second for the funds.

The screen is therefore split by **what kind of instrument something is**, not
by an arbitrary list. That distinction is data (`quote_type`), not a hardcoded
set of tickers, so it stays correct when holdings change.

It also bounds the work: six equities, not six hundred.

## Design principle: show, do not attribute

The owner explicitly chose this over the alternatives. A price move and a
headline are **presented side by side, and the app claims no link between
them**. It never says "MU fell because of X".

This is the same principle as the Concentration card — describe, do not advise
— applied to causation rather than recommendation. It is also simply honest:
most daily moves are market-wide drift with no story behind them, and a
confident wrong explanation is worse than none at all.

Wording follows from this. "Reported earnings today" is a fact. "Fell on
earnings" is a claim. Only the first is allowed.

## Data sources — what is actually reachable

Every endpoint below was tested live on 2026-09-10 before being designed
against. This matters: the obvious choice turned out to be dead.

| Need | Source | Result |
| --- | --- | --- |
| Headlines per company | `feeds.finance.yahoo.com/rss/2.0/headline?s=TICKER` | 200, works keyless |
| Sector, long name, `quote_type` | `query1.finance.yahoo.com/v1/finance/search?q=TICKER` | 200, works keyless |
| Who reports on a date | `api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD` | 200, works keyless |
| Beat/miss, last 4 quarters | `api.nasdaq.com/api/company/{SYM}/earnings-surprise` | 200, works keyless |
| Next-quarter consensus EPS | `api.nasdaq.com/api/analyst/{SYM}/earnings-forecast` | 200, works keyless |
| Index levels (^GSPC, ^IXIC, ^DJI) | the **existing** Yahoo chart endpoint | 200, no new plumbing |

**Yahoo `quoteSummary` is not usable.** The usual source for earnings dates
answers `401 Invalid Crumb` to a plain HTTP client — it now requires a cookie
and crumb handshake. That is the same anti-bot pattern that killed Stooq, and
designing around it would have wasted the implementation. Nasdaq's endpoints
replace it and are better shaped anyway, because they carry consensus and
actuals together.

All sources are keyless and free, consistent with the project rule that
Ledgerly uses no paid services.

## Architecture

Unchanged seams. Rust does all I/O, parsing is pure and fixture-tested, and the
assembly maths is pure TypeScript in the domain layer.

```
market/
  mod.rs           NewsProvider / EarningsProvider traits
  yahoo_news.rs    HTTP: RSS per ticker
  rss.rs           pure: XML → NewsItem            ← fixture-tested
  nasdaq.rs        HTTP: calendar, surprise, forecast
  nasdaq_parse.rs  pure: JSON → EarningsEvent      ← fixture-tested
  benchmarks.rs    static fund → index map, like budget/mcc.rs
  store.rs         SQLite reads and writes
       ↓
commands/market.rs  news_list, earnings_upcoming, earnings_history,
                    market_indices, security_profiles, market_refresh
       ↓
TS: domain/market.ts   pure assembly → the screen's view model
    features/markets/  the screen
```

The module deliberately mirrors `simplefin/`, which already separates
`client.rs` (HTTP) from `parse.rs` (pure) from `sync.rs` (SQLite). Following an
existing shape is worth more than inventing a better one.

**Commands return rows, not a finished screen.** `src/domain/market.ts` joins
holdings, profiles, news and earnings into the view model. This keeps the
assembly logic unit-testable with no React and no network, the same way
`derivePortfolio` is.

### Data model — migration v5

Three new tables, each keyed to `securities` with `ON DELETE CASCADE`, plus one
standalone table for index levels.

```sql
CREATE TABLE news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT NOT NULL,
  publisher TEXT,
  published TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (security_id, guid)
);
CREATE INDEX news_items_published ON news_items(published);

CREATE TABLE earnings_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  fiscal_period TEXT,
  report_date TEXT NOT NULL,
  eps_actual REAL,
  eps_estimate REAL,
  estimate_count INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE (security_id, report_date)
);

CREATE TABLE security_profile (
  security_id INTEGER PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
  long_name TEXT,
  sector TEXT,
  quote_type TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE index_quotes (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);
```

Notes on three choices that are not obvious:

- **`eps_actual` is NULL until reported.** One row therefore serves as both
  "next report, consensus 1.92" and, later, "reported 1.79 against 1.60". No
  separate future/past tables, and no migration when a quarter lands.
- **`quote_type`** is what routes GOOG into *Your companies* and SWPPX into
  *Your funds*. It comes free from the Yahoo search endpoint.
- **`index_quotes` is deliberately not in `securities`.** Putting ^GSPC there
  would make the S&P appear in Holdings and in the allocation chart as though
  it were owned.

`news_items.summary` holds the ~280-character blurb the RSS feed already
carries. It costs nothing to store now and is the raw material the follow-on
summariser needs; without it, that feature would have to re-fetch every article.

Migration v5 follows the rules `db.rs` already enforces: idempotent, gated on a
completeness check rather than the version stamp alone, and added to
`apply_migrations` after the existing blocks.

## The screen

A new rail icon beside Dashboard and Holdings, route `/markets`. Chosen from
three mockups; the other two were folding it into the Dashboard, and a
per-company drill-down.

**1 — Market strip.** S&P 500, Nasdaq, Dow, and **You**, each showing today's
percentage change. "You" is the existing `derivePortfolio` day change, so it
cannot disagree with the Dashboard. This single row is the entire "is it me or
is it everything?" answer.

**2 — Your companies.** Securities where `quote_type = EQUITY` and shares > 0.
Each row: ticker, name, day move, an earnings badge when a report falls within
14 days, and the latest headline or two with publisher and relative time.

- **Sorted by absolute size of move, largest first.** Alphabetical would bury
  the thing the screen exists to surface.
- A holding with nothing to report still appears, reading "no headlines today".
  A row that vanishes looks like a bug.

**3 — Your funds.** `quote_type` of ETF or MUTUALFUND, and shares > 0 — the
same held-position filter as the companies block, so a leftover security row
with no shares (VOO and MSFT are both in this state today) does not appear in
either list. Ticker, name, what it tracks, day move. No headlines: index funds have no company news, and showing
some would be noise dressed as signal.

The "tracks" label comes from `benchmarks.rs`, a small static map in the spirit
of `budget/mcc.rs` (SWPPX → S&P 500, SWISX → MSCI EAFE, and so on). An unknown
fund shows its name and move with the label blank — never a guess.

**4 — Earnings, next 14 days.** A compact strip of dates carrying tickers. A
company that reported within the last few days shows beat or miss inline,
actual against consensus.

Headlines open in the system browser through Tauri's opener, not in-app.

## Refresh policy

A pure `src/domain/marketSchedule.ts`, mirroring the existing
`refreshSchedule.ts` so the cadence is unit-tested rather than scattered
through effects.

| Data | Cadence |
| --- | --- |
| News | every 30 min in US market hours, every 2 h outside, paused while the window is hidden |
| Index levels | alongside the existing price refresh — the market strip needs latest and previous close, which is exactly what `refresh_all` already does for securities |
| Earnings calendar | once a day |
| Profiles (sector, `quote_type`) | once a week, and immediately for a newly-seen security |

Plus a manual Refresh on the screen.

**The politeness budget is the reason these numbers are what they are.** The
handoff is explicit that price refreshing is a budget, and that Stooq was lost
to exactly this. Peak load here is 6 RSS requests every 30 minutes — 12 an
hour — against the roughly 660 an hour the price refresh already makes. The
feature adds under 2% to outbound traffic. Requests go through the same
blocking client with the same browser-like User-Agent, sequentially, never in
parallel.

The earnings calendar is fetched **by date, once a day, for the next ten market
days**, and intersected with held tickers locally. Per-company surprise and
forecast are fetched only when a report is near or has just landed.

## When it breaks

It will. `quoteSummary` broke before implementation even started.

- **Per-ticker isolation**, as `sync.rs` already isolates one account per
  transaction. One ticker failing never aborts the batch; errors collect into a
  report.
- **The cache is what the screen renders.** The network only updates it. The
  screen never blocks on a fetch and never blanks — stale rows render with
  their "as of" time shown.
- **Providers sit behind traits.** If Yahoo's RSS starts serving a challenge,
  swapping to Google News RSS is one file and no UI change. This is why
  `StooqProvider` was kept, and the same reasoning applies here.

## Testing

- **Rust:** `rss.rs` and `nasdaq_parse.rs` are pure and tested against
  committed real captures taken during this design session. Store tests run
  against an in-memory database, as `sync.rs` tests do. Live-endpoint tests are
  marked `#[ignore]`, matching the SimpleFIN pattern.
- **TypeScript:** `domain/market.ts` covers grouping by `quote_type`, mover
  ordering, staleness, and the empty states. `domain/marketSchedule.ts` covers
  the cadence decisions.
- **Migration v5** is covered by a test that runs it against a populated v4
  database and then runs it a second time, proving idempotency.

## Deliberately out of scope

- **Per-company drill-down** (mockup C) — the same stored data supports it, and
  it layers cleanly on top later. It answers "should I trim this?", which is a
  different job from the one chosen.
- **Attribution of moves to causes** — see the design principle above.
- **Sector-level performance** — the `sector` column is stored, but no sector
  breakdown is built yet. Cheap to add once there is a reason to.

## Follow-on: local model summaries

The natural next cycle, and its own spec.

A local model reading `news_items` plus current positions can do the one thing
a list cannot: synthesis across holdings — "INTC and MU both moved on the same
memory-pricing story; your funds simply tracked the index". The owner's machine
(RTX 3070 Ti, 8 GB VRAM) comfortably runs a 4-bit 7–8B model.

Two constraints that belong in that spec:

1. **The model never restates a number.** Every figure on screen renders from
   SQLite; the model fills narrative slots only. A 7B model will invent an EPS
   figure without hesitation, and a fluent wrong number in a finance app is the
   worst available failure.
2. **It describes, it does not recommend.** Consistent with the risk module.

Delivery would be Ollama as an **optional** dependency, detected on localhost:
no Ollama, no summary panel, everything else unaffected. This keeps the
installer small and the project local-first.

The ordering is not a preference, it is a dependency: a local model has no
market data and no live feed, so it can only describe what this pipeline has
already fetched and stored. This module is a prerequisite, not an alternative.

## Suggested build order

1. Migration v5 and `store.rs` — tables, reads, writes, tested in memory.
2. `rss.rs` and `yahoo_news.rs` — headlines for held equities, with fixtures.
3. `security_profile` fetch — makes the companies/funds split real.
4. `index_quotes` and the market strip — the smallest useful slice of screen.
5. Nasdaq calendar, surprise and forecast.
6. The Markets screen, assembled from `domain/market.ts`.
7. `marketSchedule.ts` and wiring the timers.

Steps 1–4 already produce a screen worth opening.

## Open questions

None blocking. One to revisit after use: whether 30 minutes is the right news
cadence, or whether hourly is plenty in practice.
