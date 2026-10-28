# Dashboard as an overview — design

**Date:** 2026-10-21
**Status:** agreed with the owner (layout mockup and four decisions, 2026-10-21)

## The ask

> dashboard should focus on an overview. lets make the chart bigger and under it
> should just be an account overview and then transactions from last 7 days. and
> for the chart, add ability to see cash, liabilities, investments, and net worth.

## Layout, top to bottom

1. **Value card** (the dominant element).
   - Its selector *is* the headline: four tabs side by side, each a label and
     today's figure — **Net worth** (serif, as the hero is today), **Investments**,
     **Cash**, **Liabilities**. The selected tab is underlined in the accent and
     picks the line the chart plots. Net worth is selected on open.
   - Under the Investments figure, one small line: today's change and all-time
     gain (`+$612 today · +18.4% all time`). They describe the investments only,
     and sitting under that tab now says so without the old "(investments)"
     captions.
   - The separate `Headline` row is removed.
   - The Liabilities figure renders negative and red (`−$2,690`), as Owed does
     today. The tab is shown even when there is no debt ($0.00), so the tabs never
     shift.
   - 1M / 3M range picker stays, top right of the chart.
   - Chart height goes from 236px to 380px.
   - The subtitle (caveat) changes with the selected line, one per mode, kept
     in the `CHART_MODES` table as now.
2. **Accounts card.** Every visible account, grouped by account type in this
   order: Brokerage, Cash, Credit cards. Each group shows a header row with the
   group's total, then one row per account: name, institution (muted, when
   known), current value. Empty groups are not shown. Hidden accounts are
   excluded (they already are, by `derivePortfolio`). Header link: "Manage" →
   `/accounts`.
   - Group totals are by account type and so do not equal the tab figures exactly:
     a brokerage account's cash sits in the Brokerage group but counts toward
     Cash in the tab. The group labels name account types ("Brokerage"), not the
     tab measures ("Investments"), so they never claim to match.
3. **Last 7 days card.** Transactions posted today and the six days before, across
   visible accounts, newest first: date, description, account, amount (green when
   money comes in). Read-only. Header link: "View in Spending" → `/spending`.
   - Sources: bank transactions (`api.bankTransactions.list(from, today)`), plus
     manual investment transactions (the `transactions` table), merged.
   - Bank row description: payee, falling back to description. Pending rows carry a
     "Pending" badge.
   - Investment row description: `Buy 5 VTI`, `Sell 2 AAPL`, `Dividend VTI`,
     `Deposit`, `Withdrawal`, `Fee`, `Interest`. Amount is its cash effect
     (`cashEffect`), so a buy reads negative.
   - Empty state: "No transactions in the last 7 days."

## What leaves the Dashboard

- **Positions table:** removed; the Holdings page already has the full table.
- **Concentration (`RiskCard`) and Market exposure cards:** move, unchanged,
  below the tables on the Holdings page. The files move to `src/features/holdings/`
  with their tests, and `exposureInputs` (and its test) moves with them.

## Chart data: four lines from one reconstruction

`ValuePoint` gains two fields, so every point carries all four measures:

- `value` — net worth (unchanged).
- `invested` — holdings only (unchanged).
- `cash` — new. Cash on every non-credit account: manual cash effects for manual
  accounts, and for synced accounts today's balance less holdings, less what has
  posted since — the same terms `reconstructSeries` already adds into `value`.
- `liabilities` — new, **as a positive amount owed**, so the line rises when debt
  rises. Built from the same terms for credit-type accounts, sign flipped.

Invariant, tested: `value = invested + cash − liabilities` on every point.

The tab figures come from `PortfolioSummary` (`totalValue`, `investedValue`,
`cash`, `liabilities`), as the headline does now. The Liabilities tab shows
`summary.liabilities` (negative); the line plots the positive amount.

The Y axis currently clamps its lower bound at zero. Cash can be negative
(an overdrawn manual account), so the lower bound becomes `min * 0.97` for a
positive minimum and `min * 1.03` for a negative one.

Mode subtitles:

- Net worth: unchanged.
- Investments: unchanged.
- Cash: "Your cash balances, walked back from today through the transactions
  posted since. Brokerage cash is included."
- Liabilities: "What you owe on credit accounts, walked back from today's balance
  through the transactions posted since."

## Units

| Unit | Kind | Purpose |
| --- | --- | --- |
| `reconstructSeries` (`domain/history.ts`) | pure, extended | adds `cash`, `liabilities` per point |
| `accountOverview` (`domain/overview.ts`) | pure, new | `AccountBreakdown[]` → ordered groups with totals |
| `recentActivity` (`domain/overview.ts`) | pure, new | bank + investment txns, accounts, securities, date window → sorted display rows |
| `ValueCard` (`features/dashboard/`) | component, new | tabs + chart; replaces `Headline` and the inline chart |
| `AccountsCard`, `RecentActivityCard` (`features/dashboard/`) | components, new | render the two pure results |
| `Dashboard.tsx` | slimmed | wires hooks to the three cards |
| `Holdings.tsx` | extended | renders `RiskCard` and `MarketExposureCard` |

## Testing

- `history.test.ts`: cash and liabilities per point for manual and synced
  accounts, a credit account walking back through posted transactions, hidden
  accounts excluded, and the `value = invested + cash − liabilities` invariant.
- `overview.test.ts`: grouping order, totals, empty groups dropped; activity
  window boundaries (day 7 back excluded, today included), hidden accounts
  excluded, merge order, investment descriptions and signs, payee fallback.
- `ValueCard.test.tsx`: four tabs with their figures, the Investments today/all
  time line, Liabilities red and negative, `CHART_MODES` keeps one dataKey and
  one distinct subtitle per mode.
- Existing `Headline.test.tsx` is replaced by `ValueCard.test.tsx`; the
  `exposureInputs` test moves with the risk cards.

## Docs

`docs/HANDOFF.md`'s Dashboard and Risk entries are updated to describe the new
layout and the cards' new home.
