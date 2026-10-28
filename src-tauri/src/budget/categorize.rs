//! Deciding which category a bank transaction belongs to.
//!
//! Pure: no database, no network. The caller loads the user's rules and
//! resolves the returned category name to an id.

use super::{mcc, merchants};

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
    /// "cash", "credit" or "brokerage". Money in on a card is a refund or a
    /// payment, never income.
    pub account_type: String,
}

/// What categorisation decided.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// A user rule matched; use this category id.
    Rule(i64),
    /// The sorter's own name for the category (Tally's old names, such as
    /// "Dining"); `seed::sorter_category` finds the owner's category for it.
    Builtin(&'static str),
    /// Money coming in with nothing else to go on.
    Income,
    /// Nothing matched; leave it uncategorised for the user to sort out.
    None,
}

fn contains(haystack: &str, needle: &str) -> bool {
    !needle.is_empty() && haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Decide a category. User rules first, then payments to people (left alone),
/// transfer wording, the merchant-code map, known merchants, and finally money
/// in on a cash account as Income. Manual categories are honoured by the
/// caller, which simply does not ask about them.
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
    // 4. Money sent to a person: only the owner knows what it was for, so no
    //    rung below may call it a transfer or a purchase.
    if merchants::is_person_to_person(c.payee.as_deref(), &c.description) {
        return Decision::None;
    }
    // 5. Money moving between the owner's own accounts.
    if merchants::is_transfer_wording(c.payee.as_deref(), &c.description) {
        return Decision::Builtin("Transfer");
    }
    // 6. The merchant-code map. Most banks here send no code, so this
    //    rarely fires, but it is right when it does.
    if let Some(code) = c.mcc.as_deref() {
        if let Some(name) = mcc::category_for(code) {
            return Decision::Builtin(name);
        }
    }
    // 7. A known merchant or keyword.
    if let Some(name) = merchants::merchant_category(c.payee.as_deref(), &c.description) {
        return Decision::Builtin(name);
    }
    // 8. Money in, with nothing else to go on — but only on a cash account:
    //    money in on a card is a refund or a payment, never income.
    if c.amount > 0.0 && c.account_type != "credit" {
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
            account_type: "cash".into(),
        }
    }

    fn on(account_type: &str, payee: &str, description: &str, amount: f64) -> Candidate {
        Candidate {
            payee: Some(payee.into()),
            description: description.into(),
            mcc: None,
            amount,
            account_type: account_type.into(),
        }
    }

    #[test]
    fn a_known_merchant_is_categorised_without_a_merchant_code() {
        assert_eq!(decide(&on("credit", "Target", "TARGET 0001", -25.0), &[]), Decision::Builtin("Shopping"));
    }

    #[test]
    fn a_payee_rule_beats_a_known_merchant() {
        let rules = vec![rule("payee", "costco", 9)];
        assert_eq!(decide(&on("credit", "Costco", "", -80.0), &rules), Decision::Rule(9));
    }

    #[test]
    fn transfer_wording_files_a_transfer() {
        let c = on("credit", "Automatic Payment", "AUTOMATIC PAYMENT - THANK", 40.59);
        assert_eq!(decide(&c, &[]), Decision::Builtin("Transfer"));
    }

    #[test]
    fn money_to_a_person_is_left_for_the_owner_even_when_it_says_transfer() {
        let c = on("cash", "Transfer to Apple Pay", "", -30.0);
        assert_eq!(decide(&c, &[]), Decision::None);
    }

    #[test]
    fn money_in_on_a_credit_card_is_not_income() {
        assert_eq!(decide(&on("credit", "Zqx Holdings", "", 19.99), &[]), Decision::None);
        assert_eq!(decide(&on("cash", "Zqx Holdings", "", 19.99), &[]), Decision::Income);
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
