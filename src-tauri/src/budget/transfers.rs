//! Pairing money that left one of the owner's accounts with the same amount
//! arriving in another — a card autopay, savings to brokerage — so both sides
//! are filed as a transfer even when the wording says nothing.
//!
//! Pure: the caller decides which rows are eligible (automatic, not a payment
//! to a person) and writes the result.
use chrono::NaiveDate;

/// How far apart, in days, the two sides of a transfer may post. Card
/// payments and ACH moves settle in one to three business days.
pub const PAIR_WINDOW_DAYS: i64 = 5;

#[derive(Debug, Clone, PartialEq)]
pub struct Leg {
    pub id: i64,
    pub account_id: i64,
    /// YYYY-MM-DD
    pub posted: String,
    /// Negative is money out.
    pub amount: f64,
}

/// The ids of every leg that pairs, ascending. A pair is one leg out and one
/// leg in, equal to the cent, in different accounts, within
/// `PAIR_WINDOW_DAYS`. Each leg pairs at most once, closest dates first.
pub fn pair(legs: &[Leg]) -> Vec<i64> {
    let cents = |a: f64| (a * 100.0).round() as i64;
    let day = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();

    let mut candidates: Vec<(i64, i64, i64)> = Vec::new(); // (gap, out id, in id)
    for out in legs.iter().filter(|l| cents(l.amount) < 0) {
        for inc in legs.iter().filter(|l| cents(l.amount) == -cents(out.amount)) {
            if inc.account_id == out.account_id {
                continue;
            }
            let (Some(a), Some(b)) = (day(&out.posted), day(&inc.posted)) else { continue };
            let gap = (a - b).num_days().abs();
            if gap <= PAIR_WINDOW_DAYS {
                candidates.push((gap, out.id, inc.id));
            }
        }
    }
    candidates.sort();

    let mut used = std::collections::BTreeSet::new();
    for (_, out, inc) in candidates {
        if !used.contains(&out) && !used.contains(&inc) {
            used.insert(out);
            used.insert(inc);
        }
    }
    used.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leg(id: i64, account_id: i64, posted: &str, amount: f64) -> Leg {
        Leg { id, account_id, posted: posted.into(), amount }
    }

    #[test]
    fn a_card_payment_pairs_with_the_payment_received() {
        let legs = vec![
            leg(1, 10, "2026-10-12", -40.59), // Bank of America: "Chase Credit Card"
            leg(2, 20, "2026-10-11", 40.59),  // Chase: "Automatic Payment"
        ];
        assert_eq!(pair(&legs), vec![1, 2]);
    }

    #[test]
    fn amounts_a_cent_apart_do_not_pair() {
        assert!(pair(&[leg(1, 10, "2026-10-12", -40.59), leg(2, 20, "2026-10-12", 40.58)]).is_empty());
    }

    #[test]
    fn the_same_account_does_not_pair_with_itself() {
        // A refund of a purchase is not a transfer.
        assert!(pair(&[leg(1, 10, "2026-10-12", -25.00), leg(2, 10, "2026-10-13", 25.00)]).is_empty());
    }

    #[test]
    fn legs_more_than_five_days_apart_do_not_pair() {
        assert!(pair(&[leg(1, 10, "2026-10-01", -100.0), leg(2, 20, "2026-10-07", 100.0)]).is_empty());
        assert_eq!(pair(&[leg(1, 10, "2026-10-01", -100.0), leg(2, 20, "2026-10-06", 100.0)]), vec![1, 2]);
    }

    #[test]
    fn each_leg_pairs_once_closest_date_first() {
        let legs = vec![
            leg(1, 10, "2026-10-01", -50.0),
            leg(2, 20, "2026-10-04", 50.0),
            leg(3, 30, "2026-10-02", 50.0),
        ];
        // 1 pairs with 3 (one day) rather than 2 (three days); 2 is left alone.
        assert_eq!(pair(&legs), vec![1, 3]);
    }
}
