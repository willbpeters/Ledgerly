//! The category set a fresh database starts with. Everything here is editable
//! by the user afterwards; `is_builtin` only marks where it came from.
use rusqlite::Connection;

/// (name, kind, colour token, sort)
pub const BUILTIN: &[(&str, &str, &str, i64)] = &[
    ("Groceries", "spending", "chart-1", 10),
    ("Dining", "spending", "chart-2", 20),
    ("Transport", "spending", "chart-3", 30),
    ("Fuel", "spending", "chart-4", 40),
    ("Utilities", "spending", "chart-5", 50),
    ("Rent & Mortgage", "spending", "chart-6", 60),
    ("Shopping", "spending", "chart-2", 70),
    ("Health", "spending", "chart-3", 80),
    ("Entertainment", "spending", "chart-4", 90),
    ("Travel", "spending", "chart-5", 100),
    ("Subscriptions", "spending", "chart-6", 110),
    ("Fees", "spending", "chart-4", 120),
    ("Other", "spending", "chart-6", 130),
    ("Income", "income", "chart-1", 140),
    ("Transfer", "transfer", "chart-6", 150),
];

pub fn insert_builtin_categories(conn: &Connection) -> rusqlite::Result<()> {
    for (name, kind, colour, sort) in BUILTIN {
        conn.execute(
            "INSERT INTO categories (name, kind, colour, sort, is_builtin)
             VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT(name) DO NOTHING",
            rusqlite::params![name, kind, colour, sort],
        )?;
    }
    Ok(())
}

/// The id of a built-in category by name, if it still exists.
pub fn category_id(conn: &Connection, name: &str) -> rusqlite::Result<Option<i64>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT id FROM categories WHERE name=?1", [name], |r| r.get(0))
        .optional()
}
