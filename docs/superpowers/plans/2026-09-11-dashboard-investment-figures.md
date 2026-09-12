# Dashboard Investment Figures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dashboard's Today and All time figures describe the investments alone, add Invested beside Cash and Owed, and let the value chart plot investments without cash movements.

**Architecture:** Four small changes in existing pure functions plus one component extraction. `buildSummary` changes one denominator. `reconstructSeries` carries a second accumulator and emits a new `ValuePoint` type. The headline row moves out of `Dashboard.tsx` into its own `Headline.tsx` so it can be tested by rendering props rather than mounting the whole screen with its hooks and charts.

**Tech Stack:** React 19 + TypeScript, Vitest, @testing-library/react, Recharts.

**Spec:** `docs/superpowers/specs/2026-09-11-dashboard-investment-figures-design.md`

---

## Conventions used throughout

- TypeScript tests run with `npx vitest run <path>`.
- The full suite runs with `npm test`.
- Every figure returns 0 rather than `NaN` or `Infinity` when it cannot be
  computed — see the header of `src/domain/risk.ts` for why this project is
  strict about it.
- Commit after each task, never mid-task.

### Names defined once, used everywhere

| Name | Defined in | Shape |
| --- | --- | --- |
| `ValuePoint` | Task 2 | `{ date, value, invested }` — one reconstructed day |
| `Headline` | Task 3 | takes a single `summary: PortfolioSummary` prop |
| `Mode` | Task 4 | `"networth"` or `"invested"` — which line the chart plots |

---

## Task 1: Today's percentage divides by invested value alone

`dayChangePct` currently divides by `priorInvested + cash + liabilities`, so
cash waters the percentage down. The dollar figure is already correct and must
not change.

**Files:**
- Modify: `src/domain/summary.ts:30-41`
- Test: `src/domain/summary.test.ts`

- [ ] **Step 1: Write the failing test**

Add these two cases inside the existing `describe("buildSummary", ...)` block in
`src/domain/summary.test.ts`, after the last `it(...)`:

```ts
  it("measures the day change against invested value, not net worth", () => {
    // Holdings rose 2%: 10 shares from 100 to 102. Cash equals the holdings,
    // so the old denominator (invested + cash) would report about half the
    // real move. This case exists to make that regression impossible.
    const holdings = [h({
      security_id: 1, shares: 10, lastPrice: 102, marketValue: 1020,
      costBasis: 1000, unrealized: 20,
    })];
    const prev = new Map([[1, 100]]);
    const s = buildSummary(holdings, 1000, prev);

    expect(s.dayChange).toBeCloseTo(20, 6);      // unchanged: 10 * (102 - 100)
    expect(s.dayChangePct).toBeCloseTo(2, 6);    // 20 / 1000, not 20 / 2000
  });

  it("reports no day change percentage for a portfolio of pure cash", () => {
    const s = buildSummary([], 5000, new Map());
    expect(s.dayChange).toBe(0);
    expect(s.dayChangePct).toBe(0);
    expect(Number.isFinite(s.dayChangePct)).toBe(true);
  });
```

- [ ] **Step 2: Fix the existing assertion that pins the old behaviour**

The first test in the file asserts the diluted denominator and will fail
correctly once the code changes. In `src/domain/summary.test.ts`, replace this
line:

```ts
    expect(s.dayChangePct).toBeCloseTo((50 / 1750) * 100, 6); // vs prior invested+cash
```

with:

```ts
    expect(s.dayChangePct).toBeCloseTo((50 / 1250) * 100, 6); // vs prior invested only
```

Leave the third test ("keeps a consistent baseline...") exactly as it is. It
passes `cash: 0`, so its baseline of 2250 is already invested-only and its
expectation is unchanged. Do not touch it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/domain/summary.test.ts`

Expected: FAIL. Two failures — the new "measures the day change against
invested value" case reporting about `1` where `2` is expected, and the edited
first test reporting the 1750-based figure.

- [ ] **Step 4: Change the denominator**

In `src/domain/summary.ts`, replace this block:

```ts
  // Debts are negative, so they simply join the sum: net worth is what you own
  // minus what you owe.
  const priorTotal = priorInvested + cash + liabilities;
  const totalValue = investedValue + cash + liabilities;
```

with:

```ts
  // Debts are negative, so they simply join the sum: net worth is what you own
  // minus what you owe.
  const totalValue = investedValue + cash + liabilities;
```

Then replace this line:

```ts
    dayChangePct: hasPrev && priorTotal > 0 ? (dayChange / priorTotal) * 100 : 0,
```

with:

```ts
    // Measured against invested value alone. Dividing by net worth would let a
    // cash balance shrink the percentage, so a 2% day would read as 1% purely
    // because the owner keeps savings beside the portfolio.
    dayChangePct: hasPrev && priorInvested > 0 ? (dayChange / priorInvested) * 100 : 0,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/domain/summary.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/domain/summary.ts src/domain/summary.test.ts
git commit -m "fix(dashboard): measure the day change against invested value"
```

---

## Task 2: The reconstructed series carries invested value

`reconstructSeries` accumulates one running total per day, mixing holdings with
cash and card balances. It will carry two, so the chart can plot either.

**Files:**
- Modify: `src/domain/types.ts:42`
- Modify: `src/domain/history.ts:88-141`
- Modify: `src/data/useValueSeries.ts`
- Test: `src/domain/history.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this new `describe` block to the end of `src/domain/history.test.ts`. It
reuses the `acct`, `price` and `base` helpers already defined at the top of that
file.

```ts
describe("reconstructSeries — invested apart from cash", () => {
  const brokerage = acct(1, "Brokerage", "brokerage", "manual", null);
  // Deposit 1000 and buy 2 shares at 100 on the 1st. Deposit another 1000 on
  // the 3rd — a paycheck. The price never moves.
  const txns: Transaction[] = [
    { id: 1, account_id: 1, security_id: 10, type: "deposit", date: "2026-09-01",
      quantity: 0, price: 0, amount: 1000, fees: 0, note: null },
    { id: 2, account_id: 1, security_id: 10, type: "buy", date: "2026-09-01",
      quantity: 2, price: 100, amount: 200, fees: 0, note: null },
    { id: 3, account_id: 1, security_id: 10, type: "deposit", date: "2026-09-03",
      quantity: 0, price: 0, amount: 1000, fees: 0, note: null },
  ];
  const prices = [
    price(10, "2026-09-01", 100), price(10, "2026-09-03", 100), price(10, "2026-09-05", 100),
  ];
  const series = () => reconstructSeries({
    ...base, accounts: [brokerage], txns, synced: [], bankTxns: [], prices,
  });

  it("counts only holdings in invested", () => {
    const day = series().find((p) => p.date === "2026-09-01");
    expect(day?.invested).toBe(200);  // 2 shares at 100
    expect(day?.value).toBe(1000);    // plus 800 cash left over
  });

  it("leaves invested flat when a deposit lands", () => {
    const s = series();
    const before = s.find((p) => p.date === "2026-09-01");
    const after = s.find((p) => p.date === "2026-09-03");
    // This is the whole point of the feature: a paycheck moves net worth and
    // must not move the investment line.
    expect(after?.invested).toBe(before?.invested);
    expect(after?.value).toBe((before?.value ?? 0) + 1000);
  });

  it("keeps a credit-card balance out of invested and in value", () => {
    const card = acct(2, "Card", "credit", "simplefin", -500);
    const s = reconstructSeries({
      ...base, accounts: [brokerage, card], txns, synced: [], bankTxns: [], prices,
    });
    const day = s.find((p) => p.date === "2026-09-05");
    expect(day?.invested).toBe(200);
    expect(day?.value).toBe(2000 - 500);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/history.test.ts`

Expected: FAIL. The three new cases report `undefined` for `invested`, and
TypeScript flags the property as missing on `SeriesPoint`.

- [ ] **Step 3: Add the `ValuePoint` type**

In `src/domain/types.ts`, leave the existing `SeriesPoint` on line 42 as it is
and add the new interface directly below it:

```ts
/**
 * One reconstructed day: net worth, and the invested part of it.
 *
 * A separate interface rather than an optional field on `SeriesPoint`, because
 * optional means a caller can forget to set it and plot `undefined` as a gap.
 */
export interface ValuePoint extends SeriesPoint {
  /** Holdings only — unmoved by deposits, withdrawals or card balances. */
  invested: number;
}
```

- [ ] **Step 4: Accumulate invested alongside value**

In `src/domain/history.ts`, add the new type to the import on line 2:

```ts
import type { Account, BankTransaction, SyncedHolding, Transaction, ValuePoint } from "./types";
```

`SeriesPoint` is dropped from that import — after this task nothing in the file
refers to it.

Change the return type on line 41:

```ts
export function reconstructSeries(i: HistoryInputs): ValuePoint[] {
```

Change the series declaration on line 88:

```ts
  const series: ValuePoint[] = [];
```

Now thread the second accumulator through the blocks that build a day. Replace
this line:

```ts
    let value = 0;
```

with:

```ts
    let value = 0;
    // Holdings only. Tracked beside `value` so the chart can plot investment
    // performance without a deposit reading as a gain.
    let invested = 0;
```

In the manual-holdings block, replace:

```ts
      value += shares * (close ?? lastPaid.get(securityId) ?? 0);
```

with:

```ts
      const held = shares * (close ?? lastPaid.get(securityId) ?? 0);
      value += held;
      invested += held;
```

In the synced-holdings block, replace:

```ts
      value += close != null ? h.shares * close : h.market_value;
```

with:

```ts
      const held = close != null ? h.shares * close : h.market_value;
      value += held;
      invested += held;
```

The two cash blocks add nothing to `invested` and are left alone — except for
one rename. The synced-balance block declares a local `const invested`, which
would now shadow the accumulator. Replace this:

```ts
      const invested = synced
        .filter((h) => h.account_id === a.id)
        .reduce((sum, h) => sum + h.market_value, 0);
      const posted = bankTxns
        .filter((t) => t.account_id === a.id && t.posted > date)
        .reduce((sum, t) => sum + t.amount, 0);
      value += a.synced_balance - invested - posted;
```

with:

```ts
      const accountHoldings = synced
        .filter((h) => h.account_id === a.id)
        .reduce((sum, h) => sum + h.market_value, 0);
      const posted = bankTxns
        .filter((t) => t.account_id === a.id && t.posted > date)
        .reduce((sum, t) => sum + t.amount, 0);
      value += a.synced_balance - accountHoldings - posted;
```

Finally, replace the push on line 140:

```ts
    series.push({ date, value });
```

with:

```ts
    series.push({ date, value, invested });
```

- [ ] **Step 5: Widen the hook's return type**

In `src/data/useValueSeries.ts`, change the type import on line 6:

```ts
import type { ValuePoint } from "../domain/types";
```

and the signature on line 28:

```ts
export function useValueSeries(days: number = HISTORY_DAYS): { series: ValuePoint[]; isLoading: boolean } {
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/domain/history.test.ts`

Expected: PASS. All pre-existing cases still pass — they only assert `value`,
which is unchanged — plus the three new ones.

- [ ] **Step 7: Prove the shadowing rename did not break the synced maths**

Run: `npx vitest run src/domain/history.test.ts -t "synced"`

Expected: PASS. This is the block where an account's balance has its own
holdings subtracted out to avoid counting invested dollars twice; the rename
touched that arithmetic, so it gets its own confirmation.

- [ ] **Step 8: Commit**

```bash
git add src/domain/types.ts src/domain/history.ts src/domain/history.test.ts src/data/useValueSeries.ts
git commit -m "feat(dashboard): reconstruct invested value alongside net worth"
```

---

## Task 3: Extract the headline, add Invested, label the investment figures

The headline row is inline in `Dashboard.tsx`, which cannot be mounted in a test
without its six data hooks, Recharts and a colour hook — which is why the
existing `Dashboard.test.tsx` tests only a tiny extracted seam. Moving the row
into its own component makes the new figures testable by rendering props, the
same way `RiskCard.test.tsx` already works.

**Files:**
- Create: `src/features/dashboard/Headline.tsx`
- Create: `src/features/dashboard/Headline.test.tsx`
- Modify: `src/features/dashboard/Dashboard.tsx:107-135`

- [ ] **Step 1: Write the failing test**

Create `src/features/dashboard/Headline.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Headline } from "./Headline";
import type { PortfolioSummary } from "../../domain/types";

function summary(p: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    totalValue: 142318.44, investedValue: 98204, cash: 46114.44, liabilities: -2000,
    totalCostBasis: 79757, unrealized: 18447, unrealizedPct: 23.1,
    realized: 0, dayChange: 1204, dayChangePct: 1.24, ...p,
  };
}

describe("Headline", () => {
  it("shows net worth as the hero figure", () => {
    render(<Headline summary={summary()} />);
    expect(screen.getByText("Net worth")).toBeInTheDocument();
  });

  it("shows invested value beside cash and owed", () => {
    render(<Headline summary={summary()} />);
    expect(screen.getByText("Invested")).toBeInTheDocument();
    expect(screen.getByText("$98,204.00")).toBeInTheDocument();
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("Owed")).toBeInTheDocument();
  });

  it("says that Today and All time describe the investments", () => {
    render(<Headline summary={summary()} />);
    // Without the label a reader cannot tell whether 1.24% is the investments
    // or net worth, and the two figures genuinely differ.
    expect(screen.getByText(/Today.*investments/)).toBeInTheDocument();
    expect(screen.getByText(/All time.*investments/)).toBeInTheDocument();
  });

  it("hides Owed when nothing is owed", () => {
    render(<Headline summary={summary({ liabilities: 0 })} />);
    expect(screen.queryByText("Owed")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/dashboard/Headline.test.tsx`

Expected: FAIL — cannot resolve `./Headline`.

- [ ] **Step 3: Create the component**

Create `src/features/dashboard/Headline.tsx`. The net-worth hero, Today, All
time, Cash and Owed markup is moved verbatim from `Dashboard.tsx`; `Invested` is
new, and the two captions gain their labels.

```tsx
import { money, pct } from "../../ui/format";
import type { PortfolioSummary } from "../../domain/types";

/**
 * The figures at the top of the Dashboard.
 *
 * Two groups with one meaning each. Net worth, Invested, Cash and Owed say what
 * the owner has, and Invested plus Cash minus Owed sums to the hero, so the row
 * is checkable by eye. Today and All time say how the *investments* moved,
 * which is a narrower thing than net worth — hence the labels. A deposit
 * changes the first group and must never change the second.
 *
 * Extracted from `Dashboard` so these figures can be tested by rendering props,
 * rather than mounting a screen that pulls in six data hooks and Recharts.
 */
export function Headline({ summary }: { summary: PortfolioSummary }) {
  const [dollars, cents] = money(summary.totalValue).split(".");

  return (
    <div className="headline">
      <div className="headline-figure">
        <div className="cap">Net worth</div>
        <div className="hero-value">{dollars}<span className="hero-cents">.{cents}</span></div>
      </div>
      <div className="headline-side">
        <div className="cap">Today · investments</div>
        <div className={`n ${summary.dayChange >= 0 ? "pos" : "neg"}`}>
          {summary.dayChange >= 0 ? "+" : ""}{money(summary.dayChange)} · {pct(summary.dayChangePct)}
        </div>
      </div>
      <div className="headline-side">
        <div className="cap">All time · investments</div>
        <div className={`n ${summary.unrealized >= 0 ? "pos" : "neg"}`}>
          {summary.unrealized >= 0 ? "+" : ""}{money(summary.unrealized)} · {pct(summary.unrealizedPct)}
        </div>
      </div>
      <div className="headline-side">
        <div className="cap">Invested</div>
        <div className="n">{money(summary.investedValue)}</div>
      </div>
      <div className="headline-side">
        <div className="cap">Cash</div>
        <div className="n">{money(summary.cash)}</div>
      </div>
      {summary.liabilities !== 0 && (
        <div className="headline-side">
          <div className="cap">Owed</div>
          <div className="n neg">{money(summary.liabilities)}</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/dashboard/Headline.test.tsx`

Expected: PASS, 4 tests.

If the `$98,204.00` assertion fails, read the actual rendered string from the
failure output and match what `money` really produces. Do not change the
component to suit the test.

- [ ] **Step 5: Use the component in the Dashboard**

In `src/features/dashboard/Dashboard.tsx`, add the import beside the other
dashboard-local imports (`RiskCard`, `MarketExposureCard`):

```tsx
import { Headline } from "./Headline";
```

Then delete the entire inline headline block — from `<div className="headline">`
down to and including its closing `</div>`, which is everything between the
opening `<>` and the `<Card title="Portfolio value"` that follows — and put this
in its place:

```tsx
      <Headline summary={summary} />
```

Also delete the now-unused line just above the `return`:

```tsx
  const [dollars, cents] = money(summary.totalValue).split(".");
```

- [ ] **Step 6: Verify nothing else broke**

Run: `npx tsc --noEmit`

Expected: no output. If it reports `money` as unused in `Dashboard.tsx`, remove
`money` from that file's `../../ui/format` import — but keep `pct`, which the
positions table's Gain column still uses, and keep `fmtDate`, which the chart
axis and tooltip use.

- [ ] **Step 7: Commit**

```bash
git add src/features/dashboard/Headline.tsx src/features/dashboard/Headline.test.tsx src/features/dashboard/Dashboard.tsx
git commit -m "feat(dashboard): show invested value and label the investment figures"
```

---

## Task 4: The chart toggles between net worth and investments

**Files:**
- Modify: `src/features/dashboard/Dashboard.tsx`

- [ ] **Step 1: Add the mode type and its copy**

In `src/features/dashboard/Dashboard.tsx`, below the existing `Range` and
`WINDOW_DAYS` declarations, add:

```tsx
/** Which line the value chart plots. */
type Mode = "networth" | "invested";

// The caveat has to change with the mode. The net-worth line really is rebuilt
// from cash movements, so it must say so; the investments line is not, and
// repeating the clause there would be untrue. The share-count caveat applies to
// both — today's synced share counts are assumed to have been held throughout,
// which is what bounds the window to 90 days either way.
const SUBTITLE: Record<Mode, string> = {
  networth:
    "Rebuilt from your holdings, prices and cash movements. Share counts are today’s — SimpleFIN does not report holdings history.",
  invested:
    "Your holdings’ market value, rebuilt from daily closes. A deposit does not move this line. Share counts are today’s — SimpleFIN does not report holdings history.",
};
```

- [ ] **Step 2: Add the mode state**

Directly below the existing `const [range, setRange] = useState<Range>("3m");`,
add:

```tsx
  // Net worth is the default, so the screen opens as it always has.
  const [mode, setMode] = useState<Mode>("networth");
```

- [ ] **Step 3: Render the toggle and switch the plotted key**

In the `<Card title="Portfolio value" ...>` element, replace the whole
`subtitle="..."` prop with:

```tsx
        subtitle={SUBTITLE[mode]}
```

Replace the `actions` prop so it carries both controls:

```tsx
        actions={
          <>
            <Segmented<Mode> value={mode} onChange={setMode} items={[
              { value: "networth", label: "Net worth" }, { value: "invested", label: "Investments" },
            ]} />
            <Segmented<Range> value={range} onChange={setRange} items={[
              { value: "1m", label: "1M" }, { value: "3m", label: "3M" },
            ]} />
          </>
        }
```

Then point the `<Area>` at the chosen field:

```tsx
              <Area type="monotone" dataKey={mode === "invested" ? "invested" : "value"} stroke={colors.accent} strokeWidth={1.9} fill="url(#valueFill)" />
```

- [ ] **Step 4: Confirm the tooltip follows the mode**

Read `ChartTip` at the top of the file before moving on. It takes
`payload[0].value`, which Recharts fills from whichever `dataKey` is plotted, so
it follows the mode with no change needed. Leave it alone.

Only if it instead read `payload[0].payload.value` would it be pinned to net
worth — in which case change that expression to `payload[0].value`.

- [ ] **Step 5: Widen `clipSeries` so it does not strip the new field**

`clipSeries` is typed `SeriesPoint[] -> SeriesPoint[]`, which would drop
`invested` from what reaches the chart. In `src/features/dashboard/Dashboard.tsx`
change its signature:

```tsx
function clipSeries(series: ValuePoint[], range: Range): ValuePoint[] {
```

and the type import, dropping `SeriesPoint`, which nothing in the file now uses:

```tsx
import type { Holding, PortfolioSummary, ValuePoint } from "../../domain/types";
```

- [ ] **Step 6: Verify the types are sound**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`

Expected: PASS, no failures anywhere. Task 1 changed a figure the risk cards do
not consume, and Task 2 left `value` untouched, so nothing outside the files
edited here should move.

- [ ] **Step 8: Check it in the real app**

Run: `npm run tauri dev`

Confirm four things by eye, then close the app:

1. The headline reads Net worth, Today · investments, All time · investments,
   Invested, Cash, Owed.
2. Invested plus Cash minus Owed equals Net worth.
3. Switching the chart to Investments gives a line with no vertical steps on
   paydays, and the subtitle changes with it.
4. Switching back to Net worth restores the line that was there before.

If the two `Segmented` controls crowd each other in the card header, that is a
CSS matter for the card's actions area. Note it and report it rather than
restructuring the component to work around it.

- [ ] **Step 9: Commit**

```bash
git add src/features/dashboard/Dashboard.tsx
git commit -m "feat(dashboard): plot investments without cash movements"
```

---

## Task 5: Record the change in the handoff

**Files:**
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Add the invariant**

`docs/HANDOFF.md` carries a list of rules that are easy to break by accident —
the section holding "Two rules the risk maths depends on" and the note about
`security_profile.quote_type`. Add this to that list:

```markdown
- **Today and All time on the Dashboard describe the investments, not net
  worth.** `dayChangePct` divides by `priorInvested`, never by net worth —
  dividing by net worth lets a cash balance shrink the percentage, so a 2% day
  reads as 1% purely because the owner keeps savings beside the portfolio. The
  captions say `· investments` for the same reason: the figures sit beside a
  net-worth hero while measuring something narrower. `reconstructSeries`
  carries `invested` beside `value` so the chart can plot holdings alone; a
  deposit must move `value` and leave `invested` flat, which `history.test.ts`
  pins. Spec:
  `docs/superpowers/specs/2026-09-11-dashboard-investment-figures-design.md`
```

- [ ] **Step 2: Commit**

```bash
git add docs/HANDOFF.md
git commit -m "docs: record that the Dashboard's performance figures are investments-only"
```

---

## Final verification

- [ ] `npm test` passes with no failures.
- [ ] `npx tsc --noEmit` is silent.
- [ ] `cd src-tauri && cargo test` passes. Nothing here touched Rust, so this is
      a guard against an accidental edit rather than a real risk.
- [ ] The app runs, and the four checks in Task 4 Step 8 all hold.
- [ ] `git log --oneline` shows five commits, one per task.
