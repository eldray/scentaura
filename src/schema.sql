-- ScentAura database schema (SQLite).
-- All money values are whole PESEWAS (1 GHS = 100 pesewas) stored as integers,
-- so there are never rounding errors. All times are UTC (Ghana uses GMT all year).

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Staff accounts (owner, manager, sales, inventory)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','sales','inventory')),
  active INTEGER NOT NULL DEFAULT 1,
  reset_token_hash TEXT,
  reset_expires TEXT,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shoppers. password_hash is NULL for guests who later register / marketing-only records.
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  marketing_consent_at TEXT,
  referral_code TEXT UNIQUE,
  referred_by INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  reset_token_hash TEXT,
  reset_expires TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT,
  recipient TEXT NOT NULL,
  phone TEXT NOT NULL,
  line1 TEXT NOT NULL,
  town TEXT NOT NULL,
  region TEXT NOT NULL,
  digital_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  slug TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  authenticity_notes TEXT,   -- e.g. authorised-distributor letter, invoice references
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'unisex' CHECK (audience IN ('men','women','unisex')),
  concentration TEXT NOT NULL DEFAULT '',
  fragrance_family TEXT NOT NULL DEFAULT '',
  top_notes TEXT NOT NULL DEFAULT '',
  middle_notes TEXT NOT NULL DEFAULT '',
  base_notes TEXT NOT NULL DEFAULT '',
  longevity TEXT NOT NULL DEFAULT '',
  projection TEXT NOT NULL DEFAULT '',
  authenticity_info TEXT NOT NULL DEFAULT '',  -- only fill in when verified
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active','draft','discontinued','archived')),
  featured INTEGER NOT NULL DEFAULT 0,
  is_new INTEGER NOT NULL DEFAULT 0,
  is_bestseller INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

-- A saleable size of a product. Each has its own price, cost and stock.
CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size_ml INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,                       -- e.g. "100 ml"
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT,
  price INTEGER NOT NULL CHECK (price >= 0),
  discount_price INTEGER CHECK (discount_price IS NULL OR discount_price >= 0),
  cost INTEGER NOT NULL DEFAULT 0,           -- weighted-average cost per unit
  on_hand INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  batch_no TEXT,
  expiry_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (reserved <= on_hand)
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  thumb_path TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  reference TEXT NOT NULL UNIQUE,
  supplier_invoice TEXT,
  order_date TEXT NOT NULL DEFAULT (date('now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','received','cancelled')),
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  qty_ordered INTEGER NOT NULL CHECK (qty_ordered > 0),
  qty_received INTEGER NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  unit_cost INTEGER NOT NULL CHECK (unit_cost >= 0),
  batch_no TEXT,
  expiry_date TEXT
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL DEFAULT (date('now')),
  method TEXT,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Every change to stock is recorded here. Never edited, only appended.
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('opening','purchase','sale','return','damage','adjustment','count','reserve','release','cancel_restore')),
  on_hand_change INTEGER NOT NULL DEFAULT 0,
  reserved_change INTEGER NOT NULL DEFAULT 0,
  on_hand_after INTEGER NOT NULL,
  reserved_after INTEGER NOT NULL,
  unit_cost INTEGER,
  reference TEXT,
  reason TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_movements_variant ON stock_movements(variant_id, created_at);

CREATE TABLE IF NOT EXISTS couriers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  tracking_url TEXT,          -- optional, use {tracking} as a placeholder
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS delivery_zones (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- One zone can offer several methods, each with its own fee, free-over threshold and ETA.
CREATE TABLE IF NOT EXISTS delivery_rates (
  id INTEGER PRIMARY KEY,
  zone_id INTEGER NOT NULL REFERENCES delivery_zones(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('standard','express','courier','pickup','collection_point')),
  name TEXT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0),
  free_over INTEGER,                 -- subtotal (after discount) at or above which delivery is free
  min_order INTEGER NOT NULL DEFAULT 0,
  max_order INTEGER,
  eta_text TEXT NOT NULL DEFAULT '',
  courier_id INTEGER REFERENCES couriers(id) ON DELETE SET NULL,
  instructions TEXT,                 -- e.g. pickup address shown to the customer
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  value INTEGER NOT NULL CHECK (value > 0),   -- percent (1-100) or pesewas
  min_spend INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  once_per_customer INTEGER NOT NULL DEFAULT 1,
  first_order_only INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  tracking_token TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  ship_line1 TEXT NOT NULL DEFAULT '',
  ship_town TEXT NOT NULL DEFAULT '',
  ship_region TEXT NOT NULL DEFAULT '',
  ship_digital_address TEXT,
  delivery_notes TEXT,
  zone_id INTEGER REFERENCES delivery_zones(id) ON DELETE SET NULL,
  zone_name TEXT NOT NULL DEFAULT '',
  rate_id INTEGER REFERENCES delivery_rates(id) ON DELETE SET NULL,
  delivery_method TEXT NOT NULL DEFAULT '',
  delivery_name TEXT NOT NULL DEFAULT '',
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_code TEXT,
  referrer_customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('paystack','cod')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','pending','paid','failed','cancelled','partially_refunded','refunded')),
  status TEXT NOT NULL DEFAULT 'pending_confirmation' CHECK (status IN ('pending_confirmation','payment_pending','paid','processing','packed','dispatched','out_for_delivery','delivered','cancelled','return_requested','returned','refunded')),
  stock_state TEXT NOT NULL DEFAULT 'none' CHECK (stock_state IN ('none','reserved','deducted','released','restored')),
  needs_attention TEXT,
  courier_id INTEGER REFERENCES couriers(id) ON DELETE SET NULL,
  tracking_no TEXT,
  dispatched_at TEXT,
  delivered_at TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  internal_notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_payment ON orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email);

-- Snapshot of what was sold, so later price/name changes never alter history.
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES product_variants(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  brand_name TEXT NOT NULL DEFAULT '',
  category_name TEXT NOT NULL DEFAULT '',
  size_label TEXT NOT NULL,
  sku TEXT NOT NULL,
  list_price INTEGER NOT NULL,        -- normal price when ordered
  unit_price INTEGER NOT NULL,        -- price actually charged per unit
  unit_cost INTEGER NOT NULL DEFAULT 0,
  qty INTEGER NOT NULL CHECK (qty > 0),
  line_total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_variant ON order_items(variant_id);

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'status',   -- status | note | delivery_attempt | payment | stock
  status TEXT,
  note TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                -- paystack | cod
  reference TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','cancelled','abandoned','refunded','partially_refunded')),
  channel TEXT,
  fee INTEGER NOT NULL DEFAULT 0,
  provider_txn_id TEXT,
  authorization_url TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- Raw record of everything the provider tells us. The UNIQUE key stops duplicates.
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  reference TEXT,
  outcome TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, event_key)
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT,
  method TEXT NOT NULL DEFAULT 'paystack' CHECK (method IN ('paystack','manual')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processed','failed')),
  provider_ref TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (coupon_id, order_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, customer_id)
);

CREATE TABLE IF NOT EXISTS wishlists (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  spent_on TEXT NOT NULL DEFAULT (date('now')),
  category TEXT NOT NULL,
  description TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'email',
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- sent | failed | logged (SMTP not set up)
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_label TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pages (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',             -- plain text with blank lines between paragraphs
  meta_title TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 0,       -- owner must tick before launch
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS blog_posts (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  meta_description TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
