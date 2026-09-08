//! Deciding which category a bank transaction belongs to.
//!
//! Pure: no database, no network. The caller loads the user's rules and
//! resolves the returned category name to an id.

use super::mcc;

/// A rule the user created by correcting a category.
#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    /// "payee", "description" or "mcc"
    pub match_type: String,
    /// Lower-cased substring, or an exact MCC.
    pub pattern: String,
    pub category_id: i64,
}

/// The fields a decision is made from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Candidate {
    pub payee: Option<String>,
    pub description: String,
    pub mcc: Option<String>,
    pub amount: f64,
}

/// What categorisation decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// A user rule matched; use this category id.
    Rule(i64),
    /// The merchant code mapped to a built-in category, named here.
    Builtin(&'static str),
    /// Money coming in with nothing else to go on.
    Income,
    /// Nothing matched; leave it uncategorised for the user to sort out.
    None,
}

fn contains(haystack: &str, needle: &str) -> bool {
    !needle.is_empty() && haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Decide a category. Rules beat the merchant-code map, which beats the
/// sign of the amount. Manual categories are honoured by the caller, which
/// simply does not ask about them.
pub fn decide(c: &Candidate, rules: &[Rule]) -> Decision {
    // 1. Exact MCC rules, the most specific thing a user can write.
    if let Some(code) = c.mcc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(r) = rules.iter().find(|r| r.match_type == "mcc" && r.pattern.trim() == code) {
            return Decision::Rule(r.category_id);
        }
    }
    // 2. Payee rules.
    if let Some(payee) = c.payee.as_deref() {
        if let Some(r) = rules.iter().find(|r| r.match_type == "payee" && contains(payee, &r.pattern)) {
            return Decision::Rule(r.category_id);
        }
    }
    // 3. Description rules.
    if let Some(r) = rules.iter().find(|r| r.match_type == "description" && contains(&c.description, &r.pattern)) {
        return Decision::Rule(r.category_id);
    }
    // 4. The built-in merchant-code map.
    if let Some(code) = c.mcc.as_deref() {
        if let Some(name) = mcc::category_for(code) {
            return Decision::Builtin(name);
        }
    }
    // 5. Money in, with nothing else to go on.
    if c.amount > 0.0 {
        return Decision::Income;
    }
    Decision::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(match_type: &str, pattern: &str, id: i64) -> Rule {
        Rule { match_type: match_type.into(), pattern: pattern.into(), category_id: id }
    }
    fn candidate(payee: Option<&str>, description: &str, mcc: Option<&str>, amount: f64) -> Candidate {
        Candidate {
            payee: payee.map(str::to_string),
            description: description.into(),
            mcc: mcc.map(str::to_string),
            amount,
        }
    }

    #[test]
    fn uses_the_merchant_code_when_no_rule_matches() {
        let c = candidate(Some("Local Grocer"), "Grocery store", Some("5411"), -85.5);
        assert_eq!(decide(&c, &[]), Decision::Builtin("Groceries"));
    }

    #[test]
    fn a_payee_rule_beats_the_merchant_code() {
        let c = candidate(Some("John's Fishin Shack"), "Fishing bait", Some("5812"), -55.5);
        let rules = vec![rule("payee", "fishin shack", 42)];
        assert_eq!(decide(&c, &rules), Decision::Rule(42));
    }

    #[test]
    fn an_mcc_rule_beats_a_payee_rule() {
        let c = candidate(Some("John's Fishin Shack"), "Fishing bait", Some("5812"), -55.5);
        let rules = vec![rule("payee", "fishin shack", 42), rule("mcc", "5812", 7)];
        assert_eq!(decide(&c, &rules), Decision::Rule(7));
    }

    #[test]
    fn a_description_rule_applies_when_there_is_no_payee() {
        let c = candidate(None, "MONTHLY GYM MEMBERSHIP", None, -40.0);
        let rules = vec![rule("description", "gym", 9)];
        assert_eq!(decide(&c, &rules), Decision::Rule(9));
    }

    #[test]
    fn matching_ignores_case_on_both_sides() {
        let c = candidate(Some("JOHN'S FISHIN SHACK"), "x", None, -1.0);
        assert_eq!(decide(&c, &[rule("payee", "Fishin Shack", 3)]), Decision::Rule(3));
    }

    #[test]
    fn money_in_with_nothing_else_is_income() {
        let c = candidate(Some("ACME PAYROLL"), "Direct deposit", None, 2400.0);
        assert_eq!(decide(&c, &[]), Decision::Income);
    }

    #[test]
    fn a_merchant_code_still_wins_over_the_sign_of_the_amount() {
        // A refund from a grocery store is money in, but it is still groceries.
        let c = candidate(Some("Local Grocer"), "Refund", Some("5411"), 12.0);
        assert_eq!(decide(&c, &[]), Decision::Builtin("Groceries"));
    }

    #[test]
    fn money_out_with_nothing_to_go_on_is_left_alone() {
        let c = candidate(None, "SOME OBSCURE MERCHANT", Some("9999"), -20.0);
        assert_eq!(decide(&c, &[]), Decision::None);
    }

    #[test]
    fn an_empty_rule_pattern_never_matches_everything() {
        let c = candidate(Some("Anyone"), "Anything", None, -5.0);
        assert_eq!(decide(&c, &[rule("payee", "", 1)]), Decision::None);
    }

    #[test]
    fn an_empty_or_missing_mcc_is_ignored() {
        let c = candidate(Some("Shop"), "Thing", Some("   "), -5.0);
        assert_eq!(decide(&c, &[]), Decision::None);
        let c2 = candidate(Some("Shop"), "Thing", None, -5.0);
        assert_eq!(decide(&c2, &[]), Decision::None);
    }
}
