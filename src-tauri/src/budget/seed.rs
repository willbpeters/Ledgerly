//! Categories start empty: the owner makes them, or a Copilot import brings
//! them in. Nothing here is a preset. The only categories Tally ever makes on
//! its own are the two system ones below, and only when first needed.
use rusqlite::{Connection, OptionalExtension};

/// How many category colour tokens the front end draws (`cat-1` … `cat-12`).
pub const COLOURS: usize = 12;

/// The id of a category by its exact name, if it exists.
#[cfg_attr(not(test), allow(dead_code))]
pub fn category_id(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    conn.query_row("SELECT id FROM categories WHERE name=?1", [name], |r| r.get(0))
        .optional()
}

/// The colour token for a new category: whichever `cat-N` the fewest existing
/// categories use, the lowest N on a tie, so new categories stay distinct.
pub fn next_colour(conn: &Connection) -> rusqlite::Result<String> {
    let mut used = [0usize; COLOURS];
    let mut stmt = conn.prepare("SELECT colour FROM categories")?;
    for colour in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let n = colour?.strip_prefix("cat-").and_then(|n| n.parse::<usize>().ok());
        if let Some(n) = n.filter(|n| (1..=COLOURS).contains(n)) {
            used[n - 1] += 1;
        }
    }
    let least = (0..COLOURS).min_by_key(|&i| (used[i], i)).unwrap_or(0);
    Ok(format!("cat-{}", least + 1))
}

/// The category for money moving between the owner's own accounts
/// (`"transfer"`) or money coming in (`"income"`), made if there is none yet.
///
/// These mirror Copilot's own transaction types (internal transfer, income),
/// not a preset list, so they are created only the first time a row needs one.
/// An existing category of that kind is preferred in this order: Copilot's
/// name, then Tally's old name, then the lowest sort — so the owner's own
/// transfer-kind category (say "Investments") is never picked over a real
/// "Internal transfer" or "Transfer".
pub fn system_category(conn: &Connection, kind: &str) -> rusqlite::Result<i64> {
    let (name, legacy) = match kind {
        "transfer" => ("Internal transfer", "Transfer"),
        "income" => ("Income", "Income"),
        other => return Err(rusqlite::Error::InvalidParameterName(format!("no system category of kind {other}"))),
    };
    let found: Option<i64> = conn.query_row(
        "SELECT id FROM categories WHERE kind=?1
         ORDER BY CASE WHEN lower(name)=lower(?2) THEN 0 WHEN lower(name)=lower(?3) THEN 1 ELSE 2 END, sort, id
         LIMIT 1",
        rusqlite::params![kind, name, legacy],
        |r| r.get(0),
    ).optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    // The name may already be taken by a category of another kind; reuse it
    // rather than fail on the unique name.
    let taken: Option<i64> = conn.query_row(
        "SELECT id FROM categories WHERE lower(name)=lower(?1)", [name], |r| r.get(0),
    ).optional()?;
    if let Some(id) = taken {
        return Ok(id);
    }
    let sort: i64 = conn.query_row("SELECT COALESCE(MAX(sort),0)+10 FROM categories", [], |r| r.get(0))?;
    conn.execute(
        "INSERT INTO categories (name,kind,colour,sort,is_builtin) VALUES (?1,?2,?3,?4,1)",
        rusqlite::params![name, kind, next_colour(conn)?, sort],
    )?;
    Ok(conn.last_insert_rowid())
}

/// The names the auto-sorter (merchant codes, known merchants) uses, which
/// are Tally's old category names. Each is tried in order against what the
/// owner actually has, ignoring case.
const ALIASES: &[(&str, &[&str])] = &[
    ("Dining", &["Dining", "Eating Out"]),
    ("Shopping", &["Shopping", "Shops"]),
];

/// The owner's category for one of the auto-sorter's names, if they have one.
///
/// The sorter still speaks Tally's old names ("Dining"), while the owner's
/// categories come from them or from Copilot ("Eating Out"). This maps one onto
/// the other and never makes a spending category: with no match the row stays
/// uncategorised and waits in To review for the owner.
pub fn sorter_category(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    if name.eq_ignore_ascii_case("Transfer") {
        return system_category(conn, "transfer").map(Some);
    }
    let names = ALIASES.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, a)| *a);
    for candidate in names.unwrap_or(&[name]) {
        let id: Option<i64> = conn.query_row(
            "SELECT id FROM categories WHERE lower(name)=lower(?1) ORDER BY id LIMIT 1", [candidate], |r| r.get(0),
        ).optional()?;
        if id.is_some() {
            return Ok(id);
        }
    }
    Ok(None)
}

/// Tally's old built-in set (name, kind), which the auto-sorter's names come
/// from. Tests that exercise the sorter start from it.
#[cfg(test)]
pub const TEST_CATEGORIES: &[(&str, &str)] = &[
    ("Groceries", "spending"), ("Dining", "spending"), ("Transport", "spending"),
    ("Fuel", "spending"), ("Utilities", "spending"), ("Rent & Mortgage", "spending"),
    ("Shopping", "spending"), ("Health", "spending"), ("Entertainment", "spending"),
    ("Travel", "spending"), ("Subscriptions", "spending"), ("Fees", "spending"),
    ("Other", "spending"), ("Income", "income"), ("Transfer", "transfer"),
];

/// Insert the old built-in set, for tests whose meaning depends on it.
#[cfg(test)]
pub fn test_categories(conn: &Connection) {
    for (i, (name, kind)) in TEST_CATEGORIES.iter().enumerate() {
        conn.execute(
            "INSERT INTO categories (name,kind,colour,sort,is_builtin) VALUES (?1,?2,'chart-1',?3,1)
             ON CONFLICT(name) DO NOTHING",
            rusqlite::params![name, kind, (i as i64 + 1) * 10],
        ).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn add(conn: &Connection, name: &str, kind: &str, colour: &str) -> i64 {
        conn.execute(
            "INSERT INTO categories (name,kind,colour,sort) VALUES (?1,?2,?3,(SELECT COALESCE(MAX(sort),0)+10 FROM categories))",
            rusqlite::params![name, kind, colour],
        ).unwrap();
        conn.last_insert_rowid()
    }
    fn count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM categories", [], |r| r.get(0)).unwrap()
    }
    fn name_kind(conn: &Connection, id: i64) -> (String, String) {
        conn.query_row("SELECT name, kind FROM categories WHERE id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    }

    #[test]
    fn a_fresh_database_has_no_categories() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(count(&conn), 0);
    }

    #[test]
    fn the_transfer_category_is_made_on_first_use_and_reused_after() {
        let conn = db::open_in_memory().unwrap();
        let id = system_category(&conn, "transfer").unwrap();
        assert_eq!(name_kind(&conn, id), ("Internal transfer".into(), "transfer".into()));
        assert_eq!(system_category(&conn, "transfer").unwrap(), id);
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn the_income_category_is_made_on_first_use_and_reused_after() {
        let conn = db::open_in_memory().unwrap();
        let id = system_category(&conn, "income").unwrap();
        assert_eq!(name_kind(&conn, id), ("Income".into(), "income".into()));
        assert_eq!(system_category(&conn, "income").unwrap(), id);
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn a_legacy_transfer_category_is_reused_not_duplicated() {
        let conn = db::open_in_memory().unwrap();
        let legacy = add(&conn, "Transfer", "transfer", "chart-6");
        assert_eq!(system_category(&conn, "transfer").unwrap(), legacy);
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn the_owners_own_transfer_kind_category_never_beats_the_system_one() {
        let conn = db::open_in_memory().unwrap();
        add(&conn, "Investments", "transfer", "cat-1");
        let legacy = add(&conn, "Transfer", "transfer", "cat-2");
        assert_eq!(system_category(&conn, "transfer").unwrap(), legacy);
        let copilot = add(&conn, "Internal transfer", "transfer", "cat-3");
        assert_eq!(system_category(&conn, "transfer").unwrap(), copilot);
    }

    #[test]
    fn an_unknown_kind_is_an_error() {
        let conn = db::open_in_memory().unwrap();
        assert!(system_category(&conn, "spending").is_err());
        assert_eq!(count(&conn), 0);
    }

    #[test]
    fn the_sorters_names_land_on_the_owners_categories() {
        let conn = db::open_in_memory().unwrap();
        let eating_out = add(&conn, "Eating Out", "spending", "cat-1");
        let shops = add(&conn, "shops", "spending", "cat-2");
        let groceries = add(&conn, "Groceries", "spending", "cat-3");
        assert_eq!(sorter_category(&conn, "Dining").unwrap(), Some(eating_out));
        assert_eq!(sorter_category(&conn, "Shopping").unwrap(), Some(shops));
        assert_eq!(sorter_category(&conn, "Groceries").unwrap(), Some(groceries));
    }

    #[test]
    fn the_sorter_makes_no_spending_category() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(sorter_category(&conn, "Dining").unwrap(), None);
        assert_eq!(sorter_category(&conn, "Travel").unwrap(), None);
        assert_eq!(count(&conn), 0);
    }

    #[test]
    fn the_sorters_transfer_is_the_system_category() {
        let conn = db::open_in_memory().unwrap();
        let id = sorter_category(&conn, "Transfer").unwrap().unwrap();
        assert_eq!(name_kind(&conn, id).0, "Internal transfer");
    }

    #[test]
    fn new_colours_go_to_the_least_used_token_lowest_first() {
        let conn = db::open_in_memory().unwrap();
        assert_eq!(next_colour(&conn).unwrap(), "cat-1");
        add(&conn, "A", "spending", "cat-1");
        assert_eq!(next_colour(&conn).unwrap(), "cat-2");
        add(&conn, "B", "spending", "cat-3");
        assert_eq!(next_colour(&conn).unwrap(), "cat-2");
        // Old chart-N tokens and junk do not count against any cat-N.
        add(&conn, "C", "spending", "chart-2");
        add(&conn, "D", "spending", "cat-99");
        assert_eq!(next_colour(&conn).unwrap(), "cat-2");
        for (i, n) in (2..=12).filter(|n| *n != 3).enumerate() {
            add(&conn, &format!("E{i}"), "spending", &format!("cat-{n}"));
        }
        // Every token used once: back to the lowest.
        assert_eq!(next_colour(&conn).unwrap(), "cat-1");
    }

    #[test]
    fn a_system_category_gets_a_distinct_colour() {
        let conn = db::open_in_memory().unwrap();
        add(&conn, "Groceries", "spending", "cat-1");
        let id = system_category(&conn, "income").unwrap();
        let colour: String = conn.query_row("SELECT colour FROM categories WHERE id=?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(colour, "cat-2");
    }
}
