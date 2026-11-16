CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sku TEXT DEFAULT '', category TEXT DEFAULT '',
 price REAL NOT NULL DEFAULT 0, packPrice REAL NOT NULL DEFAULT 0, packQty INTEGER NOT NULL DEFAULT 1,
 bulkPrice REAL NOT NULL DEFAULT 0, bulkMin INTEGER NOT NULL DEFAULT 50, stock INTEGER NOT NULL DEFAULT 0,
 unit TEXT DEFAULT 'шт.', description TEXT DEFAULT '', image TEXT DEFAULT '', badge TEXT DEFAULT '',
 types TEXT DEFAULT '[\"piece\",\"pack\",\"bulk\"]', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
