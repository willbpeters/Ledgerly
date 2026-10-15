//! What a transaction's words say about it. SimpleFIN sends no category and,
//! for the owner's banks, no merchant code — but its `payee` is a clean brand
//! name ("Target", "Chick-fil-A"), which is enough to go on.
//!
//! Pure: no database, no network.

/// Lower-case, apostrophes removed, every other non-alphanumeric run turned
/// into one space, trimmed. "Trader Joe's" and "TRADER JOES" then compare equal.
pub fn normalise(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for ch in s.chars() {
        if ch == '\'' || ch == '’' {
            continue;
        }
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
            space = false;
        } else if !space && !out.is_empty() {
            out.push(' ');
            space = true;
        }
    }
    out.trim_end().to_string()
}

/// Does `phrase` appear in `text` as whole words? Both already normalised.
fn has_phrase(text: &str, phrase: &str) -> bool {
    !phrase.is_empty() && format!(" {text} ").contains(&format!(" {phrase} "))
}

/// Money sent to people. Never filed as a transfer or a purchase: a split
/// dinner is Dining and rent is Rent, and only the owner knows which.
const PERSON_TO_PERSON: &[&str] = &["apple pay", "apple cash", "venmo", "zelle", "cash app", "paypal"];

/// Wording that means money moving between the owner's own accounts.
const TRANSFER_PHRASES: &[&str] = &[
    "credit card payment", "card payment", "automatic payment", "autopay",
    "payment thank you", "credit crd", "transfer to checking", "transfer to savings",
    "transfer from", "online transfer",
];

/// Payees that are a transfer only when they are the *whole* payee. "Payment"
/// alone is how the Robinhood card labels a payment received; a payee merely
/// containing the word is not. The brokerages are the owner's own accounts —
/// checked against their data on 2026-10-14, every "Robinhood" row there was a
/// card payment or a move between their accounts.
const TRANSFER_PAYEES: &[&str] = &[
    "payment", "gold payment", "robinhood", "robinhood money", "fidelity", "schwab", "vanguard",
];

/// Known merchants, by category. Seeded from the owner's top payees and common
/// US chains; the review list and payee rules exist to correct the rest.
const MERCHANTS: &[(&str, &[&str])] = &[
    ("Groceries", &[
        "trader joes", "costco", "safeway", "whole foods", "kroger", "aldi", "sprouts",
        "raleys", "winco", "save mart", "grocery outlet", "smart final",
    ]),
    ("Dining", &[
        "chick fil a", "in n out", "in n out burger", "taco bell", "panda express",
        "raising canes", "starbucks", "mcdonalds", "chipotle", "menchies",
        "menchies frozen yogurt", "doordash", "uber eats", "dutch bros", "subway",
        "wendys", "jack in the box", "dominos", "pizza hut", "panera bread", "five guys",
    ]),
    ("Shopping", &["target", "amazon", "walmart", "best buy", "home depot", "lowes", "ikea", "ebay", "etsy"]),
    ("Transport", &["uber", "lyft"]),
    ("Fuel", &["shell", "chevron", "arco", "exxon", "valero"]),
    ("Travel", &[
        "allegiant air", "southwest", "southwest airlines", "delta", "delta air lines",
        "united airlines", "alaska airlines", "american airlines", "jetblue", "airbnb",
        "marriott", "hilton", "hyatt", "expedia",
    ]),
    ("Subscriptions", &[
        "spotify", "netflix", "hulu", "disney plus", "youtube premium", "apple", "icloud",
        "anthropic", "openai", "chatgpt", "amazon prime", "audible",
    ]),
    ("Utilities", &["pg e", "smud", "comcast", "xfinity", "at t", "verizon", "t mobile"]),
    ("Health", &["cvs", "walgreens", "kaiser"]),
    ("Entertainment", &["amc", "regal", "steam", "ticketmaster"]),
];

/// Single words that point at a category when no merchant matched.
const KEYWORDS: &[(&str, &[&str])] = &[
    ("Dining", &["burger", "taco", "pizza", "grill", "cafe", "coffee", "restaurant"]),
    ("Travel", &["airline", "airlines", "hotel"]),
    ("Entertainment", &["golf"]),
    ("Transport", &["parking", "toll"]),
    ("Fees", &["fee", "interest charge"]),
];

fn texts(payee: Option<&str>, description: &str) -> (String, String) {
    (payee.map(normalise).unwrap_or_default(), normalise(description))
}

pub fn is_person_to_person(payee: Option<&str>, description: &str) -> bool {
    let (p, d) = texts(payee, description);
    PERSON_TO_PERSON.iter().any(|w| has_phrase(&p, w) || has_phrase(&d, w))
}

pub fn is_transfer_wording(payee: Option<&str>, description: &str) -> bool {
    let (p, d) = texts(payee, description);
    TRANSFER_PAYEES.iter().any(|w| p == *w)
        || TRANSFER_PHRASES.iter().any(|w| has_phrase(&p, w) || has_phrase(&d, w))
}

/// The longest phrase from `lists` found in `text`, with its category.
fn longest(lists: &[(&'static str, &[&'static str])], text: &str) -> Option<(&'static str, usize)> {
    lists
        .iter()
        .flat_map(|(cat, words)| words.iter().map(move |w| (*cat, *w)))
        .filter(|(_, w)| has_phrase(text, w))
        .map(|(cat, w)| (cat, w.len()))
        .max_by_key(|(_, len)| *len)
}

/// A built-in category name for a known merchant or keyword, or `None`.
/// Merchants beat keywords; the payee is tried before the description, which
/// is noisier ("APPLE.COM/BILL STORE").
pub fn merchant_category(payee: Option<&str>, description: &str) -> Option<&'static str> {
    let (p, d) = texts(payee, description);
    for lists in [MERCHANTS, KEYWORDS] {
        for text in [&p, &d] {
            if let Some((cat, _)) = longest(lists, text) {
                return Some(cat);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalising_drops_case_apostrophes_and_punctuation() {
        assert_eq!(normalise("Trader Joe's"), "trader joes");
        assert_eq!(normalise("Chick-fil-A"), "chick fil a");
        assert_eq!(normalise("  PG&E   Bill "), "pg e bill");
        assert_eq!(normalise("Raising Cane’s"), "raising canes");
    }

    #[test]
    fn known_merchants_map_to_their_category() {
        assert_eq!(merchant_category(Some("Target"), "TARGET 00012"), Some("Shopping"));
        assert_eq!(merchant_category(Some("Trader Joe's"), ""), Some("Groceries"));
        assert_eq!(merchant_category(Some("Chick-fil-A"), ""), Some("Dining"));
        assert_eq!(merchant_category(Some("Spotify"), ""), Some("Subscriptions"));
        assert_eq!(merchant_category(Some("Allegiant Air"), ""), Some("Travel"));
    }

    #[test]
    fn a_merchant_must_match_whole_words() {
        assert_eq!(merchant_category(Some("Targeted Ads Inc"), ""), None);
    }

    #[test]
    fn the_longest_match_wins() {
        assert_eq!(merchant_category(Some("Uber Eats"), ""), Some("Dining"));
        assert_eq!(merchant_category(Some("Uber"), ""), Some("Transport"));
        assert_eq!(merchant_category(Some("Amazon Prime"), ""), Some("Subscriptions"));
    }

    #[test]
    fn keywords_catch_what_the_list_does_not() {
        assert_eq!(merchant_category(Some("Bob's Burger Shack"), ""), Some("Dining"));
        assert_eq!(merchant_category(Some("Haggin Oaks Golf Complex"), ""), Some("Entertainment"));
        assert_eq!(merchant_category(None, "SKY HARBOR PARKING 22"), Some("Transport"));
    }

    #[test]
    fn a_merchant_name_beats_a_keyword() {
        // "cafe" is a Dining keyword; a Target with a cafe inside is still Target.
        assert_eq!(merchant_category(Some("Target"), "TARGET CAFE 0042"), Some("Shopping"));
    }

    #[test]
    fn generic_words_are_not_guessed_at() {
        // "Shop" or "Store" alone says nothing about what was bought; a blank
        // that lands in To review beats a wrong guess hiding in a budget.
        assert_eq!(merchant_category(Some("Shop"), "Thing"), None);
        assert_eq!(merchant_category(Some("Corner Store"), ""), None);
    }

    #[test]
    fn an_unknown_payee_has_no_category() {
        assert_eq!(merchant_category(Some("Zqx Holdings"), "ZQX 1234"), None);
    }

    #[test]
    fn money_sent_to_people_is_recognised() {
        assert!(is_person_to_person(Some("Transfer to Apple Pay"), ""));
        assert!(is_person_to_person(Some("Transfer to Venmo"), ""));
        assert!(is_person_to_person(None, "ZELLE PAYMENT TO JANE"));
        assert!(!is_person_to_person(Some("Apple"), ""));
    }

    #[test]
    fn transfer_wording_is_recognised() {
        assert!(is_transfer_wording(Some("Credit Card Payment"), "Robinhood Credit Card payment"));
        assert!(is_transfer_wording(Some("Automatic Payment"), "AUTOMATIC PAYMENT - THANK"));
        assert!(is_transfer_wording(Some("Chase Credit Card"), "CHASE CREDIT CRD DES:AUTOPAY ID:X"));
        assert!(is_transfer_wording(Some("Payment"), "Payment"));
        assert!(is_transfer_wording(Some("Gold Payment"), "Gold Card payment"));
        assert!(is_transfer_wording(Some("Robinhood"), "Robinhood CCB DES:Payment"));
        assert!(is_transfer_wording(Some("Transfer to Checking"), ""));
    }

    #[test]
    fn ordinary_purchases_are_not_transfer_wording() {
        assert!(!is_transfer_wording(Some("Target"), "TARGET 00012"));
        // "Payment" must be the whole payee, not any payee mentioning one.
        assert!(!is_transfer_wording(Some("Payment Processing Fees LLC"), ""));
    }
}
