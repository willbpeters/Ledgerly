# Import from Copilot

**Date:** 2026-10-15
**Status:** design agreed, not yet implemented
**TODO item:** 9b

## Goal

Let the owner retire Copilot Money. One import carries their Copilot
categories onto the transactions Ledgerly already has, brings in the two years
of older history Ledgerly never saw, and teaches Ledgerly their merchant habits
so future transactions follow them.

## What the export looks like

Checked against the owner's real export (`transactions (1).csv`, 2026-08-01,
1,869 rows, 2024-03-25 → 2026-07-31). Copilot → Settings → Account → "Export
your transactions" writes a CSV with this header, every field quoted:

```
"date","name","amount","status","category","parent category","excluded","tags","type","account","account mask","note","recurring"
```

- `date` is `YYYY-MM-DD`.
- **`amount` is positive for money out** and negative for money in — the
  opposite of Ledgerly. The import negates it.
- `status` is `posted` or `pending`; `excluded` is `true`/`false`.
- `type` is `regular`, `income` or `internal transfer`.
- `category` is the owner's own Copilot category; `parent category` is a
  Copilot grouping Ledgerly does not have and is ignored. A category can carry
  stray whitespace (`"Gifts "`), so names are trimmed.
- `account` / `account mask` name the account and its last four digits. On
  this export, **1,165 rows (every one before October 2025) have both blank**:
  accounts later removed from Copilot.
- 123 rows carry a `note`.

The owner's categories, by count: Eating Out 431, Other 359, Groceries 157,
Shops 127, Golf 92, Car 67, Subscriptions 61, Date night 48, Education 35,
Investments 29, Clothing 27, Entertainment 23, Poker 6, Gifts 6, Travel 4;
397 rows have none (278 internal transfers, 85 income, 34 regular).

### The fresh export (2026-10-15)

`transactions (2).csv`, 2,080 rows, 2024-03-25 → 2026-10-15, same header.
New since the older file: **"Robinhood Checking" (mask 2175)**; a Copilot
**"Manual account"** (10 rows, blank mask, Aug–Sep 2026), which goes to Copilot
history by the blank-mask rule; and two more categories, **"To be paid back"**
and **"Entertainment Misc"**, created like any other unknown name.

A read-only dry run of this design against the owner's database: **250
matched**, **620 added** as history to their own accounts (each account's rows
before its SimpleFIN span, which starts June–August 2026), **1,175 added** to
Copilot history, **29 skipped** inside a span with no same-amount match within
3 days, 5 pending skipped. The preview lists the skipped rows by name, date and
amount so the owner can see them.

## Decisions taken with the owner

1. **Ledgerly adopts the owner's Copilot categories.** Ones Ledgerly lacks are
   created; ones that mean the same thing map onto Ledgerly's.
2. **Older history is imported**, so Spending, budgets and later trends reach
   back to 2024. It never changes an account balance or net worth.

## Categories

| Copilot | Ledgerly |
|---|---|
| Eating Out | Dining |
| Groceries | Groceries |
| Shops | Shopping |
| Subscriptions | Subscriptions |
| Entertainment | Entertainment |
| Travel | Travel |
| Other | Other |
| Golf, Car, Date night, Education, Poker, Gifts, Clothing | **created**, kind `spending` |
| Investments | **created**, kind `transfer` |
| *(blank)*, type `internal transfer` | Transfer |
| *(blank)*, type `income` | Income |
| *(blank)*, type `regular` | uncategorised |

Any other name in a future export is created as a `spending` category with that
name, so nothing the owner set is lost. **Investments is a transfer kind**: all
29 rows are money moved into the owner's own investment accounts, which
Spending already treats as moving money, not spending it. Its kind can be
changed in Settings like any category.

Created categories get the next free `sort` after the built-ins and a colour
from the existing `chart-1…6` tokens, cycling.

A Copilot `type` of `internal transfer` wins over its category: such a row is
always Transfer.

## Accounts

A Copilot row's account is found by its **mask**: the Ledgerly account whose
name ends with `(mask)` — every SimpleFIN account name does ("Card (9849)",
"Savings (5979)"). On the owner's data this maps all five named Copilot
accounts. Rows whose mask is blank, or matches no Ledgerly account, go to one
**"Copilot history"** account, created on first need as a manual `cash`
account. It carries bank transactions only, so its balance and its effect on
net worth are zero; it appears in Accounts so the history is visible and can be
hidden there.

## Matching versus adding

For each Copilot row (after skipping `pending` and `excluded` rows):

- **Inside the span Ledgerly already holds for that account** (on or after the
  account's earliest SimpleFIN transaction), the row is **matched, never
  added**: the Ledgerly transaction in the same account with the same amount to
  the cent, posted within **3 days**, not already matched, closest date first.
  A match gets the Copilot category, its note, `category_source = 'manual'` and
  `reviewed = 1`. An unmatched row here is **counted and skipped** — inside the
  span, SimpleFIN is the record, and adding would risk a duplicate.
- **Before that span** (or for the Copilot history account, always), the row
  is **added** as a bank transaction: `external_id = 'copilot:' + a hash of
  date, name, amount, mask and its position among identical rows`, `payee` and
  `description` = the Copilot name, the Copilot category as `manual`,
  `reviewed = 1`, and the note.

Running the import again changes nothing: matched rows get the same values,
added rows are found by their `external_id` and updated in place.

**When SimpleFIN later sends an older transaction** (for example after "Import
2 years") that an added Copilot row already covers — same account, same amount,
within 3 days — the sync **adopts** the Copilot row: it takes over the
SimpleFIN `external_id` and keeps the owner's category, instead of inserting a
duplicate.

## Learning the owner's habits

After the import, for every Copilot name seen at least **twice**, where at least
**90%** of its rows share one category, a **payee rule** is written (pattern:
the normalised name). Future SimpleFIN transactions from that payee then follow
the owner's Copilot habit — Haggin Oaks to Golf, not the built-in keyword's
Entertainment. **Existing rules are never overwritten**: a rule the owner
already made in Ledgerly wins.

## Notes

Schema **v7** adds `bank_transactions.note TEXT`, through
`add_column_if_missing`, with `v7_is_complete` and an entry in
`db::migration_pending`. Imported notes land there and show under the payee
in the transaction list. Editing notes in Ledgerly is TODO item 11, not this.

## The fix this depends on

A **pending** SimpleFIN transaction has `posted = 0`, and Ledgerly stores it as
`1970-01-01` (six such rows on the owner's data). The import's span rule reads
"earliest transaction per account", which those rows would break, and they are
wrong in Spending regardless. **Pending rows take their date from
`transacted_at`** when `posted` is 0; the six stored rows are repaired by the
same v7 migration from that rule (`posted` set to the date of their
`transacted_at`, which the parser already reads — the column is added to the
store if it is not there).

## Settings: "Import from Copilot"

A card under SimpleFIN:

1. **Choose Copilot export…** opens a file picker (`.csv`).
2. A **preview**, from a dry run that writes nothing: transactions matched,
   history rows to add, rows skipped (pending, excluded, unmatched inside the
   span — the unmatched ones listed by date, name and amount), categories to
   create, payee rules to learn, and the accounts each Copilot account maps to.
3. **Import** — takes a backup first (a `manual` backup, so it is listed in
   Backups and can be restored), then writes everything in **one SQLite
   transaction**: all of it lands or none of it does.
4. A result line, and a reminder that Copilot can now be cancelled once the
   owner is happy.

A CSV whose header is not Copilot's is refused with a plain message.

## Code layout

| File | Job |
|---|---|
| `src-tauri/src/budget/copilot.rs` (pure) | parse the CSV (quoted fields, doubled quotes), map categories, map accounts by mask, decide match / add / skip, compute rules. Input: CSV text plus a snapshot of accounts, transactions and categories. Output: a `Plan` the UI previews and the store applies. |
| `src-tauri/src/budget/store.rs` | `apply_copilot_plan(conn, &plan)` in one transaction; sync adopts a matching Copilot row. |
| `src-tauri/src/db.rs` | v7: `note` column, pending-date repair. |
| `src-tauri/src/simplefin/parse.rs` + `sync.rs` | pending rows dated from `transacted_at`. |
| `src-tauri/src/commands/budget.rs` | `copilot_preview(path)`, `copilot_import(path)`. |
| `src/features/settings/CopilotImportCard.tsx` (+ test) | the card. |

The matching and planning are pure and get the tests; the store applies a plan
it is handed.

## Rules this must not break

1. **Never a duplicate.** Inside SimpleFIN's span, Copilot only matches.
2. **Never a balance change.** Added rows are history; synced balances still
   come from SimpleFIN, and the Copilot history account is zero.
3. **The owner's Ledgerly choices win.** A transaction already `manual` in
   Ledgerly keeps its category (the import fills only `auto` rows and adds new
   ones); an existing payee rule is never overwritten.
4. **All or nothing**, with a backup taken first.
5. **Migrations follow the `db.rs` rules** (idempotent, `migration_pending`).

## Testing

- `copilot.rs`: header check; quoted fields and doubled quotes; sign flip;
  category mapping incl. trimming, created names and Investments as transfer;
  internal transfer beats category; account by mask, blank → history; match
  within 3 days, closest first, one-to-one; unmatched inside span skipped;
  before span added; pending/excluded skipped; stable `external_id`s with
  identical rows; rules at 2+ rows and 90%, not below.
- `store.rs`: applying a plan creates categories and the history account, sets
  manual + reviewed + note, leaves an existing manual row alone, never
  overwrites a rule; applying twice changes nothing; a sync adopts an added
  Copilot row instead of duplicating it.
- `db.rs`: v7 on a v6 database adds `note` and repairs a 1970 pending row.
- Frontend: the preview renders counts; Import is disabled until a preview.

## Out of scope

- Tags and Copilot's "recurring" links (recurring detection is TODO item 12).
- Editing notes (item 11).
- Splitting Copilot rows across accounts beyond the mask rule.

## Addendum (2026-10-15): removing transactions, and ones deleted in Copilot

The owner deletes a transaction in Copilot when they are paid back for it, and
wants the same in Ledgerly, plus the import to carry those deletions over.

**Remove, not delete.** A deleted SimpleFIN row would come straight back on the
next sync (same `external_id`), so removing is a flag: schema **v8** adds
`bank_transactions.removed INTEGER NOT NULL DEFAULT 0`. A removed row is left
out of Spending, budgets, the To review list and transfer pairing; a sync
updates it but never clears the flag; **Restore** clears it. It still counts in
the net-worth chart's walk back from today's balance, because the money really
moved — removing is about budgeting, not about the account.

**In the Spending list**, each row gets a Remove button (confirmed with
`askToConfirm`). The Transactions card gets **Show removed (n)**, listing the
month's removed rows with **Restore**.

**In the import**, the plan gains `not_in_copilot`: Ledgerly rows (not
imported, not pending, not already removed, not matched) in an account some
Copilot row maps to, dated from that account's first Copilot row up to three
days before its last — Copilot can lag SimpleFIN by a day or two, and a row
too new for Copilot to have seen is not one the owner deleted. The preview
lists them with a checkbox each, all ticked; `copilot_import` takes the ticked
ids and removes them in the same transaction, accepting only ids the plan
offered. On the owner's data this is 97 rows (17 incoming Apple Pay, 12 Target,
10 outgoing Apple Pay, 6 Costco, …); some may be amount differences rather than
deletions, which is why each can be unticked and every removal restored.
