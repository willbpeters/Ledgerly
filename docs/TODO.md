# Ledgerly — open work

Written 2026-09-11, at the end of the dashboard investment-figures cycle.
Newest context first. `docs/HANDOFF.md` remains the reference for how things
work; this file is only what is *not done yet*.

---

## 1. Finish the dashboard investment-figures branch

**Branch:** `feature/dashboard-investment-figures` — 12 commits, not merged.
**State:** complete and fully reviewed. 251 TypeScript tests, 147 Rust tests,
`npx tsc --noEmit` clean. Nothing is broken or half-finished.

**What it changed:** Today and All time on the Dashboard now describe the
investments only (a paycheck cannot move them), Invested joined Cash and Owed,
and the value chart gained a Net worth / Investments toggle.

- [ ] **Look at it on screen.** This is the only outstanding work. Everything
      automated passes, but the running app was never viewed — two things need a
      human eye:
      1. whether six figures read well on one headline row (the CSS wraps to a
         second line rather than overflowing, so nothing breaks, but whether the
         wrap *looks* right is a judgement call);
      2. whether the Investments line really is flat across real paydays. The
         logic is pinned by tests; live data is the actual proof.

      ```bash
      npm run tauri dev
      ```

- [ ] **Then decide:** merge to `master` locally, or open a PR. Four options were
      on the table — merge locally, PR, keep as-is, discard. Keeping as-is is the
      current state; nothing expires.

**Docs:** spec `docs/superpowers/specs/2026-09-11-dashboard-investment-figures-design.md`,
plan `docs/superpowers/plans/2026-09-11-dashboard-investment-figures.md`.

---

## 2. Three follow-ups found by review, deliberately not folded in

Each was logged as a task chip in the session that found it. If those chips are
gone, the full context is here. All three are real, none is urgent.

- [ ] **Dead `toValueSeries` code.** `src/domain/series.ts` builds a series from
      snapshots, but is called only by its own test — the live path is
      `reconstructSeries`. It now sits beside the new `ValuePoint` type, so a
      future reader could wire up the wrong one. Verify it is genuinely dead
      first (grep Rust too — the backend may still *write* snapshots even if
      nothing reads them; if so, record that in `HANDOFF.md` rather than ripping
      out the backend).

- [ ] **The headline and the chart disagree about unpriced manual holdings.**
      For a manual holding whose security has no row in `prices` at all,
      `buildPositions` (`src/domain/positions.ts`, ~line 52) falls back to `0`,
      so the **Invested** figure omits it — while `reconstructSeries`
      (`src/domain/history.ts`, ~line 116) falls back to the last price paid, so
      the **Investments** chart line includes it at cost. Pre-existing, but the
      new dashboard puts both numbers on one screen and invites comparison.
      Write a failing test proving the divergence before changing anything.
      Before adopting the last-paid fallback everywhere, check the ripple:
      `concentration()` in `risk.ts` filters `marketValue > 0`, and allocation
      weights divide by invested value, so the Concentration card and the
      allocation chart would move too.

- [ ] **Investments chart draws a flat zero line instead of an empty state.**
      The card's empty state is gated only on `series.length < 2`, but
      `usePriceHistoryRows` fetches every stored close — not just held
      securities — so a portfolio with no holdings can still yield enough points
      to pass that gate. `RiskCard` already handles the same condition properly
      ("Nothing invested to measure yet"), so the dashboard would contradict
      itself. Fix belongs in the rendering decision, not the data layer: extract
      a small exported predicate and test that, since `Dashboard.tsx` cannot be
      mounted.

---

## 3. Longer-term, from `docs/HANDOFF.md`

Unchanged by this cycle. Each wants its own spec → plan → implement pass rather
than being bolted on. Suggested order:

- [ ] **Local model summaries for the Markets screen** — optional Ollama on
      localhost, reading `news_items` plus positions to write a short
      cross-holding summary. Two hard rules: the model never restates a number
      (every figure renders from SQLite — a fluent wrong figure in a finance app
      is the worst available failure), and it describes rather than recommends.
      No Ollama, no panel, everything else unaffected.
- [ ] **SimpleFIN scheduled auto-sync** — sync is manual today; a timer beside
      the price auto-refresh would do it.
- [ ] **Encrypted database (SQLCipher) + app lock** — Windows Hello / passkey /
      master password, with an auto-lock timeout.
- [ ] **Holding detail drill-down** — per-holding view showing individual lots.
      In the original design spec, scoped out of v1.
- [ ] **Crypto and manual/other asset types** (real estate, private assets).
- [ ] **Risk analytics phases 3–4** — downside (max drawdown, historical
      VaR/CVaR) and diversification (correlation matrix, ETF-overlap). Phases
      0–2 are done.
- [ ] **Advanced returns** (XIRR / time-weighted, benchmarks) and **historical
      backfill** for the value chart, which today only builds forward from daily
      snapshots.
- [ ] **Multi-currency** (v1 is USD-only).

---

## Note on the Markets screen

It is **already built and merged** — Rust `market/` module, `src/domain/market.ts`,
the screen at `/markets`. If it comes up again as something to build, check the
app first; the work was done on 2026-09-11 and verified against live feeds.
