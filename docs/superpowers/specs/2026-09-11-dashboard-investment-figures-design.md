# Dashboard — investment performance apart from cash — design

**Date:** 2026-09-11
**Status:** approved for implementation

## What this is for

The Dashboard headline currently mixes two different questions into one row.
Net worth answers "how much do I have?" Today and All time are meant to answer
"how are my investments doing?" — but cash leaks into both the percentage and
the chart, so a payday reads as investment performance.

The owner's requirement, in their words: keep net worth, but make Today and All
time *representative of just investments*, and show total invested alongside
cash and debt.

## What is already correct, and what is not

Reading the code before designing changed the scope. Three of the four figures
need nothing.

| Figure | Source | Verdict |
| --- | --- | --- |
| Net worth | `investedValue + cash + liabilities` | Correct. Hidden accounts excluded, card balances kept out of cash rather than netted against it. |
| All time | `unrealized / totalCostBasis` | **Already investments-only.** A deposit cannot reach it. |
| Today, in dollars | `Σ shares × (last − prev)` | Already investments-only. |
| Today, as a percentage | `dayChange / (priorInvested + cash + liabilities)` | **Wrong.** Diluted by cash. |

So the headline defect is one denominator, not a rewrite. The larger and less
obvious problem is the chart: `reconstructSeries` plots net worth, rebuilt from
holdings *plus* manual cash effects *plus* synced balances, so a paycheck steps
the line up and the step is indistinguishable from a gain.

## The headline row

Order, left to right — net worth stays the hero, and Today and All time keep
their existing position ahead of the composition figures:

```
NET WORTH     │ TODAY    ALL TIME │ INVESTED   CASH      OWED
$142,318.44   │ +$1,204  +$18,447 │ $98,204    $46,114   −$2,000
              │ +1.24%   +23.1%   │
```

`Invested + Cash + Owed` sums to Net worth, so the three composition figures are
checkable against the hero by eye. Note the **plus**: `liabilities` is stored
negative and renders with its own minus sign, so Owed subtracts itself. Writing
the identity with a minus — as an earlier draft of this spec did — overshoots net
worth by twice the debt, which is exactly the sort of error a reader checking the
row by eye would hit. `Owed` keeps its existing behaviour of rendering only when
non-zero.

## The four changes

### 1. `Invested` becomes a headline figure

Display only. `summary.investedValue` is already computed and already used for
position weights; it is inserted before `Cash` in the headline.

### 2. Today's percentage divides by invested value alone

In `buildSummary`, `dayChangePct` changes from `dayChange / priorTotal` to
`dayChange / priorInvested`. The dollar figure is untouched.

`priorInvested` is already accumulated in the same loop, and already has the
right shape: a holding with no known previous close contributes its current
value to the baseline, so it counts as "no change" on both sides of the
fraction rather than skewing it. The guard becomes `priorInvested > 0` — a
portfolio of pure cash has no investment day change to express, and returns 0
as it does today.

`priorTotal` is then unused and is deleted rather than left behind.

### 3. Today and All time are labelled as investments

The captions become `Today (investments)` and `All time (investments)`.

This is not decoration. The project rule is that a figure never appears without
the caveat that explains it, and here two percentages sit beside a net-worth
hero while measuring something narrower than it. A reader who assumes Today is
a net-worth move will be wrong by exactly the proportion of their cash.

**Parentheses rather than a `·` separator**, which was the first choice and was
wrong: the values themselves already read `+$1,204.00 · +1.24%`, so a caption of
`Today · investments` put the same glyph directly above a different use of it,
one grammatical and one numeric, in the same narrow column. The label exists to
clarify the figure, so it must not compete with it.

### 4. The chart gets a Net worth / Investments toggle

`reconstructSeries` already accumulates its total in separate blocks —
manual holdings, synced holdings, then manual cash and synced balances. It will
carry two running numbers per day instead of one and emit both.

```ts
/** A reconstructed day: net worth, and the invested part of it. */
export interface ValuePoint extends SeriesPoint {
  /** Holdings only — unmoved by deposits, withdrawals or card balances. */
  invested: number;
}
```

A new interface rather than an optional field on `SeriesPoint`: optional means
a caller can forget to set it and get `undefined` plotted as a gap.
`toValueSeries` in `series.ts` keeps returning plain `SeriesPoint[]`.

The card gains a second `Segmented` control beside the existing 1M/3M one,
switching the plotted `dataKey` between `value` and `invested`.

**The subtitle changes with the mode.** The existing text explains that the
line is rebuilt from holdings, prices *and cash movements*, and that share
counts are today's. In Investments mode the cash-movements clause is wrong and
must go; the share-count caveat still applies, because the synced-holdings
assumption is what bounds the window to 90 days either way.

Net worth remains the default mode, so the screen opens showing what it shows
today.

## Architecture

No new seams. All four changes land in existing files, and every figure stays
derived in a pure function that a test can reach without React or network.

| File | Change |
| --- | --- |
| `src/domain/summary.ts` | the denominator |
| `src/domain/types.ts` | `ValuePoint` |
| `src/domain/history.ts` | accumulate `invested` alongside `value` |
| `src/data/useValueSeries.ts` | return type widens to `ValuePoint[]` |
| `src/features/dashboard/Headline.tsx` | **new** — the headline row, extracted |
| `src/features/dashboard/Dashboard.tsx` | renders `Headline`, owns the mode toggle |

**The headline row moves into its own component.** `Dashboard.tsx` pulls in six
data hooks, Recharts and a colour hook, so it cannot be mounted in a test — which
is why `Dashboard.test.tsx` today tests only `exposureInputs`, a pure seam
extracted for exactly that reason. Rather than extend that workaround, the
headline becomes a component taking one `summary` prop, tested by rendering it
the way `RiskCard.test.tsx` already renders its card. This also takes roughly
thirty lines of markup out of a file that has grown to carry the chart, the
positions table and two risk cards.

`reconstructSeries` is the one function doing real work here, and it is already
long. The two accumulators are threaded through the blocks that exist rather
than restructured — this change is not the occasion to rewrite it, and a
rewrite would put the 90-day reconstruction rules at risk for no gain.

## Testing

- **`summary.test.ts`** — a portfolio with holdings up 2% and cash equal to
  holdings. The old denominator gives ~1%, the new one 2%. The case is chosen
  so a regression cannot pass it.
- **`summary.test.ts`** — a cash-only portfolio still returns 0, not NaN or
  Infinity.
- **`history.test.ts`** — a deposit mid-window moves `value` and leaves
  `invested` flat across the same two days. This is the feature stated as a
  test.
- **`history.test.ts`** — a credit-card balance is absent from `invested` and
  present in `value`.
- **`Headline.test.tsx`** — `Invested` renders; both captions carry the
  investments label; `Owed` stays hidden when nothing is owed.

## Deliberately out of scope

- **Realized gains in All time.** `summary.realized` exists and is not shown.
  Folding it in would change what All time means, and the owner asked for the
  existing figures to be made specific, not redefined.
- **A net-worth history that excludes transfers** — distinguishing a deposit
  from a market move within net worth is a different and harder job; the
  Investments line sidesteps it entirely.
- **Restructuring `reconstructSeries`.** See above.

## Open questions

None.
