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
        // The old chart-N tokens draw as cat-N, so they count against it.
        let colour = colour?;
        let n = colour.strip_prefix("cat-").or_else(|| colour.strip_prefix("chart-"))
            .and_then(|n| n.parse::<usize>().ok());
        if let Some(n) = n.filter(|n| (1..=COLOURS).contains(n)) {
            used[n - 1] += 1;
        }
    }
    let least = (0..COLOURS).min_by_key(|&i| (used[i], i)).unwrap_or(0);
    Ok(format!("cat-{}", least + 1))
}

/// The two categories Tally makes on its own, mirroring Copilot's transaction
/// types: money moving between the owner's own accounts, and money coming in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemKind { Transfer, Income }

impl SystemKind {
    /// The `categories.kind` value.
    pub fn kind(self) -> &'static str {
        match self { SystemKind::Transfer => "transfer", SystemKind::Income => "income" }
    }
    /// Copilot's name, then Tally's old one.
    fn names(self) -> (&'static str, &'static str) {
        match self {
            SystemKind::Transfer => ("Internal transfer", "Transfer"),
            SystemKind::Income => ("Income", "Income"),
        }
    }
}

/// The system category of that kind, made if there is none yet.
///
/// These mirror Copilot's own transaction types (internal transfer, income),
/// not a preset list, so they are created only the first time a row needs one.
/// Only the name counts, ignoring case: "Internal transfer" (or Tally's old
/// "Transfer") for transfer, "Income" for income. Another category of the same
/// kind is the owner's own — their "Investments" never receives paired
/// transfers. Among same-named ones, the right kind wins, then Copilot's name;
/// one of another kind is given the system kind, so transfers and income are
/// never counted as spending.
pub fn system_category(conn: &Connection, system: SystemKind) -> rusqlite::Result<i64> {
    let ((name, legacy), kind) = (system.names(), system.kind());
    let found: Option<(i64, String)> = conn.query_row(
        "SELECT id, kind FROM categories WHERE lower(name) IN (lower(?2), lower(?3))
         ORDER BY kind<>?1, lower(name)<>lower(?2), id
         LIMIT 1",
        rusqlite::params![kind, name, legacy],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    if let Some((id, found_kind)) = found {
        if found_kind != kind {
            conn.execute("UPDATE categories SET kind=?1 WHERE id=?2", rusqlite::params![kind, id])?;
        }
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
/// owner actually has, ignoring case: Copilot's name first.
const ALIASES: &[(&str, &[&str])] = &[
    ("Dining", &["Eating Out", "Dining"]),
    ("Shopping", &["Shops", "Shopping"]),
];

/// The owner's category for one of the auto-sorter's names, if they have one.
///
/// The sorter still speaks Tally's old names ("Dining"), while the owner's
/// categories come from them or from Copilot ("Eating Out"). This maps one onto
/// the other and never makes a spending category: with no match the row stays
/// uncategorised and waits in To review for the owner.
pub fn sorter_category(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    if name.eq_ignore_ascii_case("Transfer") {
        return system_category(conn, SystemKind::Transfer).map(Some);
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
        let id = system_category(&conn, SystemKind::Transfer).unwrap();
        assert_eq!(name_kind(&conn, id), ("Internal transfer".into(), "transfer".into()));
        assert_eq!(system_category(&conn, SystemKind::Transfer).unwrap(), id);
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn the_income_category_is_made_on_first_use_and_reused_after() {
        let conn = db::open_in_memory().unwrap();
        let id = system_category(&conn, SystemKind::Income).unwrap();
        assert_eq!(name_kind(&conn, id), ("Income".into(), "income".into()));
        assert_eq!(system_category(&conn, SystemKind::Income).unwrap(), id);
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn a_legacy_transfer_category_is_reused_not_duplicated() {
        let conn = db::open_in_memory().unwrap();
        let legacy = add(&conn, "Transfer", "transfer", "chart-6");
        assert_eq!(system_category(&conn, SystemKind::Transfer).unwrap(), legacy);
        assert_eq!(count(&conn), 1);
    }

    #[test]
    fn the_owners_own_transfer_kind_category_never_beats_the_system_one() {
        let conn = db::open_in_memory().unwrap();
        add(&conn, "Investments", "transfer", "cat-1");
        let legacy = add(&conn, "Transfer", "transfer", "cat-2");
        assert_eq!(system_category(&conn, SystemKind::Transfer).unwrap(), legacy);
        let copilot = add(&conn, "Internal transfer", "transfer", "cat-3");
        assert_eq!(system_category(&conn, SystemKind::Transfer).unwrap(), copilot);
    }

    #[test]
    fn an_owners_transfer_kind_category_is_never_the_system_one() {
        // "Investments" is the owner's own, not where paired transfers go.
        let conn = db::open_in_memory().unwrap();
        let investments = add(&conn, "Investments", "transfer", "cat-1");
        let salary = add(&conn, "Salary", "income", "cat-2");
        let transfer = system_category(&conn, SystemKind::Transfer).unwrap();
        let income = system_category(&conn, SystemKind::Income).unwrap();
        assert_ne!(transfer, investments);
        assert_ne!(income, salary);
        assert_eq!(name_kind(&conn, transfer), ("Internal transfer".into(), "transfer".into()));
        assert_eq!(name_kind(&conn, income), ("Income".into(), "income".into()));
        assert_eq!(count(&conn), 4);
    }

    #[test]
    fn a_system_named_category_of_another_kind_becomes_the_system_kind() {
        // Otherwise transfers and income would count as spending.
        let conn = db::open_in_memory().unwrap();
        let transfer = add(&conn, "Internal transfer", "spending", "cat-1");
        let income = add(&conn, "Income", "spending", "cat-2");
        assert_eq!(system_category(&conn, SystemKind::Transfer).unwrap(), transfer);
        assert_eq!(system_category(&conn, SystemKind::Income).unwrap(), income);
        assert_eq!(name_kind(&conn, transfer).1, "transfer");
        assert_eq!(name_kind(&conn, income).1, "income");
    }

    #[test]
    fn the_sorter_prefers_copilots_name_when_both_exist() {
        let conn = db::open_in_memory().unwrap();
        add(&conn, "Dining", "spending", "cat-1");
        let eating_out = add(&conn, "Eating Out", "spending", "cat-2");
        add(&conn, "Shopping", "spending", "cat-3");
        let shops = add(&conn, "Shops", "spending", "cat-4");
        assert_eq!(sorter_category(&conn, "Dining").unwrap(), Some(eating_out));
        assert_eq!(sorter_category(&conn, "Shopping").unwrap(), Some(shops));
    }

    #[test]
    fn the_system_names_are_matched_ignoring_case() {
        let conn = db::open_in_memory().unwrap();
        let lower = add(&conn, "internal TRANSFER", "transfer", "cat-1");
        assert_eq!(system_category(&conn, SystemKind::Transfer).unwrap(), lower);
        assert_eq!(count(&conn), 1);
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
        // An old chart-N token is the same hue as cat-N; junk counts for none.
        add(&conn, "C", "spending", "chart-2");
        add(&conn, "D", "spending", "cat-99");
        assert_eq!(next_colour(&conn).unwrap(), "cat-4");
        for (i, n) in (4..=12).enumerate() {
            add(&conn, &format!("E{i}"), "spending", &format!("cat-{n}"));
        }
        // Every token used once: back to the lowest.
        assert_eq!(next_colour(&conn).unwrap(), "cat-1");
    }

    #[test]
    fn a_system_category_gets_a_distinct_colour() {
        let conn = db::open_in_memory().unwrap();
        add(&conn, "Groceries", "spending", "cat-1");
        let id = system_category(&conn, SystemKind::Income).unwrap();
        let colour: String = conn.query_row("SELECT colour FROM categories WHERE id=?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(colour, "cat-2");
    }
}
