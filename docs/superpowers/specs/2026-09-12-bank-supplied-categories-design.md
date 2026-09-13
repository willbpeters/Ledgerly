# Bank-supplied transaction categories

**Date:** 2026-09-12
**Status:** design agreed, not yet implemented

## The problem

Ledgerly auto-categorises bank transactions at sync time. The ladder in
`budget/categorize.rs` runs: a manual choice, then user rules (MCC, payee,
description), then the merchant-code map in `budget/mcc.rs`, then the sign of
the amount.

The weak rung is the merchant-code map. An MCC is a four-digit code the card
network attaches to a merchant. `5812` means "eating place". It cannot
distinguish a coffee shop from a steakhouse, and it says nothing at all about
merchants whose code is generic or absent.

`simplefin/parse.rs` reads `id`, `posted`, `amount`, `description`, `payee`,
`memo`, `mcc` and `pending` from each transaction. The SimpleFIN protocol also
allows an optional free-form `extra` object, and that is where a bridge passes
through the institution's own enrichment — including, on some connections, a
category. **Ledgerly discards `extra` entirely.** That is the gap this design
closes.

## What we do not know

Whether the owner's bank actually sends a category.

The public SimpleFIN demo (`demo:demo@beta-bridge.simplefin.org`) was queried
on 2026-09-12. Its transactions carry `id`, `posted`, `amount`, `description`,
`payee`, `memo`, `transacted_at` and `mcc`. There is **no** `extra` object and
no category. The demo therefore cannot answer the question; only a real
institution connection can.

This uncertainty is the reason the work is staged rather than built in one go.

## Decisions taken

1. **Precedence: a bank-supplied category outranks the MCC map.** The ladder
   becomes manual choice → user rules → bank category → MCC map → sign of the
   amount. The institution sees the real merchant; the MCC map sees a
   four-digit code.
2. **The category vocabulary does not grow.** The existing fifteen categories
   stay as they are. A translation table maps bank category names onto them.
   A name we do not recognise is ignored and the transaction falls through to
   the MCC map. Categories are never auto-created from bank data.
3. **Existing history is fixed, not just new transactions.** A recategorise
   action re-pulls transaction history, stores the bank category on existing
   rows, and re-runs the ladder over rows whose `category_source` is `'auto'`.
4. **Diagnose before building.** Stage 1 ships alone and shows what the owner's
   bank actually sends. Stages 2 and 3 are built against that output.

## Architecture

Each piece lands on an existing seam. Layers 1-3 are pure — no database, no
network — matching the project's rule that correctness lives in pure code.

**1. `simplefin/parse.rs`** — capture `extra`.
`SfTransaction` gains `bank_category: Option<String>`. Parsing is deliberately
tolerant: `extra` is free-form, so the parser looks for a category under a
list of candidate key names, accepts a plain string or a nested object, and
returns `None` for anything it cannot read. The candidate list is defined by
what stage 1 observes; until then it is `category`, `categories`,
`personal_finance_category` and `primary_category`, checked in that order and
case-insensitively. A value that is an object is searched for `name`,
`primary` and `detailed`, in that order.

**2. `budget/bank_category.rs` (new, pure)** — the translation table.
One function maps a bank category string onto one of the fifteen built-in
category names, or `None`. It lower-cases and trims before matching. A
hierarchical name such as `"Food and Drink > Coffee Shops"` is tried
most-specific segment first, then the parent.

**3. `budget/categorize.rs`** — one new rung.
`Candidate` gains `bank_category`. `decide()` checks it after user rules and
before the MCC map. A new `Decision::Bank(&'static str)` variant keeps the
source traceable.

**4. `db.rs`** — schema v6.
One new column on `bank_transactions` holding the **raw** bank category string,
added via `add_column_if_missing`, with a `v6_is_complete` check, applied after
the earlier migration blocks. The raw string is stored rather than only the
resolved category so the ladder can be re-run later without another network
call.

**5. `simplefin/sync.rs` and `budget/store.rs`** — carry the new field through
and write it.

**6. The diagnostic (stage 1)** — a Tauri command that fetches the last 30
days from SimpleFIN and returns the raw JSON of the first 5 transactions,
surfaced behind a button in the SimpleFIN section of Settings. Read-only;
writes nothing to the database.

## Staging

### Stage 1 — Diagnostic (ships alone)

A "Show raw transaction data" button in Settings displays pretty-printed raw
JSON for the first 5 transactions of the last 30 days, with a copy button.

The output decides what follows:

- **A category is present.** Stages 2 and 3 proceed as designed, and the
  translation table is seeded from the real values observed.
- **`extra` is present but carries no category** (a cleaned merchant name, a
  location). Stage 2 is redirected to use whatever is genuinely there.
- **Nothing beyond what is already read.** Stage 2 as specified is dead. The
  fallback is a merchant-name dictionary matching payee text against a bundled
  list of common merchants — an improvement that does not depend on the
  institution. This outcome is the diagnostic succeeding, not failing: it
  prevents building a feature that would silently do nothing.

### Stage 2 — Read and apply the bank category

Everything under Architecture. Built only if stage 1 shows there is something
to read.

### Stage 3 — Recategorise history

A "Recategorise transactions" action in Settings. It re-pulls transaction
history in the same 45-day windows the existing "Import 2 years" flow uses,
but **updates** existing rows matched on `(account_id, external_id)` rather
than only inserting new ones, then re-runs the ladder over every row whose
`category_source` is `'auto'`. Rows marked `'manual'` are read but never
written.

The mechanism of stages 2 and 3 is fixed by this document. The **contents** of
the translation table are supplied by stage 1's output, as a named follow-up
commit once the diagnostic has been run.

## Rules this must not break

1. **A manual category is never overwritten.** Both the new ladder rung and the
   stage-3 recategorise skip rows whose `category_source` is `'manual'`. The
   ladder already behaves this way; stage 3 is the new risk, being the first
   bulk write to existing rows.
2. **A malformed `extra` must never break a sync.** Any failure parsing it
   yields `None` and the transaction syncs normally with every other field
   intact. A category is a nice-to-have; losing the transaction is not
   acceptable.
3. **An unrecognised bank category falls through silently.** It never creates a
   category, never guesses, and never lands in "Other". It drops to the MCC map
   exactly as today, so the feature cannot make a transaction worse.
4. **Migration v6 follows the rules in the `db.rs` header.** Column added
   through `add_column_if_missing`, never a raw `ALTER TABLE`; a
   `v6_is_complete` check; applied after the earlier blocks. A version stamp
   behind the schema turns a raw `ADD COLUMN` into a startup panic, which has
   happened to this project before.
5. **Stage 3 writes one account per SQLite transaction**, matching `sync.rs`.
   An interrupted run leaves whole accounts done or untouched, never a
   half-updated account.
6. **Diagnostic output is real financial data.** It is displayed locally and
   sent nowhere. The copy button copies a **redacted** version by default, with
   amounts and balances replaced by `***`, since identifying a field name needs
   no balances. Unredacted copy sits behind a second, explicit control.

## Testing

**`parse.rs` — fixture tests for the shapes `extra` can take.** Category as a
plain string; nested in an object; hierarchical; `extra` present with no
category; `extra` as an array or a number; `extra` absent; category present but
empty. Each yields a clean value or `None`. An explicit test asserts that a
garbage `extra` still leaves amount, payee and MCC correctly parsed.

These fixtures are hand-written from stage 1's output, because the live demo
sends no `extra`. They are therefore only as good as what one institution
sends; a second institution could surprise us, and rule 2 is the safety net.

**`bank_category.rs`.** A known name maps correctly; matching ignores case and
surrounding whitespace; a hierarchical name tries the specific segment before
the parent; an unknown name returns `None`; an empty string returns `None`.

**`categorize.rs`.** A bank category beats the MCC map; a saved payee rule
beats the bank category; an MCC rule beats the bank category; an untranslatable
bank category falls through to the MCC map; a bank category with no MCC present
still categorises.

**Migration.** v6 applied to a populated v5 database; v6 run twice is a no-op;
`v6_is_complete` correctly reports a database missing the column.

**Stage 3.** A `'manual'` row is untouched while `'auto'` rows around it
change; an interrupted run leaves no half-updated account.

**Regression gate.** The existing 126 Vitest and 89 `cargo test` tests must
still pass. The ladder change touches a function with nine existing tests and
none of them should need editing; if one does, the precedence changed in a way
this design did not intend.

## Out of scope

- Auto-creating categories from bank data (decision 2).
- The merchant-name dictionary, unless stage 1 shows it is the only route
  available. It would get its own spec.
- Any change to budgets, limits or the Spending screen's layout.
