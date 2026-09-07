CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('brokerage','cash')),
  institution TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS securities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL UNIQUE,
  name TEXT,
  type TEXT NOT NULL CHECK (type IN ('stock','etf')),
  currency TEXT NOT NULL DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id INTEGER REFERENCES securities(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN
    ('buy','sell','dividend','deposit','withdrawal','fee','interest')),
  date TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  amount REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  note TEXT
);

CREATE TABLE IF NOT EXISTS prices (
  security_id INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (security_id, date)
);

CREATE TABLE IF NOT EXISTS snapshots (
  date TEXT PRIMARY KEY,
  total_value REAL NOT NULL
);
