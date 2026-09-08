//! Merchant category codes → built-in category names.
//!
//! MCC is the four-digit code the card networks attach to a merchant, and
//! SimpleFIN passes it straight through. It is a far better categorisation
//! signal than merchant text, which varies wildly between banks.
//!
//! Ranges come first in the lookup only where they do not overlap an explicit
//! code; explicit codes always win.

/// Exact codes, checked first.
const EXACT: &[(&str, &str)] = &[
    // Groceries
    ("5411", "Groceries"), ("5422", "Groceries"), ("5441", "Groceries"),
    ("5451", "Groceries"), ("5462", "Groceries"), ("5499", "Groceries"),
    // Dining
    ("5812", "Dining"), ("5813", "Dining"), ("5814", "Dining"), ("5811", "Dining"),
    // Fuel
    ("5541", "Fuel"), ("5542", "Fuel"), ("5983", "Fuel"),
    // Transport
    ("4111", "Transport"), ("4112", "Transport"), ("4121", "Transport"),
    ("4131", "Transport"), ("4784", "Transport"), ("7523", "Transport"),
    ("5533", "Transport"), ("7538", "Transport"),
    // Travel
    ("3000", "Travel"), ("4511", "Travel"), ("4722", "Travel"),
    ("7011", "Travel"), ("7512", "Travel"), ("4411", "Travel"),
    // Utilities
    ("4814", "Utilities"), ("4816", "Utilities"), ("4899", "Utilities"),
    ("4900", "Utilities"), ("4812", "Utilities"),
    // Health
    ("5912", "Health"), ("8011", "Health"), ("8021", "Health"), ("8031", "Health"),
    ("8042", "Health"), ("8049", "Health"), ("8062", "Health"), ("8071", "Health"),
    ("8099", "Health"), ("5975", "Health"), ("5976", "Health"),
    // Entertainment
    ("7832", "Entertainment"), ("7841", "Entertainment"), ("7911", "Entertainment"),
    ("7922", "Entertainment"), ("7929", "Entertainment"), ("7932", "Entertainment"),
    ("7933", "Entertainment"), ("7941", "Entertainment"), ("7991", "Entertainment"),
    ("7992", "Entertainment"), ("7993", "Entertainment"), ("7994", "Entertainment"),
    ("7996", "Entertainment"), ("7997", "Entertainment"), ("7998", "Entertainment"),
    ("7999", "Entertainment"), ("5815", "Entertainment"), ("5816", "Entertainment"),
    // Subscriptions
    ("5817", "Subscriptions"), ("5818", "Subscriptions"), ("4899", "Subscriptions"),
    ("5968", "Subscriptions"), ("7372", "Subscriptions"),
    // Rent & Mortgage
    ("6513", "Rent & Mortgage"),
    // Fees
    ("6010", "Fees"), ("6011", "Fees"), ("6012", "Fees"), ("6051", "Fees"),
    ("6540", "Fees"), ("6300", "Fees"), ("9222", "Fees"), ("9311", "Fees"),
    // Shopping
    ("5311", "Shopping"), ("5310", "Shopping"), ("5399", "Shopping"),
    ("5651", "Shopping"), ("5661", "Shopping"), ("5691", "Shopping"),
    ("5732", "Shopping"), ("5734", "Shopping"), ("5942", "Shopping"),
    ("5999", "Shopping"), ("5964", "Shopping"), ("5965", "Shopping"),
    ("5300", "Shopping"), ("5200", "Shopping"), ("5211", "Shopping"),
];

/// Inclusive ranges, checked when no exact code matched.
const RANGES: &[(u32, u32, &str)] = &[
    (3000, 3299, "Travel"),      // airlines
    (3300, 3499, "Travel"),      // car rental
    (3500, 3999, "Travel"),      // lodging
    (5600, 5699, "Shopping"),    // clothing
    (5700, 5799, "Shopping"),    // home furnishing
    (5900, 5999, "Shopping"),    // misc retail
    (7000, 7099, "Travel"),      // hotels
    (8000, 8099, "Health"),      // medical services
    (4000, 4199, "Transport"),   // transport services
];

/// The built-in category name for a merchant category code, if we know one.
pub fn category_for(mcc: &str) -> Option<&'static str> {
    let code = mcc.trim();
    if code.is_empty() {
        return None;
    }
    if let Some((_, name)) = EXACT.iter().find(|(c, _)| *c == code) {
        return Some(name);
    }
    let n: u32 = code.parse().ok()?;
    RANGES.iter().find(|(lo, hi, _)| n >= *lo && n <= *hi).map(|(_, _, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_common_exact_codes() {
        assert_eq!(category_for("5411"), Some("Groceries"));
        assert_eq!(category_for("5812"), Some("Dining"));
        assert_eq!(category_for("5541"), Some("Fuel"));
        assert_eq!(category_for("4111"), Some("Transport"));
        assert_eq!(category_for("6513"), Some("Rent & Mortgage"));
    }

    #[test]
    fn falls_back_to_ranges() {
        assert_eq!(category_for("3051"), Some("Travel"));   // an airline
        assert_eq!(category_for("5651"), Some("Shopping")); // exact wins inside a range
        assert_eq!(category_for("5698"), Some("Shopping")); // range only
        assert_eq!(category_for("8095"), Some("Health"));
    }

    #[test]
    fn an_exact_code_beats_the_range_it_sits_in() {
        // 5912 is inside the 5900-5999 Shopping range but is a pharmacy.
        assert_eq!(category_for("5912"), Some("Health"));
    }

    #[test]
    fn unknown_empty_and_junk_codes_map_to_nothing() {
        assert_eq!(category_for("9999"), None);
        assert_eq!(category_for(""), None);
        assert_eq!(category_for("  "), None);
        assert_eq!(category_for("abcd"), None);
    }

    #[test]
    fn whitespace_is_tolerated() {
        assert_eq!(category_for(" 5411 "), Some("Groceries"));
    }

    #[test]
    fn every_mapped_name_is_a_real_builtin_category() {
        let names: Vec<&str> = super::super::seed::BUILTIN.iter().map(|(n, ..)| *n).collect();
        for (_, name) in EXACT {
            assert!(names.contains(name), "{name} is not a built-in category");
        }
        for (_, _, name) in RANGES {
            assert!(names.contains(name), "{name} is not a built-in category");
        }
    }
}
