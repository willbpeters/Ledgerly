# Savings Goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Goals screen where the owner sets savings targets (an emergency fund, a trip, a house deposit) and sees how close each one is, with what it takes each month to reach it by its date.

**Architecture:** A `goals` table (migration v11) stores each goal; `src-tauri/src/commands/goals.rs` validates and stores them behind four Tauri commands. A goal either *follows an account* — its progress is that account's value from `derivePortfolio()`, so it moves with every sync — or holds an amount the owner updates by hand. All progress maths is pure TypeScript in `src/domain/goals.ts`; the screen (`src/features/goals/`) only renders it.

**Tech Stack:** Rust (rusqlite, chrono, Tauri 2 commands), React 19 + TypeScript, TanStack Query, Vitest + Testing Library.

**Order:** this is the third of three plans landing on one branch: splits (v9), recurring (v10), goals (v11). It assumes the other two have landed.

---

## Decisions made for you

- **Two ways to track a goal.** Follow one cash or brokerage account (automatic, best for a dedicated savings account), or update the amount by hand. Credit cards are not offered: a card balance is a debt, not savings.
- **A negative account balance counts as $0 saved**, never as negative progress.
- **A hidden account** has no value in `derivePortfolio()` (hidden accounts are filtered there, on purpose). A goal following one falls back to the amount last entered by hand and says why, rather than showing $0 and looking like data loss.
- **Deleting the followed account keeps the goal** (`ON DELETE SET NULL`); it becomes a by-hand goal with whatever amount it held.
- **"$X a month"** divides what is left by the months until the date (rounded up, never below one). No contribution history and no "on track / behind" verdict — that would need history Tally does not store yet.
- **Months are counted as 30.4375 days** (the average month), from today's local date to the target date, with UTC arithmetic on the ISO dates.

## Before you start

Run from the repo root in Git Bash:

```bash
grep -n "const TARGET_VERSION" src-tauri/src/db.rs
grep -n "pub const EXPORTS" src-tauri/src/backup/export.rs
```

Expected: `const TARGET_VERSION: i64 = 10;` and `pub const EXPORTS: [(&str, &str); 8] = [`. If either differs, the splits and recurring plans have not both landed: **stop and ask** rather than guessing version numbers.

Rust is not on `PATH` on this machine. Every `cargo` command below starts with `export PATH="$HOME/.cargo/bin:$PATH"`.

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src-tauri/src/db.rs` | Modify | v11 migration: the `goals` table |
| `src-tauri/src/models.rs` | Modify | `Goal`, `NewGoal` |
| `src-tauri/src/commands/goals.rs` | Create | `validate`, list/get/create/update/delete, four Tauri commands |
| `src-tauri/src/commands/mod.rs` | Modify | `pub mod goals;` |
| `src-tauri/src/lib.rs` | Modify | register the four commands |
| `src-tauri/src/backup/export.rs` | Modify | `goals.csv` |
| `src/domain/types.ts` | Modify | `Goal`, `NewGoal` |
| `src/data/api.ts` | Modify | `api.goals.*` |
| `src/data/queries.ts` | Modify | `useGoals`, `useCreateGoal`, `useUpdateGoal`, `useDeleteGoal`; refresh goals after an account delete or sync |
| `src/domain/goals.ts` (+ `.test.ts`) | Create | `savedFor`, `goalProgress` — pure |
| `src/features/goals/GoalForm.tsx` (+ `.test.tsx`) | Create | add/edit form and `readGoal` (the same rules as Rust) |
| `src/features/goals/Goals.tsx` (+ `.test.tsx`) | Create | the screen and `goalLine` |
| `src/app/icons.tsx` | Modify | `Icons.goal` |
| `src/app/IconRail.tsx` (+ `IconRail.test.tsx`) | Modify / Create | rail link |
| `src/app/CommandBar.tsx` (+ `CommandBar.test.ts`) | Modify / Create | screen title; export `titleFor` |
| `src/App.tsx` | Modify | `/goals` route |
| `docs/TODO.md`, `docs/HANDOFF.md`, `README.md` | Modify | record the feature |

---

### Task 1: v11 migration — the `goals` table

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/db.rs`, inside `mod tests`, directly above the existing test `fn v8_adds_a_removed_flag_that_starts_off()`, add:

```rust
    #[test]
    fn v11_adds_the_goals_table_and_running_it_twice_changes_nothing() {
        let conn = v1_database();
        apply_migrations(&conn).unwrap();
        // Stand in for a v10 database: everything but the goals table.
        conn.execute_batch("DROP TABLE goals;").unwrap();
        assert!(migration_pending(&conn).unwrap());

        apply_migrations(&conn).unwrap();
        apply_migrations(&conn).unwrap();

        assert!(table_exists(&conn, "goals").unwrap());
        assert!(!migration_pending(&conn).unwrap());
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 11);
    }
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib v11_adds_the_goals_table
```

Expected: FAIL — `no such table: goals` from the `DROP TABLE`.

- [ ] **Step 3: Add the migration**

1. Change the version constant (it reads `10` once the recurring plan has landed):

```rust
const TARGET_VERSION: i64 = 11;
```

2. In the doc comment directly above `TARGET_VERSION`, add the sentence `v11 adds the \`goals\` table.` after the sentence the recurring plan added for v10 and before ` To add a change later:`. Leave every other sentence as it is.

3. Directly above the existing line

```rust
/// The tables v3 is responsible for, used by the completeness check below.
```

add (the v9 and v10 functions the earlier plans added stay where they are, above this):

```rust
/// v11: savings goals. A goal follows one account's balance, or holds an amount
/// the owner keeps up to date by hand. Deleting the account keeps the goal and
/// turns it into a by-hand one, rather than losing what the owner set up.
const MIGRATION_11: &str = "
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_amount REAL NOT NULL,
  target_date TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  saved_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
";

fn v11_is_complete(conn: &Connection) -> rusqlite::Result<bool> {
    table_exists(conn, "goals")
}

/// IF NOT EXISTS throughout, so this is safe to re-run.
fn apply_v11(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(MIGRATION_11)
}
```

4. In `apply_migrations`, directly above `    set_user_version(conn, TARGET_VERSION)?;` (and below the v10 block), add:

```rust
    if !v11_is_complete(conn)? {
        apply_v11(conn)?;
    }
```

5. In `migration_pending`, the last condition currently reads `|| !v10_is_complete(conn)?)`. Make it:

```rust
        || !v10_is_complete(conn)?
        || !v11_is_complete(conn)?)
```

- [ ] **Step 4: Run the db tests**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib db::
```

Expected: all PASS, including the new test and `migrations_create_all_tables_and_set_version`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(goals): a goals table, as migration v11" -m "Each goal has a name, a target, an optional date, and either an account it follows or an amount kept up to date by hand. Deleting the account keeps the goal." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The rules a goal must meet

**Files:**
- Modify: `src-tauri/src/models.rs`
- Create: `src-tauri/src/commands/goals.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Add the models**

Append to `src-tauri/src/models.rs`:

```rust

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Goal {
    pub id: i64,
    pub name: String,
    pub target_amount: f64,
    /// YYYY-MM-DD, or None for a goal with no deadline.
    pub target_date: Option<String>,
    /// The account whose value is the progress; None when updated by hand.
    pub account_id: Option<i64>,
    /// Saved so far, for a goal updated by hand. Kept while an account is
    /// followed, so switching back to "by hand" finds it again.
    pub saved_amount: f64,
    pub created_at: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct NewGoal {
    pub name: String,
    pub target_amount: f64,
    pub target_date: Option<String>,
    pub account_id: Option<i64>,
    pub saved_amount: f64,
}
```

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/commands/goals.rs`:

```rust
//! Savings goals. A goal either follows one account's balance or holds an
//! amount the owner keeps up to date by hand. Working out the progress is pure
//! TypeScript in `src/domain/goals.ts`; this module only checks and stores.
use crate::models::NewGoal;

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(name: &str, target: f64) -> NewGoal {
        NewGoal { name: name.into(), target_amount: target, target_date: None, account_id: None, saved_amount: 0.0 }
    }

    #[test]
    fn a_goal_needs_a_name() {
        assert_eq!(validate(&goal("   ", 100.0)), Err("Give the goal a name.".to_string()));
    }

    #[test]
    fn a_target_must_be_above_zero() {
        for bad in [0.0, -5.0, f64::NAN, f64::INFINITY] {
            assert_eq!(validate(&goal("Trip", bad)), Err("Set a target above $0.".to_string()), "{bad}");
        }
    }

    #[test]
    fn the_amount_saved_cannot_be_below_zero() {
        let mut g = goal("Trip", 100.0);
        g.saved_amount = -1.0;
        assert_eq!(validate(&g), Err("The amount saved can't be below $0.".to_string()));
    }

    #[test]
    fn a_date_must_be_a_real_day() {
        for bad in ["2027-02-30", "2027-3-1", "March", ""] {
            let mut g = goal("Trip", 100.0);
            g.target_date = Some(bad.into());
            assert_eq!(validate(&g), Err("That date isn't a real day.".to_string()), "{bad}");
        }
        let mut leap = goal("Trip", 100.0);
        leap.target_date = Some("2028-02-29".into());
        assert_eq!(validate(&leap), Ok(()));
    }

    #[test]
    fn a_sensible_goal_passes() {
        let g = NewGoal {
            name: "Emergency fund".into(), target_amount: 10_000.0,
            target_date: Some("2027-06-30".into()), account_id: Some(3), saved_amount: 250.0,
        };
        assert_eq!(validate(&g), Ok(()));
    }
}
```

Add to `src-tauri/src/commands/mod.rs`, after `pub mod copilot;`:

```rust
pub mod goals;
```

- [ ] **Step 3: Run them to make sure they fail**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib commands::goals
```

Expected: FAIL to compile — `cannot find function \`validate\` in this scope`.

- [ ] **Step 4: Write `validate`**

In `src-tauri/src/commands/goals.rs`, below the `use` line and above `#[cfg(test)]`, add:

```rust

/// The rules a goal must meet. `GoalForm` checks the same ones first, so the
/// owner normally reads these words beside the form rather than from here.
pub fn validate(g: &NewGoal) -> Result<(), String> {
    if g.name.trim().is_empty() {
        return Err("Give the goal a name.".into());
    }
    // "Not above zero" rather than "at or below zero", so NaN fails too.
    if !(g.target_amount > 0.0) || !g.target_amount.is_finite() {
        return Err("Set a target above $0.".into());
    }
    if !(g.saved_amount >= 0.0) || !g.saved_amount.is_finite() {
        return Err("The amount saved can't be below $0.".into());
    }
    if let Some(date) = &g.target_date {
        // The length check refuses "2027-3-1", which chrono would accept.
        if date.len() != 10 || chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() {
            return Err("That date isn't a real day.".into());
        }
    }
    Ok(())
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib commands::goals
```

Expected: 5 PASS. (A `function is never used` warning for `validate` is expected until Task 3.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/models.rs src-tauri/src/commands/goals.rs src-tauri/src/commands/mod.rs
git commit -m "feat(goals): the rules a goal must meet" -m "A name, a target above \$0, nothing negative saved, and a real day when a date is given, each refused in plain words." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Storing goals, and the commands

**Files:**
- Modify: `src-tauri/src/commands/goals.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/commands/goals.rs`, inside `mod tests`, change the first line from `use super::*;` to:

```rust
    use super::*;
    use crate::db;
    use rusqlite::Connection;
```

and add these tests at the end of `mod tests`:

```rust

    fn account(conn: &Connection, name: &str) -> i64 {
        conn.execute(
            "INSERT INTO accounts (name,type,currency,created_at) VALUES (?1,'cash','USD','2026-10-01')",
            [name],
        ).unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn a_created_goal_is_listed_with_its_name_trimmed() {
        let conn = db::open_in_memory().unwrap();
        let made = create(&conn, &goal("  Emergency fund ", 10_000.0)).unwrap();
        assert_eq!(made.name, "Emergency fund");
        assert_eq!(made.target_amount, 10_000.0);
        assert_eq!(list(&conn).unwrap(), vec![made]);
    }

    #[test]
    fn a_goal_that_breaks_a_rule_is_not_saved() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(create(&conn, &goal("", 100.0)).unwrap_err(), "Give the goal a name.");
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn dated_goals_come_first_soonest_first_then_the_rest_in_the_order_made() {
        let conn = db::open_in_memory().unwrap();
        let mut later = goal("Car", 8000.0);
        later.target_date = Some("2028-01-01".into());
        let mut sooner = goal("Trip", 2000.0);
        sooner.target_date = Some("2027-03-01".into());
        create(&conn, &goal("Rainy day", 1000.0)).unwrap();
        create(&conn, &later).unwrap();
        create(&conn, &goal("House", 50_000.0)).unwrap();
        create(&conn, &sooner).unwrap();

        let names: Vec<String> = list(&conn).unwrap().into_iter().map(|g| g.name).collect();
        assert_eq!(names, vec!["Trip", "Car", "Rainy day", "House"]);
    }

    #[test]
    fn an_update_changes_every_field_but_when_it_was_made() {
        let conn = db::open_in_memory().unwrap();
        let savings = account(&conn, "Savings");
        let made = create(&conn, &goal("Trip", 2000.0)).unwrap();
        let changed = NewGoal {
            name: "Japan trip".into(), target_amount: 3500.0,
            target_date: Some("2027-04-01".into()), account_id: Some(savings), saved_amount: 120.0,
        };

        update(&conn, made.id, &changed).unwrap();

        let after = get(&conn, made.id).unwrap();
        assert_eq!(after.name, "Japan trip");
        assert_eq!(after.target_amount, 3500.0);
        assert_eq!(after.target_date.as_deref(), Some("2027-04-01"));
        assert_eq!(after.account_id, Some(savings));
        assert_eq!(after.saved_amount, 120.0);
        assert_eq!(after.created_at, made.created_at);
    }

    #[test]
    fn updating_a_goal_that_is_gone_says_so() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(update(&conn, 404, &goal("Trip", 10.0)), Err("That goal no longer exists.".to_string()));
    }

    #[test]
    fn a_goal_cannot_follow_an_account_that_does_not_exist() {
        let conn = db::open_in_memory().unwrap();
        let mut g = goal("Trip", 10.0);
        g.account_id = Some(999);
        assert_eq!(create(&conn, &g).unwrap_err(), "That account no longer exists. Choose another.");
    }

    #[test]
    fn deleting_the_account_a_goal_follows_keeps_the_goal() {
        let conn = db::open_in_memory().unwrap();
        let savings = account(&conn, "Savings");
        let mut g = goal("Trip", 2000.0);
        g.account_id = Some(savings);
        g.saved_amount = 300.0;
        let made = create(&conn, &g).unwrap();

        crate::commands::accounts::delete(&conn, savings).unwrap();

        let after = get(&conn, made.id).unwrap();
        assert_eq!(after.account_id, None, "the goal goes back to being updated by hand");
        assert_eq!(after.saved_amount, 300.0, "with the amount it last held");
    }

    #[test]
    fn delete_removes_only_that_goal() {
        let conn = db::open_in_memory().unwrap();
        let a = create(&conn, &goal("Trip", 10.0)).unwrap();
        let b = create(&conn, &goal("Car", 20.0)).unwrap();
        delete(&conn, a.id).unwrap();
        assert_eq!(list(&conn).unwrap(), vec![b]);
    }
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib commands::goals
```

Expected: FAIL to compile — `cannot find function \`create\``, `list`, `get`, `update`, `delete`.

- [ ] **Step 3: Write the storage functions and the commands**

In `src-tauri/src/commands/goals.rs`, replace the line

```rust
use crate::models::NewGoal;
```

with

```rust
use crate::db::Db;
use crate::models::{Goal, NewGoal};
use rusqlite::{params, Connection};

const COLS: &str = "id,name,target_amount,target_date,account_id,saved_amount,created_at";
```

and add, between the end of `validate` and `#[cfg(test)]`:

```rust

fn row_to_goal(r: &rusqlite::Row) -> rusqlite::Result<Goal> {
    Ok(Goal {
        id: r.get(0)?, name: r.get(1)?, target_amount: r.get(2)?, target_date: r.get(3)?,
        account_id: r.get(4)?, saved_amount: r.get(5)?, created_at: r.get(6)?,
    })
}

/// An account deleted while the form was open fails the foreign key; say that
/// in words instead of "FOREIGN KEY constraint failed".
fn friendly(e: rusqlite::Error) -> String {
    if e.to_string().contains("FOREIGN KEY") {
        "That account no longer exists. Choose another.".into()
    } else {
        e.to_string()
    }
}

/// Goals with a date first, soonest first, then the rest in the order made.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Goal>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM goals ORDER BY target_date IS NULL, target_date, id"
    ))?;
    let rows = stmt.query_map([], row_to_goal)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Goal> {
    conn.query_row(&format!("SELECT {COLS} FROM goals WHERE id=?1"), [id], row_to_goal)
}

pub fn create(conn: &Connection, g: &NewGoal) -> Result<Goal, String> {
    validate(g)?;
    conn.execute(
        "INSERT INTO goals (name,target_amount,target_date,account_id,saved_amount,created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![g.name.trim(), g.target_amount, g.target_date, g.account_id, g.saved_amount,
                chrono::Utc::now().to_rfc3339()],
    ).map_err(friendly)?;
    get(conn, conn.last_insert_rowid()).map_err(|e| e.to_string())
}

pub fn update(conn: &Connection, id: i64, g: &NewGoal) -> Result<(), String> {
    validate(g)?;
    let changed = conn.execute(
        "UPDATE goals SET name=?1, target_amount=?2, target_date=?3, account_id=?4, saved_amount=?5
         WHERE id=?6",
        params![g.name.trim(), g.target_amount, g.target_date, g.account_id, g.saved_amount, id],
    ).map_err(friendly)?;
    if changed == 0 {
        return Err("That goal no longer exists.".into());
    }
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM goals WHERE id=?1", [id])?;
    Ok(())
}

#[tauri::command]
pub fn goals_list(db: tauri::State<Db>) -> Result<Vec<Goal>, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn goals_create(db: tauri::State<Db>, goal: NewGoal) -> Result<Goal, String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    create(&conn, &goal)
}

#[tauri::command]
pub fn goals_update(db: tauri::State<Db>, id: i64, goal: NewGoal) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    update(&conn, id, &goal)
}

#[tauri::command]
pub fn goals_delete(db: tauri::State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap_or_else(|e| e.into_inner());
    delete(&conn, id).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Register the commands**

In `src-tauri/src/lib.rs`, inside `tauri::generate_handler![ … ]`, add these four lines as the last entries, directly above the closing `])` (after `commands::copilot::copilot_import,` and anything the earlier plans added after it):

```rust
            commands::goals::goals_list,
            commands::goals::goals_create,
            commands::goals::goals_update,
            commands::goals::goals_delete,
```

- [ ] **Step 5: Run the tests to make sure they pass**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib commands::goals
```

Expected: 13 PASS, and no `never used` warning for anything in `goals.rs`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/goals.rs src-tauri/src/lib.rs
git commit -m "feat(goals): store goals, and commands to list, add, change and delete them" -m "Dated goals list first, soonest first. Deleting the account a goal follows keeps the goal as a by-hand one." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Goals in the CSV export

**Files:**
- Modify: `src-tauri/src/backup/export.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/backup/export.rs`, inside `mod tests`, add after `every_file_is_written_with_names_instead_of_ids` (a separate test rather than more lines in that one, so this does not collide with what the splits plan added to it; that test already checks every file in `EXPORTS` exists):

```rust
    #[test]
    fn goals_are_exported_with_the_account_name() {
        let conn = crate::db::open_in_memory().unwrap();
        conn.execute_batch(
            "INSERT INTO accounts (id, name, type, created_at) VALUES (1, 'Savings', 'cash', '2026-10-01');
             INSERT INTO goals (name, target_amount, target_date, account_id, saved_amount, created_at)
               VALUES ('Trip', 2000, '2027-03-01', 1, 0, '2026-10-25'),
                      ('Rainy day', 500, NULL, NULL, 125.5, '2026-10-25');",
        )
        .unwrap();
        let out = tempfile::tempdir().unwrap();

        let folder = export_all(&conn, out.path(), day()).unwrap();

        let goals = std::fs::read_to_string(folder.join("goals.csv")).unwrap();
        assert_eq!(
            goals,
            "\u{FEFF}name,target_amount,target_date,account,saved_amount,created_at\r\n\
             Trip,2000,2027-03-01,Savings,0,2026-10-25\r\n\
             Rainy day,500,,,125.5,2026-10-25\r\n"
        );
    }
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib goals_are_exported
```

Expected: FAIL — `No such file or directory` reading `goals.csv`.

- [ ] **Step 3: Add the export**

Change the declaration (it reads `8` once the splits plan has landed):

```rust
pub const EXPORTS: [(&str, &str); 9] = [
```

and add this as the last entry of the array, directly above its closing `];`:

```rust
    (
        "goals.csv",
        "SELECT g.name, g.target_amount, g.target_date, a.name AS account, g.saved_amount, g.created_at
         FROM goals g LEFT JOIN accounts a ON a.id = g.account_id
         ORDER BY g.target_date IS NULL, g.target_date, g.id",
    ),
```

- [ ] **Step 4: Run the export tests to make sure they pass**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test --lib backup::export
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backup/export.rs
git commit -m "feat(goals): goals.csv in the export" -m "With the followed account's name rather than its id." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Types, API calls and query hooks

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/data/api.ts`
- Modify: `src/data/queries.ts`

There is no behaviour to test here: the type checker is the test, and the hooks are exercised by the screen tests in Tasks 7 and 8.

- [ ] **Step 1: Add the types**

Append to `src/domain/types.ts`:

```ts

/** A savings goal. It follows one account's value, or an amount kept up to date by hand. */
export interface Goal {
  id: number; name: string; target_amount: number;
  /** `YYYY-MM-DD`, or null for a goal with no deadline. */
  target_date: string | null;
  /** The account whose value is the progress; null when updated by hand. */
  account_id: number | null;
  /** Saved so far, for a goal updated by hand. */
  saved_amount: number;
  created_at: string;
}
/** A goal on its way to the database, before it has an id. */
export interface NewGoal {
  name: string; target_amount: number; target_date: string | null;
  account_id: number | null; saved_amount: number;
}
```

- [ ] **Step 2: Add the API calls**

In `src/data/api.ts`, add `Goal, NewGoal,` to the `import type { … } from "../domain/types";` list (as a new last line inside the braces).

Then add a `goals` block as the last entry of the `api` object, directly above its closing `};`. Today the object ends:

```ts
  accountTypes: {
    set: (id: number, kind: string) => invoke<void>("accounts_set_type", { id, kind }),
  },
};
```

Add after `accountTypes` (or after whichever block the earlier plans put last):

```ts
  goals: {
    list: () => invoke<Goal[]>("goals_list"),
    create: (goal: NewGoal) => invoke<Goal>("goals_create", { goal }),
    update: (id: number, goal: NewGoal) => invoke<void>("goals_update", { id, goal }),
    delete: (id: number) => invoke<void>("goals_delete", { id }),
  },
```

- [ ] **Step 3: Add the hooks**

In `src/data/queries.ts`, change the import line at the top from

```ts
import { api, type NewAccount, type NewTransaction } from "./api";
```

to

```ts
import { api, type NewAccount, type NewTransaction } from "./api";
import type { NewGoal } from "../domain/types";
```

Append to the end of the file:

```ts

// ---------- goals ----------

const goalsKey = ["goals"] as const;

export const useGoals = () => useQuery({ queryKey: goalsKey, queryFn: api.goals.list });

export function useCreateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (goal: NewGoal) => api.goals.create(goal),
    onSuccess: () => qc.invalidateQueries({ queryKey: goalsKey }),
  });
}
export function useUpdateGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; goal: NewGoal }) => api.goals.update(v.id, v.goal),
    onSuccess: () => qc.invalidateQueries({ queryKey: goalsKey }),
  });
}
export function useDeleteGoal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.goals.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: goalsKey }),
  });
}
```

- [ ] **Step 4: Refresh goals when an account goes away**

Deleting an account sets `account_id` to null on its goals in the database, and a sync can remove an account the owner stopped sharing; without a refetch the Goals screen would keep showing the old link.

In `useDeleteAccount`, the `onSuccess` today reads:

```ts
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.accounts });
      qc.invalidateQueries({ queryKey: keys.transactions });
      qc.invalidateQueries({ queryKey: keys.synced });
    },
```

Add one line at the end of it:

```ts
      // Its goals now follow nothing: the database set their account to null.
      qc.invalidateQueries({ queryKey: ["goals"] });
```

In `invalidateAfterSync`, below the existing line `  qc.invalidateQueries({ queryKey: ["bankTxns"] });`, add:

```ts
  // A sync can remove an account, which unlinks any goal following it.
  qc.invalidateQueries({ queryKey: ["goals"] });
```

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/data/api.ts src/data/queries.ts
git commit -m "feat(goals): types, API calls and query hooks for goals" -m "Goals refetch after an account is deleted or a sync removes one, since either unlinks the goal." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Progress maths

**Files:**
- Create: `src/domain/goals.ts`
- Test: `src/domain/goals.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/goals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { savedFor, goalProgress } from "./goals";
import type { Goal } from "./types";

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 1, name: "Trip", target_amount: 2000, target_date: null,
  account_id: null, saved_amount: 0, created_at: "2026-10-25T00:00:00Z", ...over,
});
const TODAY = "2026-10-25";

describe("savedFor", () => {
  it("uses the amount kept by hand when the goal follows no account", () => {
    expect(savedFor(goal({ saved_amount: 300 }), new Map())).toEqual({ saved: 300, source: "manual" });
  });

  it("uses the followed account's value", () => {
    expect(savedFor(goal({ account_id: 4, saved_amount: 300 }), new Map([[4, 1250.5]])))
      .toEqual({ saved: 1250.5, source: "account" });
  });

  it("counts an overdrawn account as nothing saved, not as going backwards", () => {
    expect(savedFor(goal({ account_id: 4 }), new Map([[4, -40]]))).toEqual({ saved: 0, source: "account" });
  });

  it("falls back to the amount kept by hand when the account is hidden", () => {
    expect(savedFor(goal({ account_id: 4, saved_amount: 300 }), new Map([[9, 5000]])))
      .toEqual({ saved: 300, source: "missing-account" });
  });
});

describe("goalProgress", () => {
  it("without a date, reports what is left and no monthly figure", () => {
    expect(goalProgress(goal(), 500, TODAY)).toEqual({
      saved: 500, target: 2000, remaining: 1500, fraction: 0.25, done: false,
      monthsLeft: null, perMonth: null, overdue: false,
    });
  });

  it("spreads what is left over the months until the date, rounding the months up", () => {
    // 25 Oct 2026 to 25 Mar 2027 is 151 days: 4.96 average months, so 5.
    const p = goalProgress(goal({ target_date: "2027-03-25" }), 500, TODAY);
    expect(p.monthsLeft).toBe(5);
    expect(p.perMonth).toBe(300);
    expect(p.overdue).toBe(false);
  });

  it("asks for all of it in one month when the date is under a month away", () => {
    const p = goalProgress(goal({ target_date: "2026-10-28" }), 500, TODAY);
    expect(p.monthsLeft).toBe(1);
    expect(p.perMonth).toBe(1500);
  });

  it("is due today, not overdue, on the target date itself", () => {
    const p = goalProgress(goal({ target_date: TODAY }), 500, TODAY);
    expect(p.monthsLeft).toBe(0);
    expect(p.perMonth).toBe(1500);
    expect(p.overdue).toBe(false);
  });

  it("is overdue once the date has passed without reaching the target", () => {
    const p = goalProgress(goal({ target_date: "2026-09-01" }), 500, TODAY);
    expect(p.overdue).toBe(true);
    expect(p.monthsLeft).toBe(0);
    expect(p.remaining).toBe(1500);
  });

  it("is done when the target is reached, to the cent, whatever the date", () => {
    const p = goalProgress(goal({ target_date: "2026-09-01" }), 1999.999, TODAY);
    expect(p).toMatchObject({ done: true, remaining: 0, fraction: 1, perMonth: null, overdue: false });
  });

  it("never shows more than a full bar or a negative amount left", () => {
    expect(goalProgress(goal(), 2600, TODAY)).toMatchObject({ remaining: 0, fraction: 1, done: true });
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
npx vitest run src/domain/goals.test.ts
```

Expected: FAIL — `Failed to resolve import "./goals"`.

- [ ] **Step 3: Write the module**

Create `src/domain/goals.ts`:

```ts
import type { Goal } from "./types";

export type SavedSource = "account" | "manual" | "missing-account";

/**
 * How much a goal has saved.
 *
 * A goal following an account reads that account's value — cash plus
 * holdings, from `derivePortfolio` — so it moves with every sync without the
 * owner touching it. An overdrawn account counts as nothing saved rather than
 * as negative progress. A hidden account has no value in the map (hidden
 * accounts are left out of every figure); the goal then falls back to the
 * amount last kept by hand and says so, because a bar dropping to zero reads
 * as lost money.
 */
export function savedFor(goal: Goal, accountValues: Map<number, number>): { saved: number; source: SavedSource } {
  if (goal.account_id == null) return { saved: goal.saved_amount, source: "manual" };
  const value = accountValues.get(goal.account_id);
  if (value == null) return { saved: goal.saved_amount, source: "missing-account" };
  return { saved: Math.max(0, value), source: "account" };
}

export interface GoalProgress {
  saved: number;
  target: number;
  /** Still to save; never below zero. */
  remaining: number;
  /** 0..1, for the bar. */
  fraction: number;
  done: boolean;
  /** Months until the date, rounded up; null for a goal with no date. */
  monthsLeft: number | null;
  /** What to set aside each month to make the date; null with no date, or once done. */
  perMonth: number | null;
  /** The date has passed and the target has not been reached. */
  overdue: boolean;
}

/** The average month across the Gregorian calendar's 400-year cycle. */
const DAYS_PER_MONTH = 30.4375;

/** Whole days from one `YYYY-MM-DD` to another. UTC, so a clock change never moves it. */
function daysBetween(from: string, to: string): number {
  const at = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((at(to) - at(from)) / 86_400_000);
}

const cents = (x: number) => Math.round(x * 100);

/** Where a goal stands on `today` (the local date, `YYYY-MM-DD`) with `saved` put by. */
export function goalProgress(goal: Goal, saved: number, today: string): GoalProgress {
  const target = goal.target_amount;
  // Compared in cents: 1999.999 saved towards 2000 is reached, not $0.00 short.
  const done = cents(saved) >= cents(target);
  const remaining = done ? 0 : target - saved;
  const fraction = done ? 1 : target > 0 ? Math.min(1, Math.max(0, saved / target)) : 0;
  if (goal.target_date == null) {
    return { saved, target, remaining, fraction, done, monthsLeft: null, perMonth: null, overdue: false };
  }
  const days = daysBetween(today, goal.target_date);
  const monthsLeft = Math.max(0, Math.ceil(days / DAYS_PER_MONTH));
  return {
    saved, target, remaining, fraction, done, monthsLeft,
    // At least one month: on the day itself, what is left is due now.
    perMonth: done ? null : remaining / Math.max(1, monthsLeft),
    overdue: days < 0 && !done,
  };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

```bash
npx vitest run src/domain/goals.test.ts
```

Expected: 11 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/goals.ts src/domain/goals.test.ts
git commit -m "feat(goals): progress towards a goal, and what it takes each month" -m "A goal following an account reads its value; a hidden account falls back to the amount kept by hand. What is left is spread over the months until the date, rounded up." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The add/edit form

**Files:**
- Create: `src/features/goals/GoalForm.tsx`
- Test: `src/features/goals/GoalForm.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/features/goals/GoalForm.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account, Goal } from "../../domain/types";

const create = vi.fn();
const update = vi.fn();

// Only the data layer is mocked; the form and the shared UI kit are real.
vi.mock("../../data/queries", () => ({
  useCreateGoal: () => ({ mutate: create, isPending: false }),
  useUpdateGoal: () => ({ mutate: update, isPending: false }),
}));

const { GoalForm, readGoal } = await import("./GoalForm");

const savings = {
  id: 1, name: "Savings", type: "cash", institution: null, currency: "USD", created_at: "",
  source: "manual", external_id: null, synced_balance: null, last_synced_at: null, hidden: false,
} as Account;

const blank = { name: "", target: "", date: "", track: "", saved: "" };

describe("readGoal", () => {
  it("reads amounts the way people type them", () => {
    expect(readGoal({ ...blank, name: " Trip ", target: "$2,000", saved: "250.50" })).toEqual({
      name: "Trip", target_amount: 2000, target_date: null, account_id: null, saved_amount: 250.5,
    });
  });

  it("treats a blank amount saved as nothing yet", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10" })).toMatchObject({ saved_amount: 0 });
  });

  it("refuses a day that does not exist", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", date: "2027-02-30" })).toBe("That date isn't a real day.");
  });

  it("refuses a negative amount saved", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", saved: "-5" })).toBe("The amount saved can't be below $0.");
  });

  it("refuses an amount saved that is not a number", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", saved: "lots" }))
      .toBe("Enter how much is saved so far, or leave it blank.");
  });

  it("keeps the amount kept by hand while an account is followed", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", track: "1", saved: "300" }))
      .toMatchObject({ account_id: 1, saved_amount: 300 });
  });

  it("ignores a stray amount saved while an account is followed", () => {
    expect(readGoal({ ...blank, name: "Trip", target: "10", track: "1", saved: "lots" }))
      .toMatchObject({ account_id: 1, saved_amount: 0 });
  });
});

describe("GoalForm", () => {
  const onDone = vi.fn();
  beforeEach(() => { create.mockClear(); update.mockClear(); onDone.mockClear(); });

  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("explains a missing name beside the form and sends nothing", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Target", "2000");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give the goal a name.");
    expect(create).not.toHaveBeenCalled();
  });

  it("explains a target of zero", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target", "0");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Set a target above $0.");
  });

  it("adds a goal updated by hand", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Trip");
    type("Target", "2000");
    type("By (optional)", "2027-03-01");
    type("Saved so far", "250");
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(create.mock.calls[0][0]).toEqual({
      name: "Trip", target_amount: 2000, target_date: "2027-03-01", account_id: null, saved_amount: 250,
    });
  });

  it("follows an account instead, and then asks for no amount", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    type("Name", "Emergency fund");
    type("Target", "10000");
    type("Track it with", "1");
    expect(screen.queryByLabelText("Saved so far")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add goal" }));
    expect(create.mock.calls[0][0]).toMatchObject({ account_id: 1, saved_amount: 0 });
  });

  it("edits a goal in place, starting from what it holds", () => {
    const goal: Goal = {
      id: 5, name: "Trip", target_amount: 2000, target_date: "2027-03-01",
      account_id: null, saved_amount: 300, created_at: "",
    };
    render(<GoalForm goal={goal} accounts={[savings]} onDone={onDone} />);
    expect(screen.getByLabelText("Name")).toHaveValue("Trip");
    type("Target", "2500");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(update.mock.calls[0][0]).toEqual({
      id: 5,
      goal: { name: "Trip", target_amount: 2500, target_date: "2027-03-01", account_id: null, saved_amount: 300 },
    });
  });

  it("cancels without sending anything", () => {
    render(<GoalForm accounts={[savings]} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
npx vitest run src/features/goals/GoalForm.test.tsx
```

Expected: FAIL — `Failed to resolve import "./GoalForm"`.

- [ ] **Step 3: Write the form**

Create `src/features/goals/GoalForm.tsx`:

```tsx
import { useState } from "react";
import { useCreateGoal, useUpdateGoal } from "../../data/queries";
import { Button, Field } from "../../ui/components";
import type { Account, Goal, NewGoal } from "../../domain/types";

/** The form's fields, as typed. `track` is "" for "by hand", else an account id. */
export interface GoalDraft { name: string; target: string; date: string; track: string; saved: string }

/** "$2,000" and "2000" both mean 2000. */
const amount = (text: string) => Number(text.replace(/[$,\s]/g, ""));

function isRealDay(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/**
 * The form's text as a goal, or the first thing wrong with it. The same rules
 * as `validate` in `commands/goals.rs`, checked here so a mistake is explained
 * beside the form rather than coming back as an error from Rust.
 */
export function readGoal(d: GoalDraft): NewGoal | string {
  if (!d.name.trim()) return "Give the goal a name.";
  const target = amount(d.target);
  if (d.target.trim() === "" || !Number.isFinite(target) || !(target > 0)) return "Set a target above $0.";
  const date = d.date.trim();
  if (date !== "" && !isRealDay(date)) return "That date isn't a real day.";
  const byHand = d.track === "";
  const saved = d.saved.trim() === "" ? 0 : amount(d.saved);
  if (byHand && !Number.isFinite(saved)) return "Enter how much is saved so far, or leave it blank.";
  if (byHand && saved < 0) return "The amount saved can't be below $0.";
  return {
    name: d.name.trim(),
    target_amount: target,
    target_date: date || null,
    account_id: byHand ? null : Number(d.track),
    // Kept while an account is followed, so switching back to "by hand" finds it again.
    saved_amount: Number.isFinite(saved) && saved >= 0 ? saved : 0,
  };
}

/**
 * Add a goal, or change one. `accounts` are the ones a goal may follow: the
 * caller passes visible cash and brokerage accounts only.
 */
export function GoalForm({ goal, accounts, onDone }: {
  goal?: Goal;
  accounts: Account[];
  onDone: () => void;
}) {
  const create = useCreateGoal();
  const update = useUpdateGoal();
  const [name, setName] = useState(goal?.name ?? "");
  const [target, setTarget] = useState(goal ? String(goal.target_amount) : "");
  const [date, setDate] = useState(goal?.target_date ?? "");
  const [track, setTrack] = useState(goal?.account_id == null ? "" : String(goal.account_id));
  const [saved, setSaved] = useState(goal && goal.saved_amount > 0 ? String(goal.saved_amount) : "");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const checked = readGoal({ name, target, date, track, saved });
    if (typeof checked === "string") {
      setError(checked);
      return;
    }
    setError(null);
    const options = { onSuccess: onDone, onError: (err: unknown) => setError(String(err)) };
    if (goal) update.mutate({ id: goal.id, goal: checked }, options);
    else create.mutate(checked, options);
  }

  return (
    <form className="row" onSubmit={submit}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Emergency fund" />
      </Field>
      <Field label="Target">
        <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" placeholder="10000" style={{ width: 110 }} />
      </Field>
      <Field label="By (optional)">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Track it with">
        <select value={track} onChange={(e) => setTrack(e.target.value)}>
          <option value="">I'll update it myself</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      {track === "" && (
        <Field label="Saved so far">
          <input value={saved} onChange={(e) => setSaved(e.target.value)} inputMode="decimal" placeholder="0" style={{ width: 110 }} />
        </Field>
      )}
      <Button type="submit" loading={create.isPending || update.isPending}>{goal ? "Save" : "Add goal"}</Button>
      <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      {error && <span className="field-error" role="alert">{error}</span>}
    </form>
  );
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

```bash
npx vitest run src/features/goals/GoalForm.test.tsx
```

Expected: 13 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/goals/GoalForm.tsx src/features/goals/GoalForm.test.tsx
git commit -m "feat(goals): a form to add or change a goal" -m "Name, target, an optional date, and either an account to follow or the amount saved so far. Mistakes are explained beside the form before anything is sent." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The Goals screen

**Files:**
- Create: `src/features/goals/Goals.tsx`
- Test: `src/features/goals/Goals.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/features/goals/Goals.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Account, Goal } from "../../domain/types";

const remove = vi.fn();
const ask = vi.fn();
let goals: Goal[] = [];

function account(id: number, name: string, type: Account["type"]): Account {
  return {
    id, name, type, institution: null, currency: "USD", created_at: "",
    source: "manual", external_id: null, synced_balance: null, last_synced_at: null, hidden: false,
  };
}

// Only the data layer, the clock and the confirm box are mocked; the screen,
// the form and the shared UI kit are real.
vi.mock("../../data/queries", () => ({
  useGoals: () => ({ data: goals, isLoading: false }),
  useCreateGoal: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateGoal: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteGoal: () => ({ mutate: remove }),
}));
vi.mock("../../data/usePortfolio", () => ({
  usePortfolio: () => ({
    accountValues: new Map<number, number>([[1, 1250]]),
    accounts: [account(1, "Savings", "cash"), account(2, "Card", "credit")],
    isLoading: false,
  }),
}));
vi.mock("../../ui/confirm", () => ({ askToConfirm: (...args: unknown[]) => ask(...args) }));
vi.mock("../../domain/dates", () => ({ localIsoDate: () => "2026-10-25" }));

const { Goals, goalLine } = await import("./Goals");

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 5, name: "Trip", target_amount: 2000, target_date: null,
  account_id: null, saved_amount: 0, created_at: "", ...over,
});

describe("Goals screen", () => {
  beforeEach(() => { remove.mockClear(); ask.mockReset(); goals = []; });

  it("invites the first goal when there are none", () => {
    render(<Goals />);
    expect(screen.getByText("No goals yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a goal" }));
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("shows a goal following an account at that account's value", () => {
    goals = [goal({ account_id: 1, target_date: "2027-03-25" })];
    render(<Goals />);
    expect(screen.getByText("$1,250.00")).toBeInTheDocument();
    expect(screen.getByText("of $2,000.00")).toBeInTheDocument();
    // $750 left over the 5 months to 25 March 2027.
    expect(screen.getByText("$150.00 a month to reach it by March 2027")).toBeInTheDocument();
    expect(screen.getByText("Following Savings")).toBeInTheDocument();
  });

  it("shows a goal kept by hand at the amount entered", () => {
    goals = [goal({ saved_amount: 300 })];
    render(<Goals />);
    expect(screen.getByText("$300.00")).toBeInTheDocument();
    expect(screen.getByText("$1,700.00 to go")).toBeInTheDocument();
    expect(screen.getByText("Updated by hand")).toBeInTheDocument();
  });

  it("explains a goal whose account is hidden", () => {
    goals = [goal({ account_id: 9, saved_amount: 300 })];
    render(<Goals />);
    expect(screen.getByText("Its account is hidden, so this shows the amount you last entered")).toBeInTheDocument();
  });

  it("offers only cash and investment accounts to follow", () => {
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Add a goal" }));
    expect(screen.getByRole("option", { name: "Savings" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Card" })).toBeNull();
  });

  it("opens the form with the goal's details to edit it", () => {
    goals = [goal({ saved_amount: 300 })];
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Trip" }));
    expect(screen.getByLabelText("Name")).toHaveValue("Trip");
  });

  it("deletes a goal only once the owner agrees", async () => {
    goals = [goal()];
    ask.mockResolvedValue(true);
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Trip" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(5));
    expect(ask.mock.calls[0][0]).toContain("Trip");
  });

  it("keeps the goal when the owner says no", async () => {
    goals = [goal()];
    ask.mockResolvedValue(false);
    render(<Goals />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Trip" }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("goalLine", () => {
  const p = { saved: 500, target: 2000, remaining: 1500, fraction: 0.25, done: false, monthsLeft: null, perMonth: null, overdue: false };

  it("says when a goal is reached", () => {
    expect(goalLine({ ...p, done: true, remaining: 0 }, null)).toBe("Reached");
  });

  it("says when the date has passed", () => {
    expect(goalLine({ ...p, overdue: true, monthsLeft: 0, perMonth: 1500 }, "2026-09-01"))
      .toBe("The date has passed — $1,500.00 to go");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
npx vitest run src/features/goals/Goals.test.tsx
```

Expected: FAIL — `Failed to resolve import "./Goals"`.

- [ ] **Step 3: Write the screen**

Create `src/features/goals/Goals.tsx`:

```tsx
import { useState } from "react";
import { useGoals, useDeleteGoal } from "../../data/queries";
import { usePortfolio } from "../../data/usePortfolio";
import { localIsoDate } from "../../domain/dates";
import { goalProgress, savedFor, type GoalProgress, type SavedSource } from "../../domain/goals";
import { monthLabel } from "../../domain/spending";
import { money, share } from "../../ui/format";
import { Button, Card, EmptyState, PageHeader } from "../../ui/components";
import { askToConfirm } from "../../ui/confirm";
import type { Account, Goal } from "../../domain/types";
import { GoalForm } from "./GoalForm";

/** The sentence under a goal's bar: what it takes from here. */
export function goalLine(p: GoalProgress, targetDate: string | null): string {
  if (p.done) return "Reached";
  if (p.overdue) return `The date has passed — ${money(p.remaining)} to go`;
  if (p.perMonth == null || targetDate == null) return `${money(p.remaining)} to go`;
  return `${money(p.perMonth)} a month to reach it by ${monthLabel(targetDate.slice(0, 7))}`;
}

/** Where the saved figure comes from, so a number that never moves is explained. */
function sourceLine(source: SavedSource, account: Account | undefined): string {
  if (source === "account") return `Following ${account?.name ?? "its account"}`;
  if (source === "missing-account") return "Its account is hidden, so this shows the amount you last entered";
  return "Updated by hand";
}

/**
 * What the owner is saving towards. Each goal follows an account's value or an
 * amount kept by hand; the maths is in `src/domain/goals.ts`.
 */
export function Goals() {
  const { data: goals = [], isLoading } = useGoals();
  const { accountValues, accounts, isLoading: loadingAccounts } = usePortfolio();
  const remove = useDeleteGoal();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const today = localIsoDate();
  // Money set aside lives in cash and investment accounts; a card balance is a
  // debt. `accounts` from usePortfolio already leaves hidden ones out.
  const trackable = accounts.filter((a) => a.type !== "credit");

  async function del(g: Goal) {
    if (await askToConfirm(`Delete the goal "${g.name}"? Your accounts and transactions are not touched.`)) {
      remove.mutate(g.id);
    }
  }

  if (isLoading || loadingAccounts) return <p className="muted">Loading…</p>;

  return (
    <>
      <PageHeader
        subtitle="What you're saving towards"
        actions={goals.length > 0 && editing !== "new" && (
          <Button size="sm" onClick={() => setEditing("new")}>Add a goal</Button>
        )}
      />

      {editing === "new" && (
        <Card title="New goal">
          <GoalForm accounts={trackable} onDone={() => setEditing(null)} />
        </Card>
      )}

      {goals.length === 0 && editing !== "new" && (
        <Card>
          <EmptyState
            title="No goals yet"
            body="Set a target, like an emergency fund, a trip or a house deposit, and Tally shows how close you are and what to put aside each month."
            action={<Button onClick={() => setEditing("new")}>Add a goal</Button>}
          />
        </Card>
      )}

      {goals.map((g) => {
        const { saved, source } = savedFor(g, accountValues);
        const p = goalProgress(g, saved, today);
        return (
          <Card
            key={g.id}
            title={g.name}
            actions={editing !== g.id && (
              <div className="row center" style={{ gap: 6 }}>
                <Button variant="ghost" size="sm" aria-label={`Edit ${g.name}`} onClick={() => setEditing(g.id)}>Edit</Button>
                <Button variant="ghost" size="sm" aria-label={`Delete ${g.name}`} onClick={() => del(g)}>Delete</Button>
              </div>
            )}
          >
            {editing === g.id ? (
              <GoalForm goal={g} accounts={trackable} onDone={() => setEditing(null)} />
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                <div className="row center between">
                  <div>
                    <span className="n" style={{ fontWeight: 600, fontSize: 18 }}>{money(p.saved)}</span>{" "}
                    <span className="muted">of {money(p.target)}</span>
                  </div>
                  <span className="n muted">{share(p.fraction)}</span>
                </div>
                <span className="bar-track" style={{ width: "auto", height: 8 }}>
                  <span className="bar-fill" style={{
                    width: `${p.fraction * 100}%`,
                    background: p.done ? "var(--pos)" : undefined,
                  }} />
                </span>
                <div className={p.overdue ? "neg" : p.done ? "pos" : undefined}>{goalLine(p, g.target_date)}</div>
                <div className="muted" style={{ fontSize: 11 }}>
                  {sourceLine(source, accounts.find((a) => a.id === g.account_id))}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

```bash
npx vitest run src/features/goals
```

Expected: all PASS (10 here, 13 in `GoalForm.test.tsx`). Also run the guard against `confirm()`:

```bash
npx vitest run src/ui/confirm.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/goals/Goals.tsx src/features/goals/Goals.test.tsx
git commit -m "feat(goals): a Goals screen" -m "One card per goal: saved of target, a bar, what it takes each month to make the date, and where the figure comes from. Edit in place; delete asks first." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Route, rail link and screen title

**Files:**
- Modify: `src/app/icons.tsx`
- Modify: `src/app/IconRail.tsx`
- Create: `src/app/IconRail.test.tsx`
- Modify: `src/app/CommandBar.tsx`
- Create: `src/app/CommandBar.test.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/app/IconRail.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect } from "vitest";
import { IconRail } from "./IconRail";

describe("IconRail", () => {
  it("links to Goals", () => {
    render(<MemoryRouter><IconRail /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "Goals" })).toHaveAttribute("href", "/goals");
  });
});
```

Create `src/app/CommandBar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { titleFor } from "./CommandBar";

describe("titleFor", () => {
  it("names the Goals screen", () => {
    expect(titleFor("/goals")).toBe("Goals");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
npx vitest run src/app/IconRail.test.tsx src/app/CommandBar.test.ts
```

Expected: FAIL — `Unable to find an accessible element with the role "link" and name "Goals"`, and `titleFor is not a function` (it is not exported yet).

- [ ] **Step 3: Add the icon, the link, the title and the route**

In `src/app/icons.tsx`, directly below the `budget:` line, add:

```tsx
  goal: (p: P = {}) => <svg {...S(p)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.25" fill="currentColor" /></svg>,
```

In `src/app/IconRail.tsx`, below

```tsx
  { to: "/spending", label: "Spending", icon: Icons.budget },
```

add

```tsx
  { to: "/goals", label: "Goals", icon: Icons.goal },
```

In `src/app/CommandBar.tsx`, below `  { path: "/spending", title: "Spending" },` add

```tsx
  { path: "/goals", title: "Goals" },
```

and change

```tsx
function titleFor(pathname: string): string {
```

to

```tsx
export function titleFor(pathname: string): string {
```

In `src/App.tsx`, below `import { Spending } from "./features/spending/Spending";` add

```tsx
import { Goals } from "./features/goals/Goals";
```

and below `      { path: "spending", element: <Spending /> },` add

```tsx
      { path: "goals", element: <Goals /> },
```

- [ ] **Step 4: Run the tests and the type check**

```bash
npx vitest run src/app && npx tsc --noEmit
```

Expected: all PASS; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/app/icons.tsx src/app/IconRail.tsx src/app/IconRail.test.tsx src/app/CommandBar.tsx src/app/CommandBar.test.ts src/App.tsx
git commit -m "feat(goals): Goals on the rail, below Spending" -m "A target icon, its own route, and the screen's name in the command bar." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Record it, and check everything

**Files:**
- Modify: `docs/TODO.md`
- Modify: `docs/HANDOFF.md`
- Modify: `README.md`

- [ ] **Step 1: TODO.md**

In `docs/TODO.md`, directly above the line `## Phase 4 — Correct numbers for a real portfolio` (and below item 15 and anything the earlier plans added), add:

```markdown
- [x] **15b. Savings goals.** Done 2026-10-25: a Goals screen (on the rail
      below Spending) with a target, an optional date, and either an account
      to follow or an amount kept by hand; shows what to put aside each month
      to make the date. In the CSV export as `goals.csv`.

```

- [ ] **Step 2: HANDOFF.md**

In `docs/HANDOFF.md`, under "What's built", directly above the bullet that starts `- **Import from Copilot** (Settings):`, add:

```markdown
- **Goals** (`/goals`, on the rail below Spending): savings targets with an
  optional date. A goal **follows an account** — its progress is that
  account's value from `derivePortfolio()`, so it moves with each sync — or
  holds an amount the owner updates by hand. Only visible cash and brokerage
  accounts can be followed (a card balance is a debt). The screen shows saved
  of target, a bar, and what to set aside each month to make the date: what is
  left divided by the months to go, rounded up, never fewer than one. Maths is
  pure in `src/domain/goals.ts`; storage and the rules in
  `src-tauri/src/commands/goals.rs`, mirrored by `readGoal` in
  `src/features/goals/GoalForm.tsx` so mistakes are explained beside the form.
```

In the Gotchas list, directly above the bullet that starts `- **Never call the browser's \`confirm()\``, add:

```markdown
- **v11 adds `goals`.** `account_id` is `ON DELETE SET NULL`: deleting the
  followed account keeps the goal as a by-hand one with its last
  `saved_amount`, and the Goals query is refetched after an account delete or
  a sync for that reason. **A goal following a hidden account** has no value in
  `derivePortfolio()` (hidden accounts are filtered there) and falls back to
  `saved_amount`, saying so on the card — showing $0 would read as lost money.
```

In the line that reads `**unencrypted**. The schema is at \`user_version\` **…**; migrations are`, set the version figure to **11**.

- [ ] **Step 3: README.md**

In `README.md`, directly above the line `**Bank sync**`, add:

```markdown
**Goals**
- Savings goals with a target and an optional date
- Follow a savings account automatically, or update the amount yourself
- What to put aside each month to get there in time

```

- [ ] **Step 4: Run everything**

```bash
npx vitest run
npx tsc --noEmit
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test
```

Expected: every Vitest test passes; `tsc` prints nothing; `cargo test` reports `0 failed` (the `#[ignore]`d live tests stay ignored). If anything fails, fix it before committing — do not commit a red suite.

- [ ] **Step 5: Commit**

```bash
git add docs/TODO.md docs/HANDOFF.md README.md
git commit -m "docs: savings goals" -m "TODO, HANDOFF (what's built, the v11 notes) and the README feature list." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Look at it in the app (the owner's step)**

Run `npm run tauri dev` (or the "Tally (test)" Desktop shortcut). Open **Goals** from the rail, add one goal following a savings account and one updated by hand with a date, then check: the followed goal shows the account's balance from Accounts; the monthly figure looks right; Edit and Delete work; Settings → Backups → Export writes `goals.csv`.

---

## Self-review

- **Coverage of the pinned design:** table and migration v11 (Task 1); `Goal`/`NewGoal`, `validate` with the plain messages (Task 2); list ordering, create/update/delete, account delete keeps the goal (Task 3); `goals.csv` with the account name (Task 4); types, `api.goals`, the four hooks on a `goals` key (Task 5); `savedFor` and `goalProgress` with the exact rules (Task 6); `GoalForm` with "Track it with" / "I'll update it myself" / "Saved so far" and inline validation mirroring Rust (Task 7); the screen with bar, "$X of $Y", the three kinds of line, "Following …" / "Updated by hand", Edit, Delete via `askToConfirm`, empty state with "Add a goal" (Task 8); route, rail link with `Icons.goal`, command-bar title (Task 9); TODO, HANDOFF, README (Task 10).
- **Deviation:** the export test is a new `goals_are_exported_with_the_account_name` rather than more lines in `every_file_is_written_with_names_instead_of_ids`, so it cannot collide with the splits plan's edits to that test; the existing test still checks `goals.csv` is written, since it loops over `EXPORTS`.
- **Added beyond the pin:** goals refetch after an account delete or a sync (Task 5, Step 4), because both unlink goals in the database; a separate "not a number" message in `readGoal` for the saved field (Rust only ever receives numbers).
- **Type consistency:** `Goal`/`NewGoal` fields match across `models.rs`, `types.ts`, the SQL columns and `COLS`; `api.goals.update(id, goal)` ↔ `goals_update(id, goal)`; `useUpdateGoal` takes `{ id, goal }` and the form test asserts that shape; `GoalProgress` fields match between `goals.ts`, `goalLine` and the tests; `SavedSource` values match `sourceLine`.
- **Numbers checked by hand:** 2026-10-25 → 2027-03-25 is 31+30+31+31+28 = 151 days, 151 / 30.4375 = 4.96 → 5 months; $1,500 / 5 = $300 and $750 / 5 = $150. f64 `2000.0` prints as `2000` and `125.5` as `125.5` in the export, matching the existing test's `500` and `-4.5`.
