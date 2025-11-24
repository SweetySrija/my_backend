-- init.sql: create product and inventory_history tables

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT,
  category TEXT,
  brand TEXT,
  stock INTEGER DEFAULT 0,
  status TEXT,
  image TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER,
  change_amount INTEGER,
  reason TEXT,
  before_qty INTEGER,
  after_qty INTEGER,
  change_date TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(product_id) REFERENCES products(id)
);