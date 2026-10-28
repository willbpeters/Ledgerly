# Tally — open work

Rewritten 2026-10-14 after a full review, when every branch was merged and
`master` became the only branch. `docs/HANDOFF.md` remains the reference for how
things work; this file is only what is *not done yet*, **in the order to do it**.

**The goal driving the order:** Tally should be able to replace a paid
budgeting app (Copilot) for daily use. So the list protects your data first, then
fixes what makes everyday use annoying, then fills the gaps a budgeting app is
expected to have, and only then adds the bigger investment features.

Each item marked **(spec)** gets its own spec → plan → implement cycle. The rest
are small enough to go straight to test-first implementation.

---

## Phase 1 — Protect your data

- [x] **1. Backup & export.** Done 2026-10-14: daily, pre-migration,
      pre-restore and manual backups, an optional extra folder, in-app restore
      and CSV export, all in Settings → Backups. Checked in the running app,
      including a real restore. See HANDOFF "Backups".
- [ ] **2. CI on GitHub.** There is no `.github/workflows` yet. Add an Action on
      push running `npm test`, `npx tsc --noEmit` and `cargo test` on
      `windows-latest`, so a broken change is caught on GitHub, not in the app.
- [ ] **3. Hardening.** `"csp": null` in `tauri.conf.json` turns off the
      content security policy while the app shows third-party headlines; set a
      real one. Remove Stooq's unused `parse_daily_csv` / `daily_url`, which warn
      on every build. Two component tests time out on a busy machine (seen in
      `Activity.test.tsx`); give them more time or make them cheaper.

## Phase 2 — Everyday annoyances

- [ ] **4. Look at the Dashboard in the running app** *(yours to do)*. The
      investment-figures work is merged but has never been seen on screen.
      Check that six figures on one headline row look right, and that the
      Investments line stays flat across real paydays. Run `npm run tauri dev`.
- [ ] **5. Edit a transaction.** Only create and delete exist today, so a typo
      means deleting and re-entering. Needs a `transactions_update` command and
      an edit form in Activity.
- [ ] **6. CSV import de-duplication.** Importing the same file twice doubles
      the holdings. In the preview step, flag rows already present (same
      account, date, type, security, quantity, price) and skip them by default.
- [ ] **7. SimpleFIN auto-sync.** Sync is manual today. Add a timer beside the
      price auto-refresh; `simplefin_sync` is already async, so it will not
      freeze the window.
- [ ] **8. Three small dashboard bugs found in review:**
      - The Investments chart draws a flat zero line instead of an empty state
        when nothing is held, because `usePriceHistoryRows` returns every
        stored close. Put the decision in a small exported predicate and test
        it, as `RiskCard` already does ("Nothing invested to measure yet").
      - The headline and the chart disagree about a manual holding with no
        price: `buildPositions` (`src/domain/positions.ts`) values it at 0,
        `reconstructSeries` (`src/domain/history.ts`) at the last price paid.
        Write a failing test first, and check the ripple into
        `concentration()` and the allocation weights before choosing one.
      - `toValueSeries` in `src/domain/series.ts` is called only by its own
        test. Confirm it is dead (check whether Rust still writes snapshots),
        then remove it or record why it stays.

## Phase 3 — What a budgeting app is expected to do

These are the gaps a former Copilot user would notice first.

- [x] **9. Bank-supplied categories.** Done differently, 2026-10-15: the
      diagnostic showed SimpleFIN sends no category for the owner's banks, so
      Tally sorts by merchant name and transfer pairing instead, with a
      Copilot-style To review list. See HANDOFF "Copilot-style sorting".
- [x] **9b. Import from Copilot.** Done 2026-10-15, with Remove and Undo in
      Spending. See HANDOFF "Import from Copilot" and "Remove and Undo".
- [x] **10. Search and filter transactions.** Done 2026-10-25: Spending →
      Search finds words, exact amounts and >/< sizes across every month, with
      category and account filters; the command bar's search box goes there
      while you are on Spending. Removed transactions are not searched yet.
- [ ] **11. Edit a bank transaction.** Partly done 2026-10-15: notes are stored
      and shown (Copilot's arrive with the import), and **Remove** covers
      "exclude from budget". Still to do: editing a note in Tally, and a
      friendlier display name. Keep the sync from overwriting what you set,
      the way `category_source = 'manual'` already protects categories.
- [x] **12. Recurring bills and subscriptions.** Done 2026-10-25: Spending →
      Recurring lists bills spotted from the history (three or more charges
      from one payee at a steady amount and rhythm) with the next expected
      date, and shows what is still due and what was paid this month. A bill
      that has stopped is moved aside as "Not seen lately". "Not recurring"
      dismisses a wrong guess, and Restore brings it back. Income and
      paychecks are not listed.
- [ ] **13. Spending trends.** A month-by-month view: spending per category over
      the last 6–12 months, and income against spending (cash flow).
- [ ] **14. Budget rollover** (optional per category): unspent money carries
      into next month, overspending reduces it.
- [x] **15. Split a transaction** across categories. Done 2026-10-25: Split
      on any row in Spending divides it into pieces with their own categories;
      budgets, search and the category filter count each piece.

- [x] **15b. Savings goals.** Done 2026-10-25: a Goals screen (on the rail
      below Spending) with a target, an optional date, and either an account
      to follow or an amount kept by hand; shows what to put aside each month
      to make the date. In the CSV export as `goals.csv`.
- [ ] **15c. Goals when a sync or a disconnect removes an account.** When a
      sync removes an account a goal follows, or Settings → SimpleFIN
      "Disconnect → Remove them" (`SimplefinCard.tsx`) deletes every SimpleFIN
      account at once, the goal drops to its hand-kept amount, which may be
      stale. Keep its value the way deleting an account by hand now does:
      store the last shown figure as `saved_amount` before the account goes.

## Phase 4 — Correct numbers for a real portfolio

- [ ] **16. Stock splits.** There is no `split` transaction type, so a split
      breaks share count and average cost. Needs a v6 migration widening the
      `transactions.type` CHECK (a table rebuild, like v3) and a branch in
      `buildPositions`, `clampOversells` and `reconstructSeries`. **(spec)**
- [ ] **17. Dividends and real returns.** Dividends add cash but count toward
      no gain figure. Add XIRR / time-weighted return, with dividends, and
      compare against a benchmark. **(spec)**
- [ ] **18. Holding detail.** A per-holding page showing its individual lots,
      transactions, price chart and headlines. **(spec)**

## Phase 5 — Security

- [ ] **19. Encrypted database (SQLCipher) + app lock.** Windows Hello or a
      master password, with an auto-lock timeout. Do backup (1) first, and
      encrypt the backups too once this lands. All database access goes
      through `db.rs`, so the switch is mostly configuration. **(spec)**

## Phase 6 — Bigger extras

- [ ] **20. Risk analytics phases 3–4:** downside (max drawdown, historical
      VaR/CVaR) and diversification (correlation matrix, ETF overlap). Specs:
      `2026-09-08-risk-analytics-design.md`, `2026-09-11-alpha-vs-benchmark-design.md`.
- [ ] **21. Crypto and other assets** (real estate, private holdings).
- [ ] **22. Local AI summaries on the Markets screen.** Optional Ollama on
      localhost. Two hard rules: the model never states a number (every figure
      comes from SQLite), and it describes rather than recommends.
- [ ] **23. Multi-currency** (v1 is USD-only).

## Housekeeping

- [ ] Optional: rename branch `master` → `main`.
- [x] Rust crate renamed from `fintech-scaffold` to `ledgerly` (2026-10-14). The
      app identifier `com.ledgerly.app` did not change, so the database and the
      saved SimpleFIN connection are where they were.
