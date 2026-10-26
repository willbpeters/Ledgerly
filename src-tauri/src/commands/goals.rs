//! Savings goals. A goal either follows one account's balance or holds an
//! amount the owner keeps up to date by hand. Working out the progress is pure
//! TypeScript in `src/domain/goals.ts`; this module only checks and stores.
use crate::models::NewGoal;

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
