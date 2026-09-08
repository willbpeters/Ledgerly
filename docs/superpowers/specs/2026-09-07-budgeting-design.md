# Ledgerly — Budgeting & Spending (design)

**Date:** 2026-09-07
**Status:** approved by owner, ready for planning
**Depends on:** SimpleFIN sync (shipped), schema v2

The other half of the product: import bank and credit-card transactions from
SimpleFIN, categorise them, and budget against those categories month by month.

## Decisions the owner made

| Question | Choice |
|---|---|
| First-version scope | Review **and** budgets: import, auto-categorise, correct categories, set a monthly limit per category with progress |
| Categories | A built-in set of ~15, fully editable (rename, add, delete) |
| Credit cards | Count against net worth, so the headline figure is assets minus debts |

Out of scope for this spec: recurring-subscription detection, splitting one
transaction across categories, multi-currency, forecasting.

## What SimpleFIN actually gives us

Verified against the live demo feed on 2026-09-07. Dropping `balances-only=1`
returns a `transactions` array per account:

```json
{ "id": "1783768170", "posted": 1783768170, "amount": "-55.50",
  "description": "Fishing bait", "payee": "John's Fishin Shack",
  "memo": "JOHNS FISHIN SHACK BAIT", "transacted_at": 1783768170, "mcc": "5812" }
```

- `amount` is a **numeric string**; negative is money out.
- `id` is stable per account, so it is the natural deduplication key.
- **`mcc` is the merchant category code** the card networks assign (5411 =
  grocery stores, 5812 = eating places). This is the backbone of
  auto-categorisation and is far more reliable than matching on text.
- `payee` and `memo` are present on the demo feed but are **optional** in the
  protocol, so nothing may depend on them existing.
- Requesting more than **45 days** returns a warning in `errors` and may be
  capped in future, so backfill pages in 45-day windows.

## Schema v3

`accounts.type` must accept `credit`. SQLite cannot alter a `CHECK`, so the
migration rebuilds the table (foreign keys off, copy, drop, rename, re-index)
inside one transaction.

```sql
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('spending','income','transfer')),
  colour TEXT NOT NULL DEFAULT 'chart-1',
  sort INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  posted TEXT NOT NULL,                 -- YYYY-MM-DD
  amount REAL NOT NULL,                 -- negative = money out
  description TEXT NOT NULL,
  payee TEXT, memo TEXT, mcc TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_source TEXT NOT NULL DEFAULT 'auto'
    CHECK (category_source IN ('auto','manual')),
  UNIQUE (account_id, external_id)
);
CREATE INDEX bank_transactions_posted ON bank_transactions(posted);

CREATE TABLE category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_type TEXT NOT NULL CHECK (match_type IN ('payee','description','mcc')),
  pattern TEXT NOT NULL,                -- lower-cased substring, or exact MCC
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  UNIQUE (match_type, pattern)
);

CREATE TABLE budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT,                           -- 'YYYY-MM', or NULL = the default that
                                        -- applies to every month
  limit_amount REAL NOT NULL,
  UNIQUE (category_id, month)
);
```

### Built-in categories (seeded once, `is_builtin = 1`)

Spending: Groceries, Dining, Transport, Fuel, Utilities, Rent & Mortgage,
Shopping, Health, Entertainment, Travel, Subscriptions, Fees, Other.
Income: Income. Transfer: Transfer.

Built-ins can be renamed and re-coloured. Deleting one is allowed; its
transactions fall back to uncategorised.

## Categorising

Runs in **Rust at sync time**, so categories are right before any screen opens.
Pure functions in `budget/categorize.rs`, fixture-tested. Precedence, first
match wins:

1. **Manual.** A transaction whose `category_source` is `manual` is never
   re-categorised by a later sync.
2. **User rule.** `category_rules` matched in order: exact `mcc`, then `payee`
   substring, then `description` substring, all case-insensitive.
3. **Built-in MCC map.** `budget/mcc.rs` maps codes and code ranges to built-in
   category names (5411 → Groceries, 5812/5814 → Dining, 5541/5542 → Fuel,
   4111–4131 → Transport, 4899/4900 → Utilities, and so on).
4. **Sign.** A positive amount with no other match → Income.
5. Otherwise **uncategorised** (`category_id` stays null).

Correcting a category in the UI sets `category_source = 'manual'` and offers
"also apply to everything from this payee", which writes a `category_rules` row
and re-categorises matching `auto` rows.

## Net worth with debts

`accounts.type` gains `credit`. In `derivePortfolio()`:

- A credit account's balance is negative and joins the total, so
  `totalValue = investedValue + cash + liabilities`.
- `summary` gains `liabilities` (a negative number, or 0). `cash` counts only
  `cash` and `brokerage` accounts, so a card balance never masquerades as cash.
- Allocation already drops non-positive values, so debts never appear as a slice.
- The Dashboard headline gains an **Owed** figure whenever `liabilities` is
  non-zero.

## Syncing transactions

`simplefin_sync` stops passing `balances-only=1` and passes
`start-date`. Two modes:

- **Incremental** (every sync): from 5 days before the newest `posted` we hold,
  which re-fetches recently posted rows so pending ones settle. Upsert on
  `(account_id, external_id)`, leaving a manual category alone.
- **Backfill** (first connect, or "Import older" in Settings): walks backwards in
  45-day windows to a chosen limit, default 365 days.

`SyncReport` gains `transactions_added` and `transactions_updated`.

## Screens

A new **Spending** entry in the icon rail replaces the disabled Budget item.

- **Spending (month view)** — month stepper; three figures (money in, money out,
  net); a list of categories, each with amount spent, its budget bar and the
  remainder; and an uncategorised count that links to the transaction list
  filtered to them. Clicking a category filters the list below.
- **Transactions** — the full list for the month, with account, date, payee,
  amount and an inline category picker. Filter by account, category or text.
- **Budgets** — set a monthly limit per category, inline in the month view.
  A limit with no month is the default for every month; editing within a month
  offers "just this month" or "every month".
- **Settings → Categories** — add, rename, recolour, delete; and a list of the
  rules you have created, each removable.

Money-out figures are shown as positive numbers under a "spent" heading rather
than as negatives, which is how Copilot reads and how people think.

## Testing

- Rust: MCC map lookups including ranges and unknown codes; the precedence
  ladder in `categorize.rs`, including manual protection and rule ordering;
  transaction upsert (insert, update, no duplicate, manual category preserved);
  the v2→v3 migration on a populated v2 database, asserting the rebuilt
  `accounts` table keeps its rows and accepts `credit`.
- TypeScript: month-window helpers; spend-by-category aggregation, including
  transfers excluded and income separated; budget progress and remainder;
  `derivePortfolio` with a credit account (net worth falls, cash unaffected,
  allocation unchanged).
- End to end with the SimpleFIN demo feed, which carries real MCC-coded
  transactions.
