# Dashboard Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Dashboard into an overview: a big value chart with Net worth / Investments / Cash / Liabilities tabs, then an accounts card, then the last 7 days of transactions.

**Architecture:** The four chart lines all come from the existing `reconstructSeries`, which gains `cash` and `liabilities` per point. Two new pure functions in `src/domain/overview.ts` shape the accounts card and the 7-day list. Three small presentational components replace `Headline`, the inline chart and the positions table; the risk cards move to Holdings unchanged.

**Tech Stack:** React 19, TypeScript, Recharts, TanStack Query, Vitest + Testing Library. Spec: `docs/superpowers/specs/2026-10-21-dashboard-overview-design.md`.

**Shell notes (this machine):** run Vitest as `npx vitest run <path> > "$TMP/v.txt" 2>&1; tail -30 "$TMP/v.txt"` (piping into tail hangs). Cargo needs `export PATH="$HOME/.cargo/bin:$PATH"`. Never commit `src-tauri/Cargo.toml`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File map

| File | Change |
| --- | --- |
| `src/domain/types.ts` | `ValuePoint` gains `cash`, `liabilities` |
| `src/domain/history.ts` | computes them |
| `src/domain/history.test.ts` | new describe block |
| `src/domain/overview.ts` (+ test) | new: `accountOverview`, `recentActivity`, `activityWindowStart` |
| `src/features/dashboard/ValueCard.tsx` (+ test) | new: tabs + chart, owns `CHART_MODES` |
| `src/features/dashboard/AccountsCard.tsx`, `RecentActivityCard.tsx` (+ tests) | new |
| `src/features/dashboard/Dashboard.tsx` | rewritten to wire hooks to three cards |
| `src/features/dashboard/Headline.tsx` (+ test), `Dashboard.test.tsx` | deleted (replaced by ValueCard tests; `exposureInputs` test moves) |
| `src/features/dashboard/RiskCard*`, `MarketExposureCard*` | `git mv` to `src/features/holdings/` |
| `src/features/holdings/Holdings.tsx` | renders both risk cards |
| `src/styles.css` | `.value-tabs`, `.acct-*` rules |
| `docs/HANDOFF.md` | Dashboard and Risk entries |

---

### Task 1: cash and liabilities on every chart point

**Files:** Modify `src/domain/types.ts`, `src/domain/history.ts`; Test `src/domain/history.test.ts`

- [ ] **Step 1: failing tests** — append to `history.test.ts` (helpers `acct`, `price`, `bank`, `TODAY`, `base` already exist there):

```ts
describe("reconstructSeries — cash and liabilities", () => {
  const prices = [price(10, "2026-09-03", 100), price(10, TODAY, 100)];

  it("splits manual cash from manual card debt, owed as a positive amount", () => {
    const checking = acct(1, "Checking", "cash", "manual", null);
    const card = acct(2, "Card", "credit", "manual", null);
    const txns: Transaction[] = [
      { id: 1, account_id: 1, security_id: null, type: "deposit", date: "2026-09-01",
        quantity: 0, price: 0, amount: 1000, fees: 0, note: null },
      { id: 2, account_id: 2, security_id: null, type: "withdrawal", date: "2026-09-04",
        quantity: 0, price: 0, amount: 300, fees: 0, note: null },
    ];
    const s = reconstructSeries({ ...base, accounts: [checking, card], txns, synced: [], bankTxns: [], prices });
    const day3 = s.find((p) => p.date === "2026-09-03")!;
    const day5 = s.find((p) => p.date === TODAY)!;
    expect(day3).toMatchObject({ cash: 1000, liabilities: 0, value: 1000 });
    expect(day5).toMatchObject({ cash: 1000, liabilities: 300, value: 700 });
  });

  it("walks a synced card back through what has posted since", () => {
    const card = acct(1, "Card", "credit", "simplefin", -500);
    const bankTxns = [bank(1, 1, "2026-09-04", -200)];
    const s = reconstructSeries({ ...base, accounts: [card], txns: [], synced: [], bankTxns, prices });
    expect(s.find((p) => p.date === "2026-09-03")?.liabilities).toBe(300);
    expect(s.find((p) => p.date === TODAY)?.liabilities).toBe(500);
  });

  it("counts a synced brokerage's uninvested balance as cash, not as investments", () => {
    const broker = acct(1, "Fidelity", "brokerage", "simplefin", 1000);
    const held: SyncedHolding[] = [
      { id: 1, account_id: 1, security_id: 10, shares: 4, cost_basis: 400, market_value: 400, as_of: TODAY },
    ];
    const s = reconstructSeries({ ...base, accounts: [broker], txns: [], synced: held, bankTxns: [], prices });
    expect(s.find((p) => p.date === TODAY)).toMatchObject({ invested: 400, cash: 600, liabilities: 0 });
  });

  it("leaves hidden accounts out of cash and liabilities", () => {
    const card = acct(1, "Card", "credit", "simplefin", -500, true);
    const savings = acct(2, "Savings", "cash", "simplefin", 900, true);
    const s = reconstructSeries({ ...base, accounts: [card, savings], txns: [], synced: [], bankTxns: [], prices });
    expect(s.every((p) => p.cash === 0 && p.liabilities === 0)).toBe(true);
  });

  it("keeps net worth equal to investments plus cash less liabilities", () => {
    const accounts = [
      acct(1, "Fidelity", "brokerage", "simplefin", 1000),
      acct(2, "Card", "credit", "simplefin", -250),
      acct(3, "Wallet", "cash", "manual", null),
    ];
    const held: SyncedHolding[] = [
      { id: 1, account_id: 1, security_id: 10, shares: 4, cost_basis: 400, market_value: 400, as_of: TODAY },
    ];
    const txns: Transaction[] = [
      { id: 1, account_id: 3, security_id: null, type: "deposit", date: "2026-09-02",
        quantity: 0, price: 0, amount: 75.5, fees: 0, note: null },
    ];
    const bankTxns = [bank(1, 2, "2026-09-04", -40), bank(2, 1, "2026-09-04", 120)];
    const s = reconstructSeries({ ...base, accounts, txns, synced: held, bankTxns, prices });
    expect(s.length).toBeGreaterThan(0);
    for (const p of s) expect(p.value).toBeCloseTo(p.invested + p.cash - p.liabilities, 6);
  });
});
```

- [ ] **Step 2:** run `npx vitest run src/domain/history.test.ts` — expect the new tests to FAIL (`cash` undefined) and TypeScript in the editor to flag the missing fields.

- [ ] **Step 3: implement.** In `types.ts`, extend `ValuePoint`:

```ts
export interface ValuePoint extends SeriesPoint {
  /** Holdings only — unmoved by deposits, withdrawals or card balances. */
  invested: number;
  /** Cash on every non-credit account, brokerage cash included. */
  cash: number;
  /** Owed on credit accounts, as a positive amount: the line rises with the debt. */
  liabilities: number;
}
```

In `history.ts`: after `isSynced`, add
`const isCredit = new Set(accounts.filter((a) => a.type === "credit").map((a) => a.id));`.
In the per-date loop declare `let cash = 0; let liabilities = 0;` beside `invested`, then

```ts
    // Manual cash: every cash effect up to and including the day.
    for (const t of txns) {
      if (t.date > date || isSynced.has(t.account_id)) continue;
      const effect = cashEffect(t);
      value += effect;
      if (isCredit.has(t.account_id)) liabilities -= effect;
      else cash += effect;
    }
```

and in the synced-accounts loop replace the last line with

```ts
      const balance = a.synced_balance - accountHoldings - posted;
      value += balance;
      // A card balance is negative; owed is kept positive so its line rises with the debt.
      if (isCredit.has(a.id)) liabilities -= balance;
      else cash += balance;
```

and push `{ date, value, invested, cash, liabilities }`. Extend the doc comment's last paragraph: "`cash` and `liabilities` split the non-holdings part the same way the dashboard summary does: credit accounts are owed, everything else is cash."

- [ ] **Step 4:** run `npx vitest run src/domain/history.test.ts` — all PASS.
- [ ] **Step 5:** commit `feat(history): cash and liabilities on every value point`.

---

### Task 2: account overview and recent activity (pure)

**Files:** Create `src/domain/overview.ts`, `src/domain/overview.test.ts`

- [ ] **Step 1: failing tests** in `overview.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accountOverview, recentActivity, activityWindowStart } from "./overview";
import type { AccountBreakdown } from "./portfolio";
import type { Account, BankTransaction, Security, Transaction } from "./types";

function acct(id: number, name: string, type: Account["type"], hidden = false): Account {
  return { id, name, type, institution: null, currency: "USD", created_at: "", source: "manual",
    external_id: null, synced_balance: null, last_synced_at: null, hidden };
}
const row = (account: Account, value: number): AccountBreakdown =>
  ({ account, holdings: [], holdingsValue: 0, cash: value, value });

describe("accountOverview", () => {
  it("groups brokerage, cash and credit in that order, with totals", () => {
    const groups = accountOverview([
      row(acct(1, "Card", "credit"), -300),
      row(acct(2, "Checking", "cash"), 800),
      row(acct(3, "Roth", "brokerage"), 5000),
      row(acct(4, "Savings", "cash"), 2000),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Brokerage", "Cash", "Credit cards"]);
    expect(groups[1]).toMatchObject({ total: 2800 });
    // Largest first within a group.
    expect(groups[1].accounts.map((a) => a.account.name)).toEqual(["Savings", "Checking"]);
    expect(groups[2]).toMatchObject({ total: -300 });
  });

  it("drops empty groups and hidden accounts", () => {
    const groups = accountOverview([row(acct(1, "Old", "credit", true), -50), row(acct(2, "Checking", "cash"), 10)]);
    expect(groups.map((g) => g.label)).toEqual(["Cash"]);
  });
});

function bank(id: number, account_id: number, posted: string, amount: number, p: Partial<BankTransaction> = {}): BankTransaction {
  return { id, account_id, external_id: `e${id}`, posted, amount, description: "POS 1234 WHOLEFDS",
    payee: null, memo: null, mcc: null, pending: false, category_id: null, category_source: "auto",
    reviewed: true, note: null, removed: false, ...p };
}
function txn(id: number, account_id: number, date: string, type: Transaction["type"], p: Partial<Transaction> = {}): Transaction {
  return { id, account_id, security_id: null, type, date, quantity: 0, price: 0, amount: 0, fees: 0, note: null, ...p };
}
const securities: Security[] = [{ id: 10, ticker: "VTI", name: null, type: "etf", currency: "USD" }];
const TODAY = "2026-10-21";

describe("activityWindowStart", () => {
  it("covers today and the six days before", () => {
    expect(activityWindowStart(TODAY, 7)).toBe("2026-10-15");
  });
});

describe("recentActivity", () => {
  const accounts = [acct(1, "Checking", "cash"), acct(2, "Roth", "brokerage"), acct(3, "Hidden", "cash", true)];
  const base = { accounts, securities, today: TODAY, days: 7 };

  it("merges bank and investment transactions, newest first", () => {
    const rows = recentActivity({ ...base,
      bankTxns: [bank(1, 1, "2026-10-18", 3240, { payee: "Payroll" })],
      txns: [txn(2, 2, "2026-10-20", "buy", { security_id: 10, quantity: 5, price: 282.5 })] });
    expect(rows.map((r) => r.description)).toEqual(["Buy 5 VTI", "Payroll"]);
    expect(rows[0]).toMatchObject({ account: "Roth", amount: -1412.5, pending: false });
    expect(rows[1]).toMatchObject({ account: "Checking", amount: 3240 });
  });

  it("keeps the window's edges: today in, seven days back out", () => {
    const rows = recentActivity({ ...base, txns: [],
      bankTxns: [bank(1, 1, "2026-10-14", -1), bank(2, 1, "2026-10-15", -2), bank(3, 1, TODAY, -3), bank(4, 1, "2026-10-22", -4)] });
    expect(rows.map((r) => r.amount)).toEqual([-3, -2]);
  });

  it("leaves out hidden accounts", () => {
    const rows = recentActivity({ ...base, bankTxns: [bank(1, 3, TODAY, -9)], txns: [txn(2, 3, TODAY, "deposit", { amount: 5 })] });
    expect(rows).toEqual([]);
  });

  it("falls back to the bank description and flags pending rows", () => {
    const [r] = recentActivity({ ...base, txns: [], bankTxns: [bank(1, 1, TODAY, -84.12, { payee: "  ", pending: true })] });
    expect(r).toMatchObject({ description: "POS 1234 WHOLEFDS", pending: true });
  });

  it("names investment transactions and signs them by their cash effect", () => {
    const rows = recentActivity({ ...base, bankTxns: [], txns: [
      txn(1, 2, TODAY, "sell", { security_id: 10, quantity: 0.12345, price: 100 }),
      txn(2, 2, TODAY, "dividend", { security_id: 10, amount: 12 }),
      txn(3, 2, TODAY, "deposit", { amount: 500 }),
      txn(4, 2, TODAY, "fee", { amount: 3 }),
    ] });
    expect(rows.map((r) => [r.description, r.amount])).toEqual([
      ["Sell 0.123 VTI", 12.345], ["Dividend VTI", 12], ["Deposit", 500], ["Fee", -3],
    ]);
  });
});
```

- [ ] **Step 2:** run `npx vitest run src/domain/overview.test.ts` — FAIL (module missing).

- [ ] **Step 3: implement** `src/domain/overview.ts`:

```ts
import { cashEffect } from "./cash";
import type { AccountBreakdown } from "./portfolio";
import type { Account, AccountType, BankTransaction, Security, Transaction } from "./types";

export interface AccountGroup {
  type: AccountType;
  label: string;
  total: number;
  accounts: { account: Account; value: number }[];
}

// Named for the account type, not the chart's measures: a brokerage account's
// cash sits here under Brokerage but counts toward the Cash tab, so a group
// called "Investments" would claim a total it does not have.
const GROUPS: { type: AccountType; label: string }[] = [
  { type: "brokerage", label: "Brokerage" },
  { type: "cash", label: "Cash" },
  { type: "credit", label: "Credit cards" },
];

/** Visible accounts by type, largest first, with a total per type. */
export function accountOverview(byAccount: AccountBreakdown[]): AccountGroup[] {
  return GROUPS.map(({ type, label }) => {
    const accounts = byAccount
      .filter((b) => b.account.type === type && !b.account.hidden)
      .map((b) => ({ account: b.account, value: b.value }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return { type, label, accounts, total: accounts.reduce((s, a) => s + a.value, 0) };
  }).filter((g) => g.accounts.length > 0);
}

export interface ActivityRow {
  key: string;
  date: string;
  description: string;
  account: string;
  /** Money in is positive. */
  amount: number;
  pending: boolean;
}

export interface ActivityInputs {
  bankTxns: BankTransaction[];
  txns: Transaction[];
  accounts: Account[];
  securities: Security[];
  /** YYYY-MM-DD, local. */
  today: string;
  /** Window length including today. */
  days: number;
}

/** First day of a `days`-long window ending today, inclusive. */
export function activityWindowStart(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

const TYPE_LABEL: Record<Transaction["type"], string> = {
  buy: "Buy", sell: "Sell", dividend: "Dividend", deposit: "Deposit",
  withdrawal: "Withdrawal", fee: "Fee", interest: "Interest",
};

function describe(t: Transaction, tickerOf: Map<number, string>): string {
  const ticker = t.security_id != null ? tickerOf.get(t.security_id) : undefined;
  const label = TYPE_LABEL[t.type] ?? t.type;
  if (t.type === "buy" || t.type === "sell") {
    return [label, String(Number(t.quantity.toFixed(3))), ticker].filter(Boolean).join(" ");
  }
  return ticker && t.type === "dividend" ? `${label} ${ticker}` : label;
}

/**
 * Bank and manual investment transactions in the window, across visible
 * accounts, newest first. Investment rows carry their cash effect, so a buy
 * reads as money out, the way it does in the account.
 */
export function recentActivity(i: ActivityInputs): ActivityRow[] {
  const nameOf = new Map(i.accounts.filter((a) => !a.hidden).map((a) => [a.id, a.name]));
  const tickerOf = new Map(i.securities.map((s) => [s.id, s.ticker]));
  const from = activityWindowStart(i.today, i.days);
  const inWindow = (date: string) => date >= from && date <= i.today;

  const rows: ActivityRow[] = [];
  for (const t of i.bankTxns) {
    const account = nameOf.get(t.account_id);
    const date = t.posted.slice(0, 10);
    if (account == null || !inWindow(date)) continue;
    rows.push({ key: `b${t.id}`, date, account, amount: t.amount, pending: t.pending,
      description: t.payee?.trim() || t.description });
  }
  for (const t of i.txns) {
    const account = nameOf.get(t.account_id);
    const date = t.date.slice(0, 10);
    if (account == null || !inWindow(date)) continue;
    rows.push({ key: `t${t.id}`, date, account, amount: cashEffect(t), pending: false,
      description: describe(t, tickerOf) });
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
```

- [ ] **Step 4:** run the test — PASS. (If `12.345` trips on float, the sell is `0.12345 * 100`; use `toBeCloseTo` per row instead.)
- [ ] **Step 5:** commit `feat(overview): account groups and the last 7 days of activity`.

---

### Task 3: ValueCard (tabs are the headline)

**Files:** Create `src/features/dashboard/ValueCard.tsx`, `ValueCard.test.tsx`; Modify `src/styles.css`

- [ ] **Step 1: failing test** `ValueCard.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ValueCard, CHART_MODES, MODE_ORDER, yAxisMin } from "./ValueCard";
import type { PortfolioSummary } from "../../domain/types";

function summary(p: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return { totalValue: 142318.44, investedValue: 98204, cash: 46114.44, liabilities: -2000,
    totalCostBasis: 79757, unrealized: 18447, unrealizedPct: 23.1, realized: 0,
    dayChange: 1204, dayChangePct: 1.24, ...p };
}

describe("ValueCard", () => {
  it("shows the four measures as tabs, net worth as the serif hero", () => {
    render(<ValueCard summary={summary()} series={[]} />);
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label")))
      .toEqual(["Net worth", "Investments", "Cash", "Liabilities"]);
    expect(screen.getByText("$142,318")).toBeInTheDocument();
    expect(screen.getByText(".44")).toBeInTheDocument();
    expect(screen.getByText("$98,204.00")).toBeInTheDocument();
    expect(screen.getByText("$46,114.44")).toBeInTheDocument();
  });

  it("puts today and all time under Investments, which is what they measure", () => {
    render(<ValueCard summary={summary()} series={[]} />);
    const tab = screen.getByRole("tab", { name: "Investments" });
    expect(tab).toHaveTextContent("+$1,204.00 today");
    expect(tab).toHaveTextContent("+$18,447.00 all time");
  });

  it("shows liabilities negative and red, even when nothing is owed", () => {
    const { rerender } = render(<ValueCard summary={summary()} series={[]} />);
    expect(screen.getByText("-$2,000.00")).toHaveClass("neg");
    rerender(<ValueCard summary={summary({ liabilities: 0 })} series={[]} />);
    expect(screen.getByRole("tab", { name: "Liabilities" })).toBeInTheDocument();
  });

  it("selects net worth first, and a tab swaps the caveat", () => {
    render(<ValueCard summary={summary()} series={[]} />);
    expect(screen.getByRole("tab", { name: "Net worth" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Cash" }));
    expect(screen.getByRole("tab", { name: "Cash" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(CHART_MODES.cash.subtitle)).toBeInTheDocument();
  });
});

// dataKey and caveat are two encodings of one choice, kept in one table so a
// line can never be plotted under another line's caveat.
describe("CHART_MODES", () => {
  it("plots a different field, and states a different caveat, per mode", () => {
    expect(MODE_ORDER.map((m) => CHART_MODES[m].dataKey)).toEqual(["value", "invested", "cash", "liabilities"]);
    expect(new Set(MODE_ORDER.map((m) => CHART_MODES[m].subtitle)).size).toBe(4);
    // Only the net-worth line is rebuilt from all cash movements.
    expect(CHART_MODES.networth.subtitle).toMatch(/cash movements/);
    expect(CHART_MODES.invested.subtitle).not.toMatch(/cash movements/);
  });
});

describe("yAxisMin", () => {
  it("zooms to the data and still shows a negative minimum", () => {
    expect(yAxisMin(1000)).toBeCloseTo(970);
    expect(yAxisMin(-100)).toBeCloseTo(-103);
  });
});
```

Check `money` renders negatives as `-$2,000.00` (see `src/ui/format.ts`); adjust the expected string to what `money(-2000)` returns.

- [ ] **Step 2:** run `npx vitest run src/features/dashboard/ValueCard.test.tsx` — FAIL (module missing).

- [ ] **Step 3: implement** `ValueCard.tsx`. Moves `Range`, `WINDOW_DAYS`, `clipSeries`, `ChartTip` and the chart JSX out of `Dashboard.tsx` unchanged except: height 380, `domain={[yAxisMin, (max) => max * 1.02]}`, and the `dataKey` from the selected mode. Tabs:

```tsx
export type Mode = "networth" | "invested" | "cash" | "liabilities";
export const MODE_ORDER: Mode[] = ["networth", "invested", "cash", "liabilities"];

const SHARE_CAVEAT = "Share counts are today’s — SimpleFIN does not report holdings history.";
export const CHART_MODES: Record<Mode, { label: string; dataKey: keyof ValuePoint; subtitle: string }> = {
  networth: { label: "Net worth", dataKey: "value",
    subtitle: `Rebuilt from your holdings, prices and cash movements. ${SHARE_CAVEAT}` },
  invested: { label: "Investments", dataKey: "invested",
    subtitle: `Your holdings’ market value, rebuilt from daily closes. A deposit does not move this line. ${SHARE_CAVEAT}` },
  cash: { label: "Cash", dataKey: "cash",
    subtitle: "Your cash balances, walked back from today through the transactions posted since. Brokerage cash is included." },
  liabilities: { label: "Liabilities", dataKey: "liabilities",
    subtitle: "What you owe on credit accounts, walked back from today’s balance through the transactions posted since." },
};

/** The axis floor: zoomed to the data, and below zero when the data is. */
export function yAxisMin(min: number): number {
  return min >= 0 ? min * 0.97 : min * 1.03;
}

function figure(mode: Mode, s: PortfolioSummary): number {
  return { networth: s.totalValue, invested: s.investedValue, cash: s.cash, liabilities: s.liabilities }[mode];
}
```

Tab markup (`role="tablist"` wrapper `.value-tabs`; each a `<button role="tab" aria-selected aria-label={label}>`): `.cap` label, then for networth `<div className="hero-value">{dollars}<span className="hero-cents">.{cents}</span></div>`, otherwise `<div className={`n value-tab-figure ${mode === "liabilities" && fig !== 0 ? "neg" : ""}`}>{money(fig)}</div>`; for invested also `<div className="value-tab-sub"><span className={dayChange >= 0 ? "pos" : "neg"}>{sign}{money(dayChange)} today</span> · <span className={…}>{sign}{money(unrealized)} all time</span></div>`. Card: `<Card subtitle={CHART_MODES[mode].subtitle} actions={<Segmented<Range> …1M/3M/>}>` with the tabs rendered above the chart inside the card body (the card title is dropped: the tabs are the title). The liabilities-zero case renders `money(0)` without `neg`; the test `toHaveClass("neg")` targets the -2000 case.

CSS in `src/styles.css` beside `.headline` (and delete the four `.headline*` rules):

```css
.value-tabs { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; gap: 18px; margin-bottom: 14px; }
.value-tabs button {
  background: none; border: 0; border-bottom: 2px solid var(--line); padding: 2px 0 10px; text-align: left;
  font: inherit; color: var(--ink); cursor: pointer; display: grid; gap: 4px; align-content: end;
}
.value-tabs button[aria-selected="true"] { border-bottom-color: var(--accent); }
.value-tab-figure { font-size: 19px; font-weight: 600; }
.value-tab-sub { font-size: 11px; color: var(--mut); }
@media (max-width: 900px) { .value-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
```

- [ ] **Step 4:** run the test — PASS.
- [ ] **Step 5:** commit `feat(dashboard): ValueCard with net worth, investments, cash and liabilities`.

---

### Task 4: AccountsCard and RecentActivityCard

**Files:** Create `src/features/dashboard/AccountsCard.tsx`, `RecentActivityCard.tsx`, `OverviewCards.test.tsx`

- [ ] **Step 1: failing test** `OverviewCards.test.tsx` (MemoryRouter because both cards link):

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { AccountsCard } from "./AccountsCard";
import { RecentActivityCard } from "./RecentActivityCard";
import type { AccountGroup, ActivityRow } from "../../domain/overview";
import type { Account } from "../../domain/types";

const acct = (id: number, name: string, type: Account["type"], institution: string | null): Account =>
  ({ id, name, type, institution, currency: "USD", created_at: "", source: "manual", external_id: null,
     synced_balance: null, last_synced_at: null, hidden: false });

describe("AccountsCard", () => {
  it("lists each group with its total, then its accounts", () => {
    const groups: AccountGroup[] = [
      { type: "cash", label: "Cash", total: 8020, accounts: [{ account: acct(1, "Checking", "cash", "Chase"), value: 8020 }] },
      { type: "credit", label: "Credit cards", total: -2690, accounts: [{ account: acct(2, "Sapphire", "credit", null), value: -2690 }] },
    ];
    render(<MemoryRouter><AccountsCard groups={groups} /></MemoryRouter>);
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getAllByText("$8,020.00")).toHaveLength(2);
    expect(screen.getByText("Chase")).toBeInTheDocument();
    expect(screen.getAllByText("-$2,690.00")[0]).toHaveClass("neg");
  });

  it("points to Accounts when there are none", () => {
    render(<MemoryRouter><AccountsCard groups={[]} /></MemoryRouter>);
    expect(screen.getByText("No accounts yet")).toBeInTheDocument();
  });
});

describe("RecentActivityCard", () => {
  it("shows each row, with money in marked positive and pending flagged", () => {
    const rows: ActivityRow[] = [
      { key: "b1", date: "2026-10-20", description: "Whole Foods", account: "Sapphire", amount: -84.12, pending: true },
      { key: "b2", date: "2026-10-18", description: "Payroll", account: "Checking", amount: 3240, pending: false },
    ];
    render(<MemoryRouter><RecentActivityCard rows={rows} /></MemoryRouter>);
    expect(screen.getByText("Whole Foods")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("+$3,240.00")).toHaveClass("pos");
  });

  it("says so when the week was quiet", () => {
    render(<MemoryRouter><RecentActivityCard rows={[]} /></MemoryRouter>);
    expect(screen.getByText("No transactions in the last 7 days")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2:** run — FAIL.

- [ ] **Step 3: implement.**

`AccountsCard.tsx`:

```tsx
import { Link } from "react-router-dom";
import { money } from "../../ui/format";
import { Card, EmptyState } from "../../ui/components";
import type { AccountGroup } from "../../domain/overview";

/** Every visible account by type, with each type's total. */
export function AccountsCard({ groups }: { groups: AccountGroup[] }) {
  return (
    <Card title="Accounts" actions={<Link to="/accounts" style={{ fontSize: 11, fontWeight: 600 }}>Manage</Link>}>
      {groups.length === 0 ? (
        <EmptyState title="No accounts yet"
          body={<>Add one in <Link to="/accounts">Accounts</Link>, or connect SimpleFIN in <Link to="/settings">Settings</Link>.</>} />
      ) : groups.map((g) => (
        <div key={g.type} className="acct-group">
          <div className="acct-group-head">
            <span className="cap">{g.label}</span>
            <span className={`n ${g.total < 0 ? "neg" : ""}`}>{money(g.total)}</span>
          </div>
          {g.accounts.map(({ account, value }) => (
            <div key={account.id} className="acct-row">
              <span>{account.name}{account.institution && <span className="muted"> · <span>{account.institution}</span></span>}</span>
              <span className={`n ${value < 0 ? "neg" : ""}`}>{money(value)}</span>
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}
```

`RecentActivityCard.tsx`:

```tsx
import { Link } from "react-router-dom";
import { money, fmtDate } from "../../ui/format";
import { Badge, Card, EmptyState } from "../../ui/components";
import type { ActivityRow } from "../../domain/overview";

/** Bank and investment transactions from the last week, read-only. */
export function RecentActivityCard({ rows }: { rows: ActivityRow[] }) {
  return (
    <Card title="Last 7 days" actions={<Link to="/spending" style={{ fontSize: 11, fontWeight: 600 }}>View in Spending</Link>}>
      {rows.length === 0 ? (
        <EmptyState title="No transactions in the last 7 days" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th className="left">Date</th><th className="left">Description</th><th className="left">Account</th><th>Amount</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="left muted">{fmtDate(r.date)}</td>
                  <td className="left">{r.description}{r.pending && <> <Badge tone="warn">Pending</Badge></>}</td>
                  <td className="left muted">{r.account}</td>
                  <td className={r.amount > 0 ? "pos" : undefined}>{r.amount > 0 ? "+" : ""}{money(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
```

CSS:

```css
.acct-group + .acct-group { margin-top: 10px; }
.acct-group-head { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--line); }
.acct-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--line-soft); }
.acct-row:last-child { border-bottom: 0; }
```

- [ ] **Step 4:** run — PASS. **Step 5:** commit `feat(dashboard): accounts and last-7-days cards`.

---

### Task 5: move the risk cards to Holdings

**Files:** `git mv` `src/features/dashboard/{RiskCard,MarketExposureCard}{.tsx,.test.tsx}` → `src/features/holdings/`; Modify `Holdings.tsx`, `MarketExposureCard.tsx`, `MarketExposureCard.test.tsx`

- [ ] **Step 1:** `git mv` the four files. Imports are `../../…`, the same depth, so they still resolve.
- [ ] **Step 2: failing test** — move the `exposureInputs` describe block from `Dashboard.test.tsx` into `MarketExposureCard.test.tsx`, importing `exposureInputs` from `./MarketExposureCard` (plus `Aligned` and `PortfolioSummary` types). Run it — FAIL (not exported).
- [ ] **Step 3:** move `exposureInputs` (with its doc comment) from `Dashboard.tsx` into `MarketExposureCard.tsx`, exported. In `Holdings.tsx`, call `const { aligned, isLoading: riskLoading } = useRiskSeries(holdings);` right after `usePortfolio()` (before the loading return, hooks must not be conditional), compute `const exposure = marketExposure(exposureInputs(aligned, summary));`, and after the per-account cards render `<RiskCard holdings={holdings} cash={summary.cash} />` and `<MarketExposureCard exposure={exposure} isLoading={riskLoading} />`.
- [ ] **Step 4:** run `npx vitest run src/features/holdings` — PASS. **Step 5:** commit `refactor: Concentration and Market exposure move to Holdings`.

---

### Task 6: the slimmed Dashboard

**Files:** Rewrite `src/features/dashboard/Dashboard.tsx`; delete `Headline.tsx`, `Headline.test.tsx`, `Dashboard.test.tsx` (its two blocks now live in ValueCard and MarketExposureCard tests)

- [ ] **Step 1:** write `Dashboard.tsx`:

```tsx
import { useMemo } from "react";
import { localIsoDate } from "../../domain/dates";
import { usePortfolio } from "../../data/usePortfolio";
import { useBankTransactions, useSecurities, useTransactions } from "../../data/queries";
import { useValueSeries } from "../../data/useValueSeries";
import { accountOverview, activityWindowStart, recentActivity } from "../../domain/overview";
import { ValueCard } from "./ValueCard";
import { AccountsCard } from "./AccountsCard";
import { RecentActivityCard } from "./RecentActivityCard";

/** How far back the activity list reaches, today included. */
const ACTIVITY_DAYS = 7;

/** An overview: what it is worth over time, where it sits, and what moved this week. */
export function Dashboard() {
  const { summary, byAccount, accounts, isLoading } = usePortfolio();
  const { series } = useValueSeries();
  const today = localIsoDate();
  const { data: bankTxns = [] } = useBankTransactions(activityWindowStart(today, ACTIVITY_DAYS), today);
  const { data: txns = [] } = useTransactions();
  const { data: securities = [] } = useSecurities();

  const groups = useMemo(() => accountOverview(byAccount), [byAccount]);
  const activity = useMemo(
    () => recentActivity({ bankTxns, txns, accounts, securities, today, days: ACTIVITY_DAYS }),
    [bankTxns, txns, accounts, securities, today],
  );

  if (isLoading) return <p className="muted">Loading…</p>;
  return (
    <>
      <ValueCard summary={summary} series={series} />
      <AccountsCard groups={groups} />
      <RecentActivityCard rows={activity} />
    </>
  );
}
```

- [ ] **Step 2:** `git rm` the three files; `grep -rn "Headline\|headline" src` must return nothing.
- [ ] **Step 3:** `npx tsc --noEmit -p .` and `npx vitest run` — both clean.
- [ ] **Step 4:** commit `feat(dashboard): an overview — chart, accounts, last 7 days`.

---

### Task 7: docs and full verification

- [ ] Update `docs/HANDOFF.md`: Dashboard bullet → four-tab value card (tabs carry the figures; today/all time sit under Investments and measure investments only), accounts by type, last 7 days of bank + investment transactions; Risk bullet → "a Concentration card on the Holdings page"; the caveats section's chart-mode notes cover the cash and liabilities lines.
- [ ] `npx vitest run > "$TMP/v.txt" 2>&1` — all pass.
- [ ] `export PATH="$HOME/.cargo/bin:$PATH"; cd src-tauri && cargo test` — all pass (no Rust changes expected).
- [ ] Commit `docs(handoff): the Dashboard as an overview`.
