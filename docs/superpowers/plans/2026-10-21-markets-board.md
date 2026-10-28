# Markets Board Implementation Plan

> Executed inline in the session that wrote it (superpowers:executing-plans style). Spec: `docs/superpowers/specs/2026-10-21-markets-board-design.md`.

**Goal:** Turn Markets into a market board: full-width Today strip with sparklines, sector and holdings heatmaps, the owner's cards below.

**Architecture:** One batch Yahoo spark request feeds `index_quotes` for 19 symbols; `list_index_quotes` returns group and recent closes; pure TS functions shape the board, heat levels and treemap; small components render them.

**Shell notes:** Vitest via `npx vitest run <path> > "$TMP/v.txt" 2>&1`; cargo with `export PATH="$HOME/.cargo/bin:$PATH"`; never commit `src-tauri/Cargo.toml`.

### Task 1 — Rust symbol table and spark parsing (`src-tauri/src/market/indices.rs`)
- [ ] Tests: `spark_url(&["^GSPC","2YY=F"])` contains `symbols=%5EGSPC,2YY%3DF`, `range=5d`, `interval=1d`; `parse_spark_json` on a fixture with two symbols (one with `response: null`) returns only the good one with its closes oldest first; every `INDICES` entry has a known group; `^GSPC` present; no more than `SPARK_BATCH` (20) symbols per chunk.
- [ ] Implement: `pub struct BoardSymbol { symbol, label, group }`, `INDICES: &[BoardSymbol]` (19 entries), `SPARK_BATCH = 20`, `spark_url`, `parse_spark_json`, `fetch_board(symbols)`; refactor `prices::yahoo::parse_chart_json` into `parse_chart_result(&Value)` reused by both.
- [ ] Commit.

### Task 2 — Refresh and store (`market/mod.rs`, `market/store.rs`)
- [ ] Tests: refresh makes `INDICES.chunks(SPARK_BATCH).len()` board calls; `indices_updated == INDICES.len()`; a symbol missing from a batch is reported as an error and the others stored; `list_index_quotes` returns `group` and `recent` (≤5, oldest first) and skips symbols with < 2 closes.
- [ ] Implement `MarketSource::board_closes(&[&str])`, chunked loop in `refresh_all`, `IndexQuote { group, recent }`.
- [ ] `cargo test` (background-safe: owner's app may be building — run only when it is idle, sharing its target dir is not allowed while it runs). Commit.

### Task 3 — TS domain (`domain/market.ts`, `domain/heatmap.ts`, `types.ts`)
- [ ] Tests: `buildMarketView` splits `board` (non-sector, table order) from `sectors` (sorted by move, desc); yields carry `changeBp`; `heatLevel(0.1)=0`-ish thresholds and saturation at ±2%; `treemap` rect areas ∝ values, union fills 100×100, zero/negative values dropped; `sparkPath` scales into the box and handles flat series.
- [ ] Implement and commit.

### Task 4 — Components (`features/markets/TodayBoard.tsx`, `SectorHeatmap.tsx`, `HoldingsHeatmap.tsx`, `ui/Sparkline.tsx`, `Markets.tsx`, `styles.css`)
- [ ] Tests: board renders 8 tiles with levels; VIX and yield changes have no pos/neg class, index changes do; yields read `5.11%` and `-2 bp`; sector heatmap renders 11 tiles in move order with `heat-*` classes; holdings heatmap renders one tile per holding, empty state when none; "Your investments" in the header.
- [ ] Implement, wire into `Markets.tsx`, CSS grid + heat classes, commit.

### Task 5 — Verify and preview
- [ ] Full Vitest, tsc, `cargo test`, vite build. HANDOFF: Markets entry and the politeness-budget note (1 request per poll for the board). Cherry-pick into `Ledgerly-preview`; the Rust change needs the preview app restarted.
