//! Savings goals. A goal either follows one account's balance or holds an
//! amount the owner keeps up to date by hand. Working out the progress is pure
//! TypeScript in `src/domain/goals.ts`; this module only checks and stores.
use crate::db::Db;
use crate::models::{Goal, NewGoal};
use rusqlite::{params, Connection};

const COLS: &str = "id,name,target_amount,target_date,account_id,saved_amount,created_at";

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
        // chrono also accepts "2027-3-1", " 2027-03-01" and "+2027-03-01", so the
        // date must read back exactly as written.
        let exact = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == *date);
        if !exact {
            return Err("That date isn't a real day.".into());
        }
    }
    Ok(())
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

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
        for bad in [-1.0, f64::NAN, f64::INFINITY] {
            let mut g = goal("Trip", 100.0);
            g.saved_amount = bad;
            assert_eq!(validate(&g), Err("The amount saved can't be below $0.".to_string()), "{bad}");
        }
    }

    #[test]
    fn a_date_must_be_a_real_day() {
        for bad in ["2027-02-30", "2027-3-1", "March", "", " 2027-3-01", "+2027-3-01", "2027- 3-01"] {
            let mut g = goal("Trip", 100.0);
            g.target_date = Some(bad.into());
            assert_eq!(validate(&g), Err("That date isn't a real day.".to_string()), "{bad}");
        }
        let mut leap = goal("Trip", 100.0);
        leap.target_date = Some("2028-02-29".into());
        assert_eq!(validate(&leap), Ok(()));
        assert_eq!(validate(&goal("Trip", 100.0)), Ok(()));
    }

    #[test]
    fn a_sensible_goal_passes() {
        let g = NewGoal {
            name: "Emergency fund".into(), target_amount: 10_000.0,
            target_date: Some("2027-06-30".into()), account_id: Some(3), saved_amount: 250.0,
        };
        assert_eq!(validate(&g), Ok(()));
    }

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
}
