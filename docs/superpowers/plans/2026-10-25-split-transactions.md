# Split Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner split one bank or card transaction across several categories (one Costco trip → Groceries $60 + Household $25.50), with budgets, search and the category filter counting each piece.

**Architecture:** A new table `bank_transaction_splits` (migration v9) holds the pieces; the transaction keeps its amount, and while split its own `category_id` is `NULL` with `category_source = 'manual'`, so syncs, re-sorts, transfer pairing and the Copilot import never touch it. Rust validates and writes pieces in one transaction (`store::set_splits`) and attaches them to every listed transaction as `splits`. On the TypeScript side one pure helper, `piecesOf()` in `src/domain/splits.ts`, turns any transaction into the pieces that count; `summariseMonth`, search and the Spending filter all read through it. A `SplitEditor` opens beneath a row in `TransactionList`, and Undo puts the pieces and the row back.

**Tech Stack:** Tauri 2 + rusqlite (Rust), React 19 + TypeScript, TanStack Query 5, Vitest + Testing Library, `cargo test`.

**Migration number:** this plan owns **v9**. The recurring-transactions plan (v10) and the goals plan (v11) land after it on the same branch.

---

## Design decisions (made for you)

- **Pieces carry the transaction's sign.** A −$85.50 purchase splits into −$60 and −$25.50; a refund splits into positive pieces. The editor lets the owner type plain positive numbers and applies the sign.
- **Pieces must add up to the cent** when saved, there must be at least two, and none may be zero. Rust enforces this; the editor mirrors it so Save is disabled until it holds.
- **A later sync may change the amount** (a pending tip settling). The pieces are kept, and whatever they no longer cover counts as an *uncategorised* piece, so totals stay right and the row turns up under "Needs a category". The row shows "$4.50 not assigned".
- **Unsplitting** deletes the pieces and leaves the row uncategorised (manual), ready for the owner to pick one category.
- **Choosing one category for a row ends any split** (`set_category` deletes the pieces). The UI hides the picker on split rows, so this is a safety net.
- **Removing a split row** (paid back) removes all of it, exactly like any other row.

## File Structure

**Rust (`src-tauri/src/`)**
- Modify `db.rs` — v9 migration: `MIGRATION_9`, `v9_is_complete`, `apply_v9`, `TARGET_VERSION = 9`, `migration_pending`, tests.
- Modify `budget/store.rs` — `NewSplit`, `set_splits`, pieces cleared by `set_category`, tests.
- Modify `models.rs` — `TxnSplit`; `BankTransaction.splits`.
- Modify `commands/budget.rs` — `attach_splits` used by `list_transactions` and `list_to_review`; command `bank_transaction_set_splits`; tests.
- Modify `lib.rs` — register the command.
- Modify `backup/export.rs` — `transaction-splits.csv` (EXPORTS 7 → 8), test.

**TypeScript (`src/`)**
- Modify `domain/types.ts` — `TxnSplit`, `NewSplit`, `BankTransaction.splits`.
- Modify `data/api.ts` — `bankTransactions.setSplits`.
- Modify `data/queries.ts` — `useSetSplits`.
- Modify `data/undo.ts` — `useOfferSplitUndo`.
- Create `domain/splits.ts` + `domain/splits.test.ts` — `piecesOf`, `splitRemainder`, `validateSplits`, `inCategory`.
- Modify `domain/spending.ts` (+ test) — `summariseMonth` counts pieces.
- Modify `domain/search.ts` (+ test) — category filter and words read pieces.
- Modify `features/spending/Spending.tsx` — focus filter uses `inCategory`.
- Create `features/spending/SplitEditor.tsx` + `SplitEditor.test.tsx`.
- Modify `features/spending/TransactionList.tsx` (+ test) — Split button, pieces display, editor row.
- Modify `features/activity/Activity.tsx` — a split bank row's badge says "Split".
- Modify test fixtures that build a `BankTransaction`: `domain/spending.test.ts`, `domain/search.test.ts`, `domain/overview.test.ts`, `domain/history.test.ts`, `data/undo.test.ts`, `features/spending/TransactionList.test.tsx`, `features/spending/SearchPanel.test.tsx`, `features/activity/Activity.test.tsx`.

**Docs**
- Modify `docs/TODO.md`, `docs/HANDOFF.md`, `README.md`.

## Commands used throughout (Git Bash, from the repo root)

- Rust tests: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib <filter>; cd ..`
- One TS test file: `npx vitest run <path>`
- Type check: `npx tsc --noEmit`

---

### Task 1: v9 migration — the splits table

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/db.rs`, inside `mod tests`, directly above `fn v8_adds_a_removed_flag_that_starts_off()` (and its `#[test]`), add:

```rust
    #[test]
    fn v9_adds_the_splits_table_and_is_idempotent() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        conn.execute_batch("DROP TABLE bank_transaction_splits;").unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();
        apply_migrations(&conn).unwrap();

        assert!(table_exists(&conn, "bank_transaction_splits").unwrap());
        assert!(!migration_pending(&conn).unwrap());
    }

    #[test]
    fn split_pieces_go_with_their_transaction() {
        let conn = open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (id,name,type,created_at) VALUES (93,'Card','credit','2026-10-01');
             INSERT INTO bank_transactions (id,account_id,external_id,posted,amount,description)
               VALUES (500,93,'t','2026-10-01',-10,'Costco');
             INSERT INTO bank_transaction_splits (txn_id,category_id,amount,sort)
               VALUES (500,NULL,-6,0), (500,NULL,-4,1);",
        ).unwrap();

        conn.execute("DELETE FROM bank_transactions WHERE id=500", []).unwrap();

        let left: i64 = conn.query_row("SELECT count(*) FROM bank_transaction_splits", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "deleting a transaction must delete its pieces");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib db::tests::v9_ db::tests::split_pieces; cd ..`
(If cargo rejects two filters, run `cargo test --lib v9_` and `cargo test --lib split_pieces` separately.)
Expected: FAIL — `no such table: bank_transaction_splits`.

- [ ] **Step 3: Write the migration**

In `src-tauri/src/db.rs`, replace these two lines of the doc comment:

```rust
/// once; v7 adds a `note` and v8 a `removed` flag to bank transactions. To add a change later: bump
```

with:

```rust
/// once; v7 adds a `note` and v8 a `removed` flag to bank transactions; v9 adds
/// `bank_transaction_splits`. To add a change later: bump
```

Replace:

```rust
const TARGET_VERSION: i64 = 8;
```

with:

```rust
const TARGET_VERSION: i64 = 9;
```

Directly after the existing `fn apply_v8` function:

```rust
fn apply_v8(conn: &Connection) -> rusqlite::Result<()> {
    add_column_if_missing(conn, "bank_transactions", V8_COLUMN.0, V8_COLUMN.1)
}
```

add:

```rust
/// v9: a bank transaction can be split across categories (one Costco trip →
/// groceries + household). The pieces live in their own table so the
/// transaction keeps the amount the bank sent; while split, its own category
/// is empty and the pieces are what count. A piece whose category is deleted
/// becomes uncategorised rather than disappearing, so the money never leaves
/// the month.
const MIGRATION_9: &str = "
CREATE TABLE IF NOT EXISTS bank_transaction_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id INTEGER NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bank_transaction_splits_txn ON bank_transaction_splits(txn_id);
";

fn v9_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    table_exists(conn, "bank_transaction_splits")
}

/// Every statement is IF NOT EXISTS, so this is safe to re-run.
fn apply_v9(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_9)
}
```

In `apply_migrations`, replace:

```rust
    if !v8_is_complete(conn)? {
        apply_v8(conn)?;
    }
    set_user_version(conn, TARGET_VERSION)?;
```

with:

```rust
    if !v8_is_complete(conn)? {
        apply_v8(conn)?;
    }
    if !v9_is_complete(conn)? {
        apply_v9(conn)?;
    }
    set_user_version(conn, TARGET_VERSION)?;
```

In `migration_pending`, replace:

```rust
        || !v8_is_complete(conn)?)
```

with:

```rust
        || !v8_is_complete(conn)?
        || !v9_is_complete(conn)?)
```

- [ ] **Step 4: Run the db tests to verify they pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib db::; cd ..`
Expected: PASS, every `db::tests` test including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(spending): a table for the pieces of a split transaction

Migration v9 adds bank_transaction_splits. A piece goes with its
transaction, and a piece whose category is deleted becomes
uncategorised rather than vanishing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `store::set_splits` — validate and write the pieces

**Files:**
- Modify: `src-tauri/src/budget/store.rs`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/budget/store.rs`, inside `mod tests`, directly above the line `use crate::budget::copilot;`, add:

```rust
    fn splits_of(conn: &Connection, ext: &str) -> Vec<(Option<String>, f64)> {
        conn.prepare(
            "SELECT c.name, s.amount FROM bank_transaction_splits s
             JOIN bank_transactions b ON b.id = s.txn_id
             LEFT JOIN categories c ON c.id = s.category_id
             WHERE b.external_id=?1 ORDER BY s.sort",
        ).unwrap()
            .query_map([ext], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
            .map(|r| r.unwrap()).collect()
    }

    fn piece(conn: &Connection, category: Option<&str>, amount: f64) -> NewSplit {
        NewSplit { category_id: category.and_then(|n| seed::category_id(conn, n).unwrap()), amount, note: None }
    }

    /// One $85.50 Costco trip on a card; returns (card, transaction id).
    fn costco(conn: &Connection) -> (i64, i64) {
        let card = account(conn, "Card", "credit");
        upsert_transactions(conn, card, &[payee_txn("c1", "2026-10-03", -85.5, "Costco")], &[]).unwrap();
        let id = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='c1'", [], |r| r.get(0)).unwrap();
        (card, id)
    }

    #[test]
    fn a_split_stores_its_pieces_and_empties_the_rows_own_category() {
        let conn = db::open_in_memory().unwrap();
        let (_, id) = costco(&conn);

        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        assert_eq!(splits_of(&conn, "c1"), vec![(Some("Groceries".into()), -60.0), (Some("Shopping".into()), -25.5)]);
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true), "a split row is the owner's, and reviewed");
    }

    #[test]
    fn a_split_must_add_up_to_the_transaction() {
        let conn = db::open_in_memory().unwrap();
        let (_, id) = costco(&conn);

        let err = set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, None, -25.0)]).unwrap_err();

        assert_eq!(err, "The pieces add up to $85.00, but the transaction is $85.50.");
        assert!(splits_of(&conn, "c1").is_empty(), "a refused split writes nothing");
        assert_eq!(row(&conn, "c1").1, "auto");
    }

    #[test]
    fn a_split_needs_two_pieces_each_with_an_amount() {
        let conn = db::open_in_memory().unwrap();
        let (_, id) = costco(&conn);

        assert_eq!(
            set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -85.5)]).unwrap_err(),
            "Split it into at least two pieces.",
        );
        assert_eq!(
            set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -85.5), piece(&conn, None, 0.0)]).unwrap_err(),
            "Every piece needs an amount.",
        );
        assert_eq!(
            set_splits(&conn, 99_999, &[]).unwrap_err(),
            "That transaction no longer exists.",
        );
    }

    #[test]
    fn splitting_again_replaces_the_pieces() {
        let conn = db::open_in_memory().unwrap();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        set_splits(&conn, id, &[piece(&conn, Some("Dining"), -80.0), piece(&conn, None, -5.5)]).unwrap();

        assert_eq!(splits_of(&conn, "c1"), vec![(Some("Dining".into()), -80.0), (None, -5.5)]);
    }

    #[test]
    fn unsplitting_removes_the_pieces_and_leaves_the_row_uncategorised() {
        let conn = db::open_in_memory().unwrap();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        set_splits(&conn, id, &[]).unwrap();

        assert!(splits_of(&conn, "c1").is_empty());
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true));
    }

    #[test]
    fn a_later_sync_and_a_re_sort_leave_a_split_alone() {
        let conn = db::open_in_memory().unwrap();
        let (card, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        upsert_transactions(&conn, card, &[payee_txn("c1", "2026-10-03", -85.5, "Costco")], &[]).unwrap();
        recategorise_all(&conn).unwrap();

        assert_eq!(splits_of(&conn, "c1").len(), 2);
        assert_eq!(row(&conn, "c1"), (None, "manual".into(), true));
    }

    #[test]
    fn deleting_the_account_deletes_the_pieces() {
        let conn = db::open_in_memory().unwrap();
        let (card, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        conn.execute("DELETE FROM accounts WHERE id=?1", [card]).unwrap();

        let n: i64 = conn.query_row("SELECT count(*) FROM bank_transaction_splits", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn deleting_a_category_leaves_its_piece_uncategorised() {
        let conn = db::open_in_memory().unwrap();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        conn.execute("DELETE FROM categories WHERE name='Groceries'", []).unwrap();

        assert_eq!(splits_of(&conn, "c1"), vec![(None, -60.0), (Some("Shopping".into()), -25.5)]);
    }

    #[test]
    fn choosing_one_category_ends_a_split() {
        let conn = db::open_in_memory().unwrap();
        let (_, id) = costco(&conn);
        set_splits(&conn, id, &[piece(&conn, Some("Groceries"), -60.0), piece(&conn, Some("Shopping"), -25.5)]).unwrap();

        set_category(&conn, id, seed::category_id(&conn, "Groceries").unwrap(), false).unwrap();

        assert!(splits_of(&conn, "c1").is_empty());
        assert_eq!(row(&conn, "c1").0.as_deref(), Some("Groceries"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib budget::store; cd ..`
Expected: FAIL to compile — `cannot find struct NewSplit`, `cannot find function set_splits`.

- [ ] **Step 3: Write the implementation**

In `src-tauri/src/budget/store.rs`, replace the start of `set_category`:

```rust
pub fn set_category(
    conn: &Connection,
    txn_id: i64,
    category_id: Option<i64>,
    apply_to_payee: bool,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE bank_transactions SET category_id=?1, category_source='manual', reviewed=1 WHERE id=?2",
        params![category_id, txn_id],
    )?;
```

with:

```rust
pub fn set_category(
    conn: &Connection,
    txn_id: i64,
    category_id: Option<i64>,
    apply_to_payee: bool,
) -> rusqlite::Result<usize> {
    // One category for the whole row ends any split: the pieces would
    // otherwise go on counting beside it.
    conn.execute("DELETE FROM bank_transaction_splits WHERE txn_id=?1", [txn_id])?;
    conn.execute(
        "UPDATE bank_transactions SET category_id=?1, category_source='manual', reviewed=1 WHERE id=?2",
        params![category_id, txn_id],
    )?;
```

Then, directly after the whole `set_category` function (before the doc comment of `mark_transfer_pairs`), add:

```rust
/// One piece of a split, as the owner entered it. The amount carries the
/// transaction's sign: a purchase splits into negative pieces.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct NewSplit {
    pub category_id: Option<i64>,
    pub amount: f64,
    pub note: Option<String>,
}

fn cents(x: f64) -> i64 {
    (x * 100.0).round() as i64
}

fn dollars(cents: i64) -> String {
    format!("${}.{:02}", cents.abs() / 100, cents.abs() % 100)
}

/// Split a transaction across categories, or unsplit it with no pieces.
///
/// The pieces must add up to the transaction to the cent, and there must be at
/// least two, none of them zero. A split row's own category is emptied and
/// made manual, which is what keeps a sync, a re-sort, transfer pairing and the
/// Copilot import away from it: all of them touch only automatic rows.
/// Unsplitting leaves the row uncategorised for the owner to choose. All of it
/// happens in one transaction; a refused split changes nothing.
pub fn set_splits(conn: &Connection, txn_id: i64, pieces: &[NewSplit]) -> Result<(), String> {
    let amount: f64 = conn
        .query_row("SELECT amount FROM bank_transactions WHERE id=?1", [txn_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That transaction no longer exists.".to_string())?;
    if !pieces.is_empty() {
        if pieces.len() < 2 {
            return Err("Split it into at least two pieces.".into());
        }
        if pieces.iter().any(|p| cents(p.amount) == 0) {
            return Err("Every piece needs an amount.".into());
        }
        let sum: i64 = pieces.iter().map(|p| cents(p.amount)).sum();
        if sum != cents(amount) {
            return Err(format!(
                "The pieces add up to {}, but the transaction is {}.",
                dollars(sum), dollars(cents(amount)),
            ));
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let write = || -> rusqlite::Result<()> {
        tx.execute("DELETE FROM bank_transaction_splits WHERE txn_id=?1", [txn_id])?;
        for (i, p) in pieces.iter().enumerate() {
            tx.execute(
                "INSERT INTO bank_transaction_splits (txn_id, category_id, amount, note, sort)
                 VALUES (?1,?2,?3,?4,?5)",
                params![txn_id, p.category_id, p.amount, p.note, i as i64],
            )?;
        }
        tx.execute(
            "UPDATE bank_transactions SET category_id=NULL, category_source='manual', reviewed=1 WHERE id=?1",
            [txn_id],
        )?;
        Ok(())
    };
    write().map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
```

Note the `UPDATE` also runs on unsplit (empty `pieces`): the row was already `NULL`/manual while split, so this only repeats it, and it is what the "unsplitting leaves the row uncategorised" test pins.

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib budget::store; cd ..`
Expected: PASS, all `budget::store::tests`, including the nine new ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/budget/store.rs
git commit -m "feat(spending): split a transaction into pieces that add up

set_splits checks that there are at least two pieces, none zero, and
that they add up to the transaction to the cent, then writes them in
one go. A split row's own category is emptied and made manual, so a
sync or re-sort never moves it. Choosing one category ends a split.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Listed transactions carry their pieces, and the command

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/commands/budget.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/commands/budget.rs`, inside `mod tests`, add at the end (before the module's closing `}`):

```rust
    #[test]
    fn listed_transactions_carry_their_split_pieces_in_order() {
        let conn = db::open_in_memory().unwrap();
        conn.execute("INSERT INTO accounts (name,type,currency,created_at) VALUES ('C','credit','USD','2026-01-01')", []).unwrap();
        conn.execute_batch(
            "INSERT INTO bank_transactions (account_id,external_id,posted,amount,description)
             VALUES (1,'split','2026-09-10',-85.5,'Costco'), (1,'plain','2026-09-11',-5,'Coffee');",
        ).unwrap();
        let id: i64 = conn.query_row("SELECT id FROM bank_transactions WHERE external_id='split'", [], |r| r.get(0)).unwrap();
        store::set_splits(&conn, id, &[
            store::NewSplit { category_id: None, amount: -60.0, note: Some("food".into()) },
            store::NewSplit { category_id: None, amount: -25.5, note: None },
        ]).unwrap();

        let rows = list_transactions(&conn, "2026-09-01", "2026-09-30").unwrap();
        let plain = rows.iter().find(|r| r.external_id == "plain").unwrap();
        assert!(plain.splits.is_empty());
        let split = rows.iter().find(|r| r.external_id == "split").unwrap();
        let pieces: Vec<(f64, Option<String>)> = split.splits.iter().map(|s| (s.amount, s.note.clone())).collect();
        assert_eq!(pieces, vec![(-60.0, Some("food".to_string())), (-25.5, None)]);

        // The review list carries them too.
        conn.execute("UPDATE bank_transactions SET reviewed=0 WHERE id=?1", [id]).unwrap();
        let review = list_to_review(&conn).unwrap();
        assert_eq!(review.iter().find(|r| r.id == id).unwrap().splits.len(), 2);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib commands::budget; cd ..`
Expected: FAIL to compile — `no field splits on type BankTransaction`.

- [ ] **Step 3: Add the model**

In `src-tauri/src/models.rs`, replace:

```rust
    /// Left out of Spending and budgets (the owner was paid back); restorable.
    pub removed: bool,
}
```

with:

```rust
    /// Left out of Spending and budgets (the owner was paid back); restorable.
    pub removed: bool,
    /// The pieces, when the owner split it across categories; empty otherwise.
    /// While split, `category_id` is null and the pieces are what count.
    pub splits: Vec<TxnSplit>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TxnSplit {
    pub id: i64,
    pub category_id: Option<i64>,
    /// Carries the transaction's sign: a purchase splits into negative pieces.
    pub amount: f64,
    pub note: Option<String>,
}
```

- [ ] **Step 4: Attach pieces to listed rows, and add the command**

In `src-tauri/src/commands/budget.rs`, replace the imports:

```rust
use crate::budget::store;
use crate::db::Db;
use crate::models::{BankTransaction, Budget, Category, CategoryRule};
use rusqlite::{params, Connection};
```

with:

```rust
use crate::budget::store;
use crate::db::Db;
use crate::models::{BankTransaction, Budget, Category, CategoryRule, TxnSplit};
use rusqlite::{params, Connection};
use std::collections::HashMap;
```

In `txn_from_row`, replace:

```rust
        note: r.get(13)?,
        removed: r.get::<_, i64>(14)? != 0,
    })
}
```

with:

```rust
        note: r.get(13)?,
        removed: r.get::<_, i64>(14)? != 0,
        splits: Vec::new(),
    })
}

/// Fill in each row's split pieces. The table holds only rows the owner split
/// by hand, so it is read whole rather than by a list of ids, which for a
/// search across every month would run to thousands.
fn attach_splits(conn: &Connection, rows: &mut [BankTransaction]) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT txn_id, id, category_id, amount, note FROM bank_transaction_splits
         ORDER BY txn_id, sort, id",
    )?;
    let mut by_txn: HashMap<i64, Vec<TxnSplit>> = HashMap::new();
    let pieces = stmt.query_map([], |r| {
        Ok((r.get::<_, i64>(0)?, TxnSplit {
            id: r.get(1)?, category_id: r.get(2)?, amount: r.get(3)?, note: r.get(4)?,
        }))
    })?;
    for piece in pieces {
        let (txn_id, split) = piece?;
        by_txn.entry(txn_id).or_default().push(split);
    }
    for row in rows.iter_mut() {
        if let Some(splits) = by_txn.remove(&row.id) {
            row.splits = splits;
        }
    }
    Ok(())
}
```

Replace `list_transactions` and `list_to_review`:

```rust
pub fn list_transactions(conn: &Connection, from: &str, to: &str)
    -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE posted >= ?1 AND posted <= ?2
         ORDER BY posted DESC, id DESC"
    ))?;
    let rows = stmt.query_map([from, to], txn_from_row)?;
    rows.collect()
}

/// Every transaction the owner has not looked at yet, any month, newest first.
pub fn list_to_review(conn: &Connection) -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE reviewed = 0 AND removed = 0
         ORDER BY posted DESC, id DESC"
    ))?;
    let rows = stmt.query_map([], txn_from_row)?;
    rows.collect()
}
```

with:

```rust
pub fn list_transactions(conn: &Connection, from: &str, to: &str)
    -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE posted >= ?1 AND posted <= ?2
         ORDER BY posted DESC, id DESC"
    ))?;
    let mut rows = stmt.query_map([from, to], txn_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    attach_splits(conn, &mut rows)?;
    Ok(rows)
}

/// Every transaction the owner has not looked at yet, any month, newest first.
pub fn list_to_review(conn: &Connection) -> rusqlite::Result<Vec<BankTransaction>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TXN_COLUMNS} FROM bank_transactions WHERE reviewed = 0 AND removed = 0
         ORDER BY posted DESC, id DESC"
    ))?;
    let mut rows = stmt.query_map([], txn_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    attach_splits(conn, &mut rows)?;
    Ok(rows)
}
```

Directly after the `bank_transaction_set_category` command function, add:

```rust
/// Split a transaction across categories; an empty list unsplits it.
#[tauri::command]
pub fn bank_transaction_set_splits(db: tauri::State<Db>, id: i64, splits: Vec<store::NewSplit>)
    -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    store::set_splits(&conn, id, &splits)
}
```

- [ ] **Step 5: Register the command**

In `src-tauri/src/lib.rs`, replace:

```rust
            commands::budget::bank_transaction_set_category,
```

with:

```rust
            commands::budget::bank_transaction_set_category,
            commands::budget::bank_transaction_set_splits,
```

- [ ] **Step 6: Run the Rust tests to verify they pass**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib; cd ..`
Expected: PASS, the whole library (this also proves `lib.rs` still compiles).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/commands/budget.rs src-tauri/src/lib.rs
git commit -m "feat(spending): listed transactions carry their split pieces

Every transaction listed for Spending, search and the review list now
arrives with its pieces, and bank_transaction_set_splits saves or
clears them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: TypeScript types, API call, hook — and every fixture

**Files:**
- Modify: `src/domain/types.ts`, `src/data/api.ts`, `src/data/queries.ts`
- Modify fixtures: `src/domain/spending.test.ts`, `src/domain/search.test.ts`, `src/domain/overview.test.ts`, `src/domain/history.test.ts`, `src/data/undo.test.ts`, `src/features/spending/TransactionList.test.tsx`, `src/features/spending/SearchPanel.test.tsx`, `src/features/activity/Activity.test.tsx`

- [ ] **Step 1: Add the types**

In `src/domain/types.ts`, replace:

```ts
  /** Left out of Spending and budgets (paid back); restorable. */
  removed: boolean;
}
```

with:

```ts
  /** Left out of Spending and budgets (paid back); restorable. */
  removed: boolean;
  /** The pieces, when split across categories; empty otherwise. While split,
   *  `category_id` is null and the pieces are what count — read them through
   *  `piecesOf()` in `splits.ts`, never `category_id` alone. */
  splits: TxnSplit[];
}

/** One piece of a split transaction. The amount carries the transaction's
 *  sign: a purchase splits into negative pieces. */
export interface TxnSplit {
  id: number; category_id: number | null; amount: number; note: string | null;
}
/** A piece on its way to the database, before it has an id. */
export type NewSplit = Omit<TxnSplit, "id">;
```

- [ ] **Step 2: Run the type check to see every fixture that now needs `splits`**

Run: `npx tsc --noEmit`
Expected: FAIL — `Property 'splits' is missing in type …` in the test fixtures listed above (not in `undo.test.ts` or `fromVisibleAccounts`' rows in `spending.test.ts`, which use `as` casts).

- [ ] **Step 3: Add `splits: []` to each fixture**

Make each replacement exactly:

`src/domain/spending.test.ts` (the `txn` helper):
```ts
  category_id, category_source: "auto", reviewed: true, note: null, removed: false,
```
→
```ts
  category_id, category_source: "auto", reviewed: true, note: null, removed: false, splits: [],
```

`src/domain/search.test.ts`:
```ts
  category_id: null, category_source: "auto", reviewed: true, note: null, removed: false,
```
→
```ts
  category_id: null, category_source: "auto", reviewed: true, note: null, removed: false, splits: [],
```

`src/domain/overview.test.ts`:
```ts
    reviewed: true, note: null, removed: false, ...p };
```
→
```ts
    reviewed: true, note: null, removed: false, splits: [], ...p };
```

`src/domain/history.test.ts`:
```ts
    payee: null, memo: null, mcc: null, pending: false, category_id: null, category_source: "auto", reviewed: true, note: null, removed: false,
```
→
```ts
    payee: null, memo: null, mcc: null, pending: false, category_id: null, category_source: "auto", reviewed: true, note: null, removed: false, splits: [],
```

`src/data/undo.test.ts` (a cast, so not required, but keep fixtures whole):
```ts
  reviewed: false, note: "x", removed: true,
```
→
```ts
  reviewed: false, note: "x", removed: true, splits: [],
```

`src/features/spending/TransactionList.test.tsx`:
```ts
  reviewed: false, note: null, removed: false, ...over,
```
→
```ts
  reviewed: false, note: null, removed: false, splits: [], ...over,
```

`src/features/spending/SearchPanel.test.tsx`:
```ts
  reviewed: true, note: null, removed: false,
```
→
```ts
  reviewed: true, note: null, removed: false, splits: [],
```

`src/features/activity/Activity.test.tsx`:
```ts
    category_id: 1, category_source: "auto", reviewed: true, note: null, removed: false,
```
→
```ts
    category_id: 1, category_source: "auto", reviewed: true, note: null, removed: false, splits: [],
```

- [ ] **Step 4: Add the API call and the hook**

In `src/data/api.ts`, in the type import list, replace:

```ts
  Category, BankTransaction, CategoryRule, Budget,
```

with:

```ts
  Category, BankTransaction, CategoryRule, Budget, NewSplit,
```

In the `bankTransactions` block, replace:

```ts
    setCategory: (id: number, categoryId: number | null, applyToPayee: boolean) =>
      invoke<number>("bank_transaction_set_category", { id, categoryId, applyToPayee }),
```

with:

```ts
    setCategory: (id: number, categoryId: number | null, applyToPayee: boolean) =>
      invoke<number>("bank_transaction_set_category", { id, categoryId, applyToPayee }),
    /** Split across categories; no pieces unsplits. Refused unless they add up. */
    setSplits: (id: number, splits: NewSplit[]) =>
      invoke<void>("bank_transaction_set_splits", { id, splits }),
```

In `src/data/queries.ts`, replace the first import line:

```ts
import { useQuery, useMutation, useQueryClient, useIsMutating } from "@tanstack/react-query";
```

with:

```ts
import { useQuery, useMutation, useQueryClient, useIsMutating } from "@tanstack/react-query";
import type { NewSplit } from "../domain/types";
```

Directly after the `useSetTransactionCategory` function, add:

```ts
/** Splitting changes what each category holds, like a category change. */
export function useSetSplits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; splits: NewSplit[] }) => api.bankTransactions.setSplits(v.id, v.splits),
    onSuccess: () => invalidateSpending(qc),
  });
}
```

- [ ] **Step 5: Type check and run the tests**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm test`
Expected: PASS, every suite (nothing reads `splits` yet).

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/data/api.ts src/data/queries.ts src/domain/spending.test.ts src/domain/search.test.ts src/domain/overview.test.ts src/domain/history.test.ts src/data/undo.test.ts src/features/spending/TransactionList.test.tsx src/features/spending/SearchPanel.test.tsx src/features/activity/Activity.test.tsx
git commit -m "feat(spending): the front end knows about split pieces

BankTransaction gains its pieces, with a call and a hook to save them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `src/domain/splits.ts` — the pieces that count

**Files:**
- Create: `src/domain/splits.ts`
- Create: `src/domain/splits.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/splits.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { piecesOf, splitRemainder, validateSplits, inCategory } from "./splits";
import type { BankTransaction, TxnSplit } from "./types";

const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 1, account_id: 1, external_id: "e1", posted: "2026-10-03", amount: -85.5,
  description: "COSTCO", payee: "Costco", memo: null, mcc: null, pending: false,
  category_id: 1, category_source: "auto", reviewed: true, note: null, removed: false, splits: [],
  ...over,
});
const piece = (id: number, category_id: number | null, amount: number): TxnSplit =>
  ({ id, category_id, amount, note: null });
const costco = txn({ category_id: null, category_source: "manual", splits: [piece(1, 1, -60), piece(2, 2, -25.5)] });

describe("piecesOf", () => {
  it("is the whole transaction when it is not split", () => {
    expect(piecesOf(txn())).toEqual([{ category_id: 1, amount: -85.5 }]);
  });

  it("is the pieces of a split transaction", () => {
    expect(piecesOf(costco)).toEqual([{ category_id: 1, amount: -60 }, { category_id: 2, amount: -25.5 }]);
  });

  it("adds what the pieces no longer cover, uncategorised, after the bank changed the amount", () => {
    expect(piecesOf({ ...costco, amount: -90 })).toEqual([
      { category_id: 1, amount: -60 }, { category_id: 2, amount: -25.5 }, { category_id: null, amount: -4.5 },
    ]);
  });

  it("ignores a difference smaller than half a cent", () => {
    expect(piecesOf({ ...costco, amount: -85.501 })).toHaveLength(2);
  });
});

describe("splitRemainder", () => {
  it("is nothing for a row that is not split, or whose pieces add up", () => {
    expect(splitRemainder(txn())).toBe(0);
    expect(splitRemainder(costco)).toBe(0);
  });

  it("is what the pieces no longer cover", () => {
    expect(splitRemainder({ ...costco, amount: -90 })).toBe(-4.5);
  });
});

describe("validateSplits", () => {
  const p = (category_id: number | null, amount: number) => ({ category_id, amount });

  it("accepts pieces that add up", () => {
    expect(validateSplits(-85.5, [p(1, -60), p(2, -25.5)])).toEqual({ left: 0, problem: null });
  });

  it("says how much is left to assign", () => {
    expect(validateSplits(-85.5, [p(1, -60), p(2, -20)])).toEqual({ left: -5.5, problem: "short" });
  });

  it("says when the pieces come to more than the transaction", () => {
    expect(validateSplits(-85.5, [p(1, -60), p(2, -30)])).toEqual({ left: 4.5, problem: "over" });
  });

  it("works the same way for money in", () => {
    expect(validateSplits(100, [p(1, 70), p(2, 20)])).toEqual({ left: 10, problem: "short" });
  });

  it("needs an amount in every piece", () => {
    expect(validateSplits(-85.5, [p(1, -85.5), p(2, 0)]).problem).toBe("no-amount");
  });

  it("needs at least two pieces", () => {
    expect(validateSplits(-85.5, [p(1, -85.5)]).problem).toBe("too-few");
  });
});

describe("inCategory", () => {
  it("reads the row's own category when it is not split", () => {
    expect(inCategory(txn(), 1)).toBe(true);
    expect(inCategory(txn(), 2)).toBe(false);
    expect(inCategory(txn({ category_id: null }), "uncategorised")).toBe(true);
  });

  it("finds a split transaction under any of its pieces", () => {
    expect(inCategory(costco, 2)).toBe(true);
    expect(inCategory(costco, 3)).toBe(false);
    expect(inCategory(costco, "uncategorised")).toBe(false);
  });

  it("counts an uncovered remainder as uncategorised", () => {
    expect(inCategory({ ...costco, amount: -90 }, "uncategorised")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/splits.test.ts`
Expected: FAIL — `Failed to resolve import "./splits"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/splits.ts`:

```ts
import type { BankTransaction } from "./types";

/**
 * Split transactions. A split row's own `category_id` is null; its pieces are
 * what count. Anything that totals or filters by category must read
 * transactions through `piecesOf` or `inCategory`, or a split purchase would
 * look uncategorised.
 */

export interface Piece { category_id: number | null; amount: number }

const cents = (x: number) => Math.round(x * 100);

/**
 * What the pieces no longer cover, with the transaction's sign: 0 unless a
 * later sync changed the amount after the owner split it (a pending tip
 * settling, say). Compared in cents, so a float crumb is never a remainder.
 */
export function splitRemainder(t: BankTransaction): number {
  if (t.splits.length === 0) return 0;
  const left = cents(t.amount) - t.splits.reduce((s, p) => s + cents(p.amount), 0);
  return left === 0 ? 0 : left / 100;
}

/**
 * The pieces a transaction counts as: the whole of it when it is not split;
 * otherwise its pieces, plus an uncategorised piece for anything they no
 * longer cover, so the month's totals always add up to what the bank says.
 */
export function piecesOf(t: BankTransaction): Piece[] {
  if (t.splits.length === 0) return [{ category_id: t.category_id, amount: t.amount }];
  const pieces = t.splits.map((s) => ({ category_id: s.category_id, amount: s.amount }));
  const left = splitRemainder(t);
  if (left !== 0) pieces.push({ category_id: null, amount: left });
  return pieces;
}

/** Whether any piece of the transaction is in that category. */
export function inCategory(t: BankTransaction, category: number | "uncategorised"): boolean {
  return piecesOf(t).some((p) =>
    category === "uncategorised" ? p.category_id == null : p.category_id === category);
}

/** Why a split cannot be saved yet. "short": some of it is not assigned;
 *  "over": the pieces come to more than the transaction. */
export type SplitProblem = "too-few" | "no-amount" | "short" | "over";

export interface SplitCheck {
  /** Still to assign, with the transaction's sign; 0 when it adds up. */
  left: number;
  problem: SplitProblem | null;
}

/**
 * The rules `store::set_splits` enforces in Rust, checked as the owner types
 * so Save can stay disabled until they hold: at least two pieces, none zero,
 * adding up to the transaction to the cent.
 */
export function validateSplits(total: number, pieces: Piece[]): SplitCheck {
  const totalCents = cents(total);
  const leftCents = totalCents - pieces.reduce((s, p) => s + cents(p.amount), 0);
  // Never -0: it reads as zero to a person but not to toEqual.
  const left = leftCents === 0 ? 0 : leftCents / 100;
  if (pieces.length < 2) return { left, problem: "too-few" };
  if (pieces.some((p) => cents(p.amount) === 0)) return { left, problem: "no-amount" };
  if (leftCents === 0) return { left, problem: null };
  return { left, problem: Math.sign(leftCents) === Math.sign(totalCents) ? "short" : "over" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/splits.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domain/splits.ts src/domain/splits.test.ts
git commit -m "feat(spending): the pieces a split transaction counts as

piecesOf turns any transaction into the pieces that count, adding an
uncategorised piece for whatever a later change of amount left
uncovered. validateSplits mirrors the rules the database enforces.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The month's figures count each piece

**Files:**
- Modify: `src/domain/spending.ts`
- Modify: `src/domain/spending.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/spending.test.ts`, directly above `describe("limitFor", () => {`, add:

```ts
const split = (amount: number, pieces: [number | null, number][]): BankTransaction => ({
  ...txn(amount, null), category_source: "manual",
  splits: pieces.map(([category_id, a], i) => ({ id: 100 + i, category_id, amount: a, note: null })),
});

describe("summariseMonth with split transactions", () => {
  it("counts each piece in its own category", () => {
    const s = summariseMonth([split(-85.5, [[1, -60], [2, -25.5]])], cats, [], "2026-09");
    const groceries = s.categories.find((c) => c.category.id === 1)!;
    const dining = s.categories.find((c) => c.category.id === 2)!;
    expect([groceries.spent, groceries.count]).toEqual([60, 1]);
    expect([dining.spent, dining.count]).toEqual([25.5, 1]);
    expect(s.spent).toBe(85.5);
    expect(s.uncategorisedCount).toBe(0);
  });

  it("puts an income piece in income", () => {
    const s = summariseMonth([split(100, [[3, 120], [1, -20]])], cats, [], "2026-09");
    expect(s.income).toBe(120);
    expect(s.categories.find((c) => c.category.id === 1)?.spent).toBe(20);
  });

  it("treats what the pieces no longer cover as needing a category", () => {
    const s = summariseMonth([split(-90, [[1, -60], [2, -25.5]])], cats, [], "2026-09");
    expect(s.spent).toBe(85.5);
    expect(s.uncategorisedCount).toBe(1);
    expect(s.uncategorisedTotal).toBe(4.5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/spending.test.ts`
Expected: FAIL — the split rows count as one uncategorised row (`uncategorisedCount` 1, Groceries spent 0).

- [ ] **Step 3: Count pieces in `summariseMonth`**

In `src/domain/spending.ts`, replace the first import line:

```ts
import type { Account, BankTransaction, Budget, Category } from "./types";
```

with:

```ts
import type { Account, BankTransaction, Budget, Category } from "./types";
import { piecesOf } from "./splits";
```

In the doc comment of `summariseMonth`, replace:

```ts
 * so moving money never looks like earning or spending it.
 */
```

with:

```ts
 * so moving money never looks like earning or spending it. A split transaction
 * counts piece by piece, each in its own category.
 */
```

Replace the loop:

```ts
  for (const t of inMonth) {
    const category = t.category_id == null ? null : byId.get(t.category_id) ?? null;
    if (category?.kind === "transfer") {
      transferred += Math.abs(t.amount) / 2; // each leg is counted once
      continue;
    }
    if (category?.kind === "income") {
      income += t.amount;
      continue;
    }
    if (category == null) {
      if (t.amount < 0) {
        uncategorisedCount += 1;
        uncategorisedTotal += -t.amount;
      } else {
        income += t.amount;
      }
      continue;
    }
    const row = totals.get(category.id) ?? { spent: 0, count: 0 };
    row.spent += -t.amount; // a refund is positive, so it reduces the total
    row.count += 1;
    totals.set(category.id, row);
  }
```

with:

```ts
  for (const t of inMonth) {
    for (const piece of piecesOf(t)) {
      const category = piece.category_id == null ? null : byId.get(piece.category_id) ?? null;
      if (category?.kind === "transfer") {
        transferred += Math.abs(piece.amount) / 2; // each leg is counted once
        continue;
      }
      if (category?.kind === "income") {
        income += piece.amount;
        continue;
      }
      if (category == null) {
        if (piece.amount < 0) {
          uncategorisedCount += 1;
          uncategorisedTotal += -piece.amount;
        } else {
          income += piece.amount;
        }
        continue;
      }
      const row = totals.get(category.id) ?? { spent: 0, count: 0 };
      row.spent += -piece.amount; // a refund is positive, so it reduces the total
      row.count += 1;
      totals.set(category.id, row);
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/spending.test.ts`
Expected: PASS, the existing tests and the three new ones.

- [ ] **Step 5: Commit**

```bash
git add src/domain/spending.ts src/domain/spending.test.ts
git commit -m "feat(spending): budgets count each piece of a split

The month view puts each piece of a split transaction in its own
category, and anything the pieces no longer cover needs a category.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Search and the category filter read pieces

**Files:**
- Modify: `src/domain/search.ts`
- Modify: `src/domain/search.test.ts`
- Modify: `src/features/spending/Spending.tsx`

- [ ] **Step 1: Write the failing test**

In `src/domain/search.test.ts`, inside `describe("searchTransactions", …)`, directly above `it("puts the newest first", () => {`, add:

```ts
  it("finds a split transaction by any piece's category or note", () => {
    const costco = txn({ amount: -85.5, splits: [
      { id: 1, category_id: 1, amount: -60, note: null },
      { id: 2, category_id: 2, amount: -25.5, note: "pizza" },
    ] });
    const dinner = txn({ category_id: 2 });
    expect(searchTransactions([costco, dinner], { ...all, categoryId: 1 }, ctx)).toEqual([costco]);
    expect(searchTransactions([costco, dinner], { ...all, text: "groceries" }, ctx)).toEqual([costco]);
    expect(searchTransactions([costco, dinner], { ...all, text: "pizza" }, ctx)).toEqual([costco]);
    expect(searchTransactions([costco], { ...all, categoryId: "uncategorised" }, ctx)).toEqual([]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/search.test.ts`
Expected: FAIL — the Groceries filter returns `[]` (the split row's own category is null).

- [ ] **Step 3: Read pieces in `searchTransactions`**

In `src/domain/search.ts`, replace the import:

```ts
import type { Account, BankTransaction, Category } from "./types";
```

with:

```ts
import type { Account, BankTransaction, Category } from "./types";
import { inCategory, piecesOf } from "./splits";
```

Replace:

```ts
      if (search.categoryId === "uncategorised" ? t.category_id != null
        : search.categoryId != null && t.category_id !== search.categoryId) return false;
```

with:

```ts
      // A split purchase belongs to every category it was split into.
      if (search.categoryId != null && !inCategory(t, search.categoryId)) return false;
```

Replace:

```ts
      const haystack = [
        t.payee, t.description, t.memo, t.note,
        t.category_id == null ? null : categoryName.get(t.category_id),
        accountName.get(t.account_id),
      ].filter(Boolean).join("\n").toLowerCase();
```

with:

```ts
      const haystack = [
        t.payee, t.description, t.memo, t.note,
        ...piecesOf(t).map((p) => (p.category_id == null ? null : categoryName.get(p.category_id))),
        ...t.splits.map((s) => s.note),
        accountName.get(t.account_id),
      ].filter(Boolean).join("\n").toLowerCase();
```

- [ ] **Step 4: Use `inCategory` for Spending's category focus**

In `src/features/spending/Spending.tsx`, replace:

```ts
import { monthWindow, monthLabel, shiftMonth, thisMonth, summariseMonth, fromVisibleAccounts } from "../../domain/spending";
```

with:

```ts
import { monthWindow, monthLabel, shiftMonth, thisMonth, summariseMonth, fromVisibleAccounts } from "../../domain/spending";
import { inCategory } from "../../domain/splits";
```

Replace:

```ts
  const shown = txns.filter((t) =>
    focus == null ? true : focus === "uncategorised" ? t.category_id == null : t.category_id === focus);
```

with:

```ts
  // A split purchase shows under every category it was split into.
  const shown = txns.filter((t) => focus == null || inCategory(t, focus));
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run src/domain/search.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/domain/search.ts src/domain/search.test.ts src/features/spending/Spending.tsx
git commit -m "feat(spending): search and the category filter find split pieces

A split purchase turns up under every category it was split into, and
words in a piece's note find it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `SplitEditor`, with Undo

**Files:**
- Modify: `src/data/undo.ts`
- Create: `src/features/spending/SplitEditor.tsx`
- Create: `src/features/spending/SplitEditor.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/features/spending/SplitEditor.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToastProvider } from "../../ui/toast";
import { SplitEditor } from "./SplitEditor";
import type { BankTransaction, Category } from "../../domain/types";

// The editor saves through the Tauri bridge; stand it in with spies.
const { setSplits, restore } = vi.hoisted(() => ({
  setSplits: vi.fn((..._args: unknown[]) => Promise.resolve()),
  restore: vi.fn((..._args: unknown[]) => Promise.resolve(1)),
}));
vi.mock("../../data/api", () => ({ api: { bankTransactions: { setSplits, restore } } }));

const groceries: Category = { id: 1, name: "Groceries", kind: "spending", colour: "chart-1", sort: 10, is_builtin: true };
const household: Category = { id: 2, name: "Household", kind: "spending", colour: "chart-2", sort: 20, is_builtin: false };
const txn = (over: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 7, account_id: 1, external_id: "t", posted: "2026-10-03", amount: -85.5, description: "COSTCO",
  payee: "Costco", memo: null, mcc: null, pending: false, category_id: 1, category_source: "auto",
  reviewed: false, note: null, removed: false, splits: [], ...over,
});
const alreadySplit = txn({
  category_id: null, category_source: "manual", reviewed: true,
  splits: [{ id: 1, category_id: 1, amount: -60, note: null }, { id: 2, category_id: 2, amount: -25.5, note: null }],
});

function renderEditor(t: BankTransaction = txn()) {
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}><ToastProvider>
      <SplitEditor txn={t} categories={[groceries, household]} onDone={onDone} />
    </ToastProvider></QueryClientProvider>,
  );
  return onDone;
}
const amount = (n: number) => screen.getByLabelText(`Amount for piece ${n}`) as HTMLInputElement;
const category = (n: number) => screen.getByLabelText(`Category for piece ${n}`) as HTMLSelectElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => { setSplits.mockClear(); restore.mockClear(); });

describe("SplitEditor", () => {
  it("starts with the whole amount in the current category and an empty second piece", () => {
    renderEditor();
    expect(category(1).value).toBe("1");
    expect(amount(1).value).toBe("85.50");
    expect(amount(2).value).toBe("");
    expect(screen.getByText("Every piece needs an amount.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save split" })).toBeDisabled();
  });

  it("says what is left to assign, or how much too much", () => {
    renderEditor();
    type(amount(1), "60");
    type(amount(2), "20");
    expect(screen.getByText("$5.50 left to assign.")).toBeInTheDocument();
    type(amount(2), "30");
    expect(screen.getByText("$4.50 more than the transaction.")).toBeInTheDocument();
  });

  it("saves pieces with the transaction's sign, then Undo puts the row back", async () => {
    const onDone = renderEditor();
    type(amount(1), "60");
    type(category(2), "2");
    type(amount(2), "25.50");
    expect(screen.getByText("Adds up to $85.50.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save split" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setSplits).toHaveBeenCalledWith(7, [
      { category_id: 1, amount: -60, note: null },
      { category_id: 2, amount: -25.5, note: null },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith([
      { id: 7, category_id: 1, category_source: "auto", reviewed: false, removed: false },
    ]));
    expect(setSplits).toHaveBeenLastCalledWith(7, []);
  });

  it("adds a piece, and removes one once there are more than two", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: "Remove piece 1" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add piece" }));
    expect(amount(3)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove piece 3" }));
    expect(screen.queryByLabelText("Amount for piece 3")).toBeNull();
  });

  it("offers Unsplit only for a transaction that is already split", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: "Unsplit" })).toBeNull();
  });

  it("opens a split transaction on its pieces, and Unsplit sends none — undoable", async () => {
    const onDone = renderEditor(alreadySplit);
    expect(amount(1).value).toBe("60.00");
    expect(amount(2).value).toBe("25.50");

    fireEvent.click(screen.getByRole("button", { name: "Unsplit" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setSplits).toHaveBeenCalledWith(7, []);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(setSplits).toHaveBeenLastCalledWith(7, [
      { category_id: 1, amount: -60, note: null },
      { category_id: 2, amount: -25.5, note: null },
    ]));
  });

  it("cancels without saving", () => {
    const onDone = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
    expect(setSplits).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/spending/SplitEditor.test.tsx`
Expected: FAIL — `Failed to resolve import "./SplitEditor"`.

- [ ] **Step 3: Add `useOfferSplitUndo`**

In `src/data/undo.ts`, after the whole `useOfferUndo` function (before `const ASK_KEY`), add:

```ts
/** Undo for a split or an unsplit: the pieces go back first, then the row's
 *  own category, source and review state. The pieces must come first, because
 *  saving pieces empties the row's category. */
async function undoSplit(before: BankTransaction): Promise<void> {
  await api.bankTransactions.setSplits(
    before.id,
    before.splits.map(({ category_id, amount, note }) => ({ category_id, amount, note })),
  );
  await api.bankTransactions.restore([stateOf(before)]);
}

/**
 * After saving or clearing a split, offer Undo. Plain promises rather than a
 * mutation: the editor that called this has closed by the time Undo is
 * clicked, and the query client and toasts outlive it.
 */
export function useOfferSplitUndo() {
  const qc = useQueryClient();
  const toast = useToast();
  return (title: string, before: BankTransaction) => {
    toast.push({
      tone: "neutral",
      title,
      action: {
        label: "Undo",
        onClick: () => {
          undoSplit(before)
            .then(() => qc.invalidateQueries({ queryKey: ["bankTxns"] }))
            .catch((e) => toast.push({ tone: "neg", title: "Couldn't undo", body: String(e) }));
        },
      },
    });
  };
}
```

- [ ] **Step 4: Write the editor**

Create `src/features/spending/SplitEditor.tsx`:

```tsx
import { useState } from "react";
import { useSetSplits } from "../../data/queries";
import { useOfferSplitUndo } from "../../data/undo";
import { validateSplits, type Piece, type SplitProblem } from "../../domain/splits";
import { money } from "../../ui/format";
import { Button } from "../../ui/components";
import type { BankTransaction, Category } from "../../domain/types";

interface Draft { category_id: number | null; amount: string }

/** A typed amount in dollars; blank or nonsense is 0, which the check catches. */
function dollarsOf(text: string): number {
  const n = Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** A split row opens on its pieces; any other on its category holding all of
 *  it, beside an empty piece to type into. */
function firstDrafts(t: BankTransaction): Draft[] {
  if (t.splits.length > 0) {
    return t.splits.map((s) => ({ category_id: s.category_id, amount: Math.abs(s.amount).toFixed(2) }));
  }
  return [
    { category_id: t.category_id, amount: Math.abs(t.amount).toFixed(2) },
    { category_id: null, amount: "" },
  ];
}

function statusLine(problem: SplitProblem | null, left: number, total: number): string {
  switch (problem) {
    case "too-few": return "Split it into at least two pieces.";
    case "no-amount": return "Every piece needs an amount.";
    case "short": return `${money(Math.abs(left))} left to assign.`;
    case "over": return `${money(Math.abs(left))} more than the transaction.`;
    default: return `Adds up to ${money(Math.abs(total))}.`;
  }
}

/**
 * Divide one transaction across categories. Amounts are typed as plain
 * positive numbers and take the transaction's sign, so a refund splits the
 * same way a purchase does. Save stays disabled until the pieces add up;
 * Rust checks the same rules again.
 */
export function SplitEditor({ txn, categories, onDone }: {
  txn: BankTransaction;
  categories: Category[];
  /** Close the editor: after saving, unsplitting or cancelling. */
  onDone: () => void;
}) {
  const setSplits = useSetSplits();
  const offerUndo = useOfferSplitUndo();
  const [drafts, setDrafts] = useState<Draft[]>(() => firstDrafts(txn));
  const sign = txn.amount < 0 ? -1 : 1;
  const pieces: Piece[] = drafts.map((d) => ({ category_id: d.category_id, amount: sign * dollarsOf(d.amount) }));
  const { left, problem } = validateSplits(txn.amount, pieces);
  const update = (i: number, change: Partial<Draft>) =>
    setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...change } : d)));

  function save(next: Piece[], title: string) {
    // txn is the row as it was before: exactly what Undo puts back.
    setSplits.mutate(
      { id: txn.id, splits: next.map((p) => ({ ...p, note: null })) },
      { onSuccess: () => { offerUndo(title, txn); onDone(); } },
    );
  }

  return (
    <div style={{ display: "grid", gap: 8, padding: "6px 0 10px" }}>
      <div className="muted" style={{ fontSize: 12 }}>
        Split {money(Math.abs(txn.amount))} from {txn.payee ?? txn.description} across categories.
      </div>
      {drafts.map((d, i) => (
        <div key={i} className="row center" style={{ gap: 8 }}>
          <select
            value={d.category_id ?? ""}
            onChange={(e) => update(i, { category_id: e.target.value === "" ? null : Number(e.target.value) })}
            aria-label={`Category for piece ${i + 1}`}
            style={{ padding: "4px 6px", fontSize: 12, maxWidth: 168 }}
          >
            <option value="">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input
            value={d.amount}
            onChange={(e) => update(i, { amount: e.target.value })}
            inputMode="decimal" placeholder="0.00"
            aria-label={`Amount for piece ${i + 1}`}
            style={{ width: 96 }}
          />
          {drafts.length > 2 && (
            <button className="btn btn-ghost btn-sm" aria-label={`Remove piece ${i + 1}`}
              onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>×</button>
          )}
        </div>
      ))}
      <div className="row center" style={{ gap: 10, flexWrap: "wrap" }}>
        <button className="btn btn-ghost btn-sm"
          onClick={() => setDrafts([...drafts, { category_id: null, amount: "" }])}>Add piece</button>
        <span className={problem == null ? "muted" : "neg"} style={{ fontSize: 12 }}>
          {statusLine(problem, left, txn.amount)}
        </span>
      </div>
      {setSplits.error && <div className="neg" style={{ fontSize: 12 }}>{String(setSplits.error)}</div>}
      <div className="row center" style={{ gap: 8 }}>
        <Button size="sm" disabled={problem != null} loading={setSplits.isPending}
          onClick={() => save(pieces, "Split saved")}>Save split</Button>
        {txn.splits.length > 0 && (
          <Button size="sm" variant="secondary" disabled={setSplits.isPending}
            onClick={() => save([], "Unsplit")}>Unsplit</Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/spending/SplitEditor.test.tsx`
Expected: PASS, 7 tests.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/data/undo.ts src/features/spending/SplitEditor.tsx src/features/spending/SplitEditor.test.tsx
git commit -m "feat(spending): an editor for splitting a transaction

Pick a category and an amount for each piece; it says how much is left
to assign and saves only once the pieces add up. Unsplit clears a
split, and both offer Undo.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Split in the transaction list (and Activity)

**Files:**
- Modify: `src/features/spending/TransactionList.tsx`
- Modify: `src/features/spending/TransactionList.test.tsx`
- Modify: `src/features/activity/Activity.tsx`

- [ ] **Step 1: Write the failing tests**

In `src/features/spending/TransactionList.test.tsx`, replace:

```ts
const category: Category = { id: 1, name: "Shopping", kind: "spending", colour: "chart-2", sort: 70, is_builtin: true };
```

with:

```ts
const category: Category = { id: 1, name: "Shopping", kind: "spending", colour: "chart-2", sort: 70, is_builtin: true };
const split = (over: Partial<BankTransaction> = {}): BankTransaction => txn({
  amount: -85.5, category_id: null, category_source: "manual", reviewed: true,
  splits: [{ id: 1, category_id: 1, amount: -60, note: null }, { id: 2, category_id: null, amount: -25.5, note: null }],
  ...over,
});
```

At the end of the file, add:

```tsx
describe("TransactionList splits", () => {
  it("opens the split editor from a row's Split button", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Split Target" }));
    expect(screen.getByLabelText("Amount for piece 1")).toHaveValue("9.00");
  });

  it("shows a split row's pieces instead of the category picker", () => {
    renderList({ transactions: [split()] });
    expect(screen.queryByLabelText("Category for Target")).toBeNull();
    expect(screen.queryByRole("button", { name: "Split Target" })).toBeNull();
    expect(screen.getByText("Shopping")).toBeInTheDocument();
    expect(screen.getByText("$60.00")).toBeInTheDocument();
    expect(screen.getByText("Uncategorised")).toBeInTheDocument();
    expect(screen.getByText("$25.50")).toBeInTheDocument();
  });

  it("edits a split from its Edit split button", () => {
    renderList({ transactions: [split()] });
    fireEvent.click(screen.getByRole("button", { name: "Edit split for Target" }));
    expect(screen.getByLabelText("Amount for piece 2")).toHaveValue("25.50");
  });

  it("says when the bank's amount no longer matches the pieces", () => {
    renderList({ transactions: [split({ amount: -90 })] });
    expect(screen.getByText(/\$4\.50 not assigned/)).toBeInTheDocument();
  });

  it("offers no Split on a removed row", () => {
    renderList({ transactions: [txn({ removed: true })], onRestore: vi.fn() });
    expect(screen.queryByRole("button", { name: "Split Target" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/spending/TransactionList.test.tsx`
Expected: FAIL — no button named "Split Target"; the split row still shows the picker.

- [ ] **Step 3: Rewrite `TransactionList.tsx`**

Replace the whole of `src/features/spending/TransactionList.tsx` with:

```tsx
import { Fragment, useState } from "react";
import { useSetTransactionCategory } from "../../data/queries";
import { useOfferUndo } from "../../data/undo";
import { splitRemainder } from "../../domain/splits";
import { money, fmtDate } from "../../ui/format";
import { Badge } from "../../ui/components";
import { SplitEditor } from "./SplitEditor";
import type { Account, BankTransaction, Category } from "../../domain/types";

/**
 * The month's transactions with an inline category picker. Changing a category
 * marks that row as chosen by hand, and can teach Tally to do the same for
 * everything else from that payee. Split opens an editor beneath a row that
 * divides it across categories; a split row lists its pieces in place of the
 * picker.
 */
export function TransactionList({ transactions, categories, accounts, colourOf, onApprove, onRemove, onRestore }: {
  transactions: BankTransaction[];
  categories: Category[];
  accounts: Account[];
  colourOf: (token: string) => string;
  /** Offered on the To review list: accept a row as it is. */
  onApprove?: (id: number) => void;
  /** Take a row out of Spending — the owner was paid back. Restorable. */
  onRemove?: (id: number) => void;
  /** Put a removed row back. */
  onRestore?: (id: number) => void;
}) {
  const setCategory = useSetTransactionCategory();
  const offerUndo = useOfferUndo();
  const [teaching, setTeaching] = useState<number | null>(null);
  const [splitting, setSplitting] = useState<number | null>(null);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const accountName = (id: number) => accounts.find((a) => a.id === id)?.name ?? "—";
  const columns = 5 + (onApprove ? 1 : 0) + (onRemove || onRestore ? 1 : 0);

  function choose(t: BankTransaction, value: string) {
    const categoryId = value === "" ? null : Number(value);
    const payee = t.payee?.trim();
    // Offering to learn only makes sense when there is a payee to key off.
    if (categoryId != null && payee) {
      setTeaching(t.id);
    }
    // t is the row as it was before the change: exactly what Undo puts back.
    setCategory.mutate(
      { id: t.id, categoryId, applyToPayee: false },
      { onSuccess: () => offerUndo("Category changed", [t]) },
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="left">Date</th>
            <th className="left">Description</th>
            <th className="left">Account</th>
            <th className="left">Category</th>
            <th>Amount</th>
            {onApprove && <th />}
            {(onRemove || onRestore) && <th />}
          </tr>
        </thead>
        <tbody>
          {transactions.map((t) => {
            const category = t.category_id == null ? null : byId.get(t.category_id) ?? null;
            const incoming = t.amount > 0;
            const name = t.payee ?? t.description;
            const remainder = splitRemainder(t);
            return (
              <Fragment key={t.id}>
                <tr>
                  <td className="left">{fmtDate(t.posted)}</td>
                  <td className="left">
                    <div className="cell-primary">{name}</div>
                    {t.payee && t.description !== t.payee && (
                      <div className="cell-secondary">{t.description}</div>
                    )}
                    {t.note && <div className="cell-secondary" style={{ fontStyle: "italic" }}>{t.note}</div>}
                    {t.pending && <Badge tone="warn">Pending</Badge>}
                  </td>
                  <td className="left cell-secondary">{accountName(t.account_id)}</td>
                  <td className="left">
                    {t.splits.length > 0 ? (
                      <div style={{ display: "grid", gap: 3 }}>
                        {t.splits.map((s) => {
                          const c = s.category_id == null ? null : byId.get(s.category_id) ?? null;
                          return (
                            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12 }}>
                              <span style={{
                                width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                                background: c ? colourOf(c.colour) : "var(--line)",
                              }} />
                              <span>{c?.name ?? "Uncategorised"}</span>
                              <span className="muted n">{money(Math.abs(s.amount))}</span>
                            </div>
                          );
                        })}
                        {remainder !== 0 && (
                          <div className="cell-secondary">
                            {money(Math.abs(remainder))} not assigned — the bank changed the amount
                          </div>
                        )}
                        {!t.removed && (
                          <button className="btn btn-ghost btn-sm" style={{ justifySelf: "start", padding: "2px 0" }}
                            aria-label={`Edit split for ${name}`} onClick={() => setSplitting(t.id)}>
                            Edit split
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                          {category && (
                            <span style={{
                              width: 8, height: 8, borderRadius: 2, flexShrink: 0,
                              background: colourOf(category.colour),
                            }} />
                          )}
                          <select
                            value={t.category_id ?? ""}
                            onChange={(e) => choose(t, e.target.value)}
                            aria-label={`Category for ${name}`}
                            style={{ padding: "4px 6px", fontSize: 12, maxWidth: 168 }}
                          >
                            <option value="">Uncategorised</option>
                            {categories.map((c) => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                          {t.category_source === "manual" && (
                            <span className="muted" style={{ fontSize: 10 }} title="You chose this category">·</span>
                          )}
                          {!t.reviewed && (
                            <span title="To review" aria-label="To review" style={{
                              width: 6, height: 6, borderRadius: 3, background: "var(--accent)", flexShrink: 0,
                            }} />
                          )}
                          {!t.removed && (
                            <button className="btn btn-ghost btn-sm" aria-label={`Split ${name}`}
                              title="Split across categories" onClick={() => setSplitting(t.id)}>Split</button>
                          )}
                        </div>
                        {teaching === t.id && t.payee && (
                          <div className="row center" style={{ gap: 8, marginTop: 6 }}>
                            <button className="btn btn-secondary btn-sm" onClick={() => {
                              setCategory.mutate({ id: t.id, categoryId: t.category_id, applyToPayee: true });
                              setTeaching(null);
                            }}>
                              Apply to all “{t.payee}”
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setTeaching(null)}>Just this one</button>
                          </div>
                        )}
                      </>
                    )}
                  </td>
                  <td className={incoming ? "pos" : undefined} style={{ fontWeight: 600 }}>
                    {incoming ? "+" : ""}{money(t.amount)}
                  </td>
                  {onApprove && (
                    <td>
                      <button className="btn btn-ghost btn-sm" aria-label={`Approve ${name}`}
                        title="Looks right" onClick={() => onApprove(t.id)}>✓</button>
                    </td>
                  )}
                  {(onRemove || onRestore) && (
                    <td>
                      {t.removed ? (
                        onRestore && (
                          <button className="btn btn-ghost btn-sm" aria-label={`Restore ${name}`}
                            onClick={() => onRestore(t.id)}>Restore</button>
                        )
                      ) : (
                        onRemove && (
                          <button className="btn btn-ghost btn-sm" aria-label={`Remove ${name}`}
                            title="Remove from spending (paid back)" onClick={() => onRemove(t.id)}>×</button>
                        )
                      )}
                    </td>
                  )}
                </tr>
                {splitting === t.id && (
                  <tr>
                    <td className="left" colSpan={columns}>
                      <SplitEditor txn={t} categories={categories} onDone={() => setSplitting(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Show "Split" for a split bank row in Activity**

In `src/features/activity/Activity.tsx`, replace:

```tsx
    { key: "category", label: "Category", align: "left", render: (t) => <Badge>{categoryName(t.category_id)}</Badge> },
```

with:

```tsx
    // A split row's own category is empty; its pieces are shown in Spending.
    { key: "category", label: "Category", align: "left", render: (t) => (
        <Badge>{t.splits.length > 0 ? "Split" : categoryName(t.category_id)}</Badge>) },
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run src/features/spending src/features/activity`
Expected: PASS — the new split tests and every existing TransactionList, SearchPanel, SplitEditor and Activity test.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/features/spending/TransactionList.tsx src/features/spending/TransactionList.test.tsx src/features/activity/Activity.tsx
git commit -m "feat(spending): Split on every transaction

Each row has a Split button that opens the editor beneath it. A split
row lists its pieces instead of the category picker, says if the bank
later changed the amount, and can be edited again. Activity labels a
split bank row as Split.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Splits in the CSV export

**Files:**
- Modify: `src-tauri/src/backup/export.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/backup/export.rs`, in `every_file_is_written_with_names_instead_of_ids`, replace:

```rust
             INSERT INTO bank_transactions (account_id, external_id, posted, amount, description, category_id)
               VALUES (1, 'x1', '2026-10-03', -4.5, 'Coffee, large', 900);",
```

with:

```rust
             INSERT INTO bank_transactions (account_id, external_id, posted, amount, description, category_id)
               VALUES (1, 'x1', '2026-10-03', -4.5, 'Coffee, large', 900);
             INSERT INTO bank_transaction_splits (txn_id, category_id, amount, sort)
               VALUES (1, 900, -3, 0), (1, NULL, -1.5, 1);",
```

and replace:

```rust
        let bank = std::fs::read_to_string(folder.join("bank-transactions.csv")).unwrap();
        assert!(bank.contains("2026-10-03,Checking,\"Coffee, large\",,,-4.5,Test category,auto,,0\r\n"));
    }
```

with:

```rust
        let bank = std::fs::read_to_string(folder.join("bank-transactions.csv")).unwrap();
        assert!(bank.contains("2026-10-03,Checking,\"Coffee, large\",,,-4.5,Test category,auto,,0\r\n"));
        let splits = std::fs::read_to_string(folder.join("transaction-splits.csv")).unwrap();
        assert!(splits.starts_with("\u{FEFF}date,account,payee,transaction_amount,category,amount,note\r\n"));
        assert!(splits.contains("2026-10-03,Checking,\"Coffee, large\",-4.5,Test category,-3,\r\n"));
        assert!(splits.contains("2026-10-03,Checking,\"Coffee, large\",-4.5,,-1.5,\r\n"));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib backup::export; cd ..`
Expected: FAIL — `transaction-splits.csv` not found (`No such file`).

- [ ] **Step 3: Add the export**

In `src-tauri/src/backup/export.rs`, replace:

```rust
pub const EXPORTS: [(&str, &str); 7] = [
```

with:

```rust
pub const EXPORTS: [(&str, &str); 8] = [
```

and replace the last entry:

```rust
    (
        "category-rules.csv",
        "SELECT r.match_type, r.pattern, c.name AS category, r.created_at
         FROM category_rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.match_type, r.pattern",
    ),
];
```

with:

```rust
    (
        "category-rules.csv",
        "SELECT r.match_type, r.pattern, c.name AS category, r.created_at
         FROM category_rules r JOIN categories c ON c.id = r.category_id
         ORDER BY r.match_type, r.pattern",
    ),
    // One line per piece, beside the transaction it came from, so a split can
    // be rebuilt from bank-transactions.csv and this file alone.
    (
        "transaction-splits.csv",
        "SELECT b.posted AS date, a.name AS account, COALESCE(b.payee, b.description) AS payee,
                b.amount AS transaction_amount, c.name AS category, s.amount, s.note
         FROM bank_transaction_splits s
         JOIN bank_transactions b ON b.id = s.txn_id
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN categories c ON c.id = s.category_id
         ORDER BY b.posted, b.id, s.sort",
    ),
];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib backup::; cd ..`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backup/export.rs
git commit -m "feat(backup): split pieces in the CSV export

Export now writes transaction-splits.csv: one line per piece, beside
the transaction it came from.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, and the whole suite

**Files:**
- Modify: `docs/TODO.md`, `docs/HANDOFF.md`, `README.md`

- [ ] **Step 1: Tick the TODO item**

In `docs/TODO.md`, replace:

```markdown
- [ ] **15. Split a transaction** across categories (one Costco trip →
      groceries + household). **(spec)**
```

with:

```markdown
- [x] **15. Split a transaction** across categories. Done 2026-10-25: Split
      on any row in Spending divides it into pieces with their own categories;
      budgets, search and the category filter count each piece.
```

- [ ] **Step 2: Describe it in HANDOFF**

In `docs/HANDOFF.md`, directly above the line beginning `- **Accounts**: create/list/delete,`, add:

```markdown
- **Split transactions** (Spending): Split on a row opens `SplitEditor`
  beneath it; the pieces (category + amount, carrying the transaction's sign)
  must add up to the cent, and Rust checks again (`store::set_splits`). They
  live in `bank_transaction_splits` (v9) and arrive on every listed row as
  `splits`. While split, the row's own `category_id` is NULL and
  `category_source` is `manual`, so syncs, re-sorts, transfer pairing and the
  Copilot import leave it alone. If a later sync changes the amount, the
  uncovered part counts as uncategorised and the row says so. Unsplit and
  Undo both work; choosing one category for the row ends a split.
```

In the "Gotchas worth knowing" section, directly above the line beginning `- **Never call the browser's \`confirm()\`;`, add:

```markdown
- **Never total or filter bank transactions by `category_id` alone.** A split
  row's own category is NULL; its pieces are what count. Read rows through
  `piecesOf()` / `inCategory()` in `src/domain/splits.ts`, as
  `summariseMonth`, search and Spending's category focus do.
```

Replace:

```markdown
The schema is at `user_version` **5**;
```

with:

```markdown
The schema is at `user_version` **9** (v9 adds `bank_transaction_splits`);
```

- [ ] **Step 3: Add it to the README's features**

In `README.md`, replace:

```markdown
- A "To review" list for anything new, and rules that learn from your choices
```

with:

```markdown
- A "To review" list for anything new, and rules that learn from your choices
- Split one purchase across several categories
```

- [ ] **Step 4: Run every test and the build check**

Run: `npm test`
Expected: PASS, every suite.

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib; cd ..`
Expected: PASS (the `#[ignore]` live tests stay ignored).

- [ ] **Step 5: Commit**

```bash
git add docs/TODO.md docs/HANDOFF.md README.md
git commit -m "docs: split transactions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Look at it in the running app (owner)**

Run `npm run tauri dev` (or the "Tally (test)" shortcut), open Spending, click **Split** on a purchase, divide it into two categories, Save, and check the Categories card moved by each piece; then Undo. This is the one check the tests cannot make.

---

## Self-review

- **Spec coverage:** table + v9 migration (Task 1); `set_splits` with all four rules, unsplit, manual/NULL parent, sync/re-sort/cascade/category-delete tests (Task 2); `TxnSplit`, `splits` on listed and review rows, command, registration (Task 3); TS types and every fixture (Task 4); `piecesOf`, `splitRemainder`, `validateSplits`, `inCategory` (Task 5); `summariseMonth` per piece (Task 6); search filter + haystack, Spending focus (Task 7); editor with left-to-assign, add/remove, disabled Save, Unsplit, Cancel, Undo via `useOfferSplitUndo` (Task 8); Split / Edit split buttons, pieces display, full-width editor row (Task 9); export 7 → 8 (Task 10); TODO, HANDOFF, README, v9 note (Task 11). Transfer pairing and the Copilot import are covered by the manual/NULL parent (they only touch `category_source='auto'`), pinned by Task 2's sync and re-sort test.
- **Placeholder scan:** none; every code step has the code.
- **Type consistency:** Rust `NewSplit { category_id, amount, note }` ↔ TS `NewSplit = Omit<TxnSplit, "id">` with snake_case fields (Tauri only renames top-level argument names, as with `RowState`); `setSplits(id, splits)` ↔ `bank_transaction_set_splits(id, splits)`; `SplitProblem` values used identically in `splits.ts` and `SplitEditor.tsx`; `piecesOf` / `inCategory` / `splitRemainder` names match across Tasks 5–9.
- **Known edge:** Undo of an *unsplit* re-saves the old pieces through `set_splits`, which re-checks that they add up. If a sync changed the amount between the split and the unsplit, that Undo is refused and the toast says "Couldn't undo" with the reason; the owner can split again by hand.
