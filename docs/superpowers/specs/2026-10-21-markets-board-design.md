# Markets page: a market board — design

**Date:** 2026-10-21 · **Status:** agreed with the owner (mockup and four decisions)

## The ask

> change the other dashboard to a markets page and create new cells with info
> about markets. can you create heatmaps based on today? also increase size of
> the Today cell that it spans across the top, and involves all the major funds,
> add russel and vix for ex.

The strip should carry large cap, small cap (Russell 2000), broad international,
VIX and Treasury yields; heatmaps for S&P sectors and for the owner's holdings;
the existing "your" cards stay, below.

## Layout (Markets screen)

1. **Today** — full width. Eight tiles in a 4-column grid: S&P 500, Nasdaq,
   Dow, Russell 2000, International (VXUS), VIX, 10-yr yield (`^TNX`), 5-yr
   yield (`^FVX`). Each: label, level, today's change, 5-day sparkline.
   - Indices: change in percent, green/red.
   - VIX: change in percent, **uncoloured** (a rising VIX is neither good nor bad news to colour).
   - Yields: level as a percent (`5.11%`), change in **basis points**, uncoloured.
   - Header right: "Your investments +0.4% today", then Refresh.
   - A 2-year yield was wanted but Yahoo's only keyless 2-year symbol is a futures
     contract that reported a stale 0% move, so the 5-year stands in.
2. **Heatmaps**, side by side (stacked on narrow windows):
   - **S&P sectors today** — 11 equal tiles (SPDR sector ETFs XLK, XLF, XLV, XLY,
     XLP, XLE, XLI, XLB, XLU, XLRE, XLC), sorted by today's move.
   - **Your holdings today** — a treemap: tile area ∝ market value, colour by
     today's move. Built from data already loaded; no extra downloads.
   - Colour: seven steps, red → neutral → green, saturating at ±2%.
3. Your companies, Your funds, Earnings — unchanged.
4. Page subtitle: "The market today, and what happened to what you own".

## Data

- The Rust side keeps one symbol table (`indices::INDICES`), now with a `group`
  per symbol: `index`, `volatility`, `yield`, `sector`. `^GSPC` stays in it, so
  the risk benchmark keeps refreshing as before.
- Fetching moves from one chart request per symbol to Yahoo's batch **spark**
  endpoint (`/v7/finance/spark`, keyless, at most 20 symbols per request,
  5-day daily closes). 19 symbols → **1 request per refresh** (today: 3). The
  politeness budget in HANDOFF improves rather than worsens. Each spark result
  has the chart endpoint's shape, so the existing close parser is reused.
- Closes go into the existing `index_quotes` table — **no schema change**, which
  matters because the sync branch has its own migrations.
- `list_index_quotes` returns, per symbol with at least two closes: symbol,
  label, group, latest, previous, and `recent` (up to the last 5 closes, oldest
  first) for the sparkline. Today's change is latest vs previous close, never
  spark's `chartPreviousClose` (that is the close before the 5-day window).
- Cadence unchanged (`marketSchedule.ts`).

## Units

| Unit | Kind |
| --- | --- |
| `indices.rs` symbol table + `spark_url` + `parse_spark_json` | Rust, pure, tested |
| `MarketSource::board_closes(symbols)` replaces `index_closes(symbol)` | Rust |
| `store::list_index_quotes` with group and recent | Rust, tested |
| `domain/market.ts`: `board` and `sectors` rows | TS, pure, tested |
| `domain/heatmap.ts`: `heatLevel`, `treemap` (slice-and-dice by value) | TS, pure, tested |
| `ui` `Sparkline` (path from `sparkPath`) | TS, pure path tested |
| `features/markets`: `TodayBoard`, `SectorHeatmap`, `HoldingsHeatmap` | components, tested |

## Testing

Rust: spark URL encodes `^`/`=` and batches; parser maps each symbol to its
closes and skips failed entries; refresh makes one board call per 20 symbols and
stores what came back; quotes carry group and recent oldest-first. TS: level
steps and their saturation, treemap areas proportional to value and filling the
box, board/sector split and sorting, yields in basis points, uncoloured VIX and
yields, components render tiles and empty states.
