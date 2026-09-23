-- Busitema Restaurant — Database Schema (PostgreSQL)

CREATE TABLE students (
  student_id      SERIAL PRIMARY KEY,
  reg_number      VARCHAR(20) UNIQUE NOT NULL,
  name            VARCHAR(100) NOT NULL,
  phone           VARCHAR(20) NOT NULL,
  password_hash   TEXT NOT NULL,
  reset_token_hash    TEXT,
  reset_token_expires TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE staff (
  staff_id        SERIAL PRIMARY KEY,
  name            VARCHAR(100) UNIQUE NOT NULL,
  role            VARCHAR(20) NOT NULL CHECK (role IN ('kitchen', 'admin', 'cashier')),
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE wallets (
  wallet_id       SERIAL PRIMARY KEY,
  student_id      INTEGER UNIQUE REFERENCES students(student_id) ON DELETE CASCADE,
  balance         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE transactions (
  transaction_id  SERIAL PRIMARY KEY,
  wallet_id       INTEGER REFERENCES wallets(wallet_id) ON DELETE CASCADE,
  amount          NUMERIC(12,2) NOT NULL,
  type            VARCHAR(20) NOT NULL CHECK (type IN ('topup', 'order_payment', 'refund')),
  method           VARCHAR(20) NOT NULL CHECK (method IN ('wallet', 'mtn_momo', 'airtel_money', 'cash')),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  external_ref    VARCHAR(100),          -- provider transaction id (mobile money)
  order_id        INTEGER, -- links order_payment/refund rows to their order; NULL for top-ups. FK added via ALTER TABLE below (orders doesn't exist yet at this point in the file)
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE menu_items (
  item_id         SERIAL PRIMARY KEY,
  name            VARCHAR(100) NOT NULL,
  category        VARCHAR(50) NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  available       BOOLEAN NOT NULL DEFAULT TRUE,
  stock_qty       INTEGER NOT NULL DEFAULT 0,
  image_url       TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
  order_id        SERIAL PRIMARY KEY,
  student_id      INTEGER REFERENCES students(student_id),  -- NULL for guest orders
  guest_name      VARCHAR(100),                              -- set only for guest orders
  guest_phone     VARCHAR(20),
  total           NUMERIC(12,2) NOT NULL,
  payment_status  VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded')),
  order_status    VARCHAR(20) NOT NULL DEFAULT 'placed' CHECK (order_status IN ('placed','preparing','ready','served','cancelled')),
  pickup_time     TIMESTAMP,           -- NULL means ASAP; otherwise a scheduled pickup slot
  preparing_at    TIMESTAMP,           -- when order_status became 'preparing' — powers avg prep time
  ready_at        TIMESTAMP,           -- when order_status became 'ready'
  served_at       TIMESTAMP,
  refund_reason   TEXT,
  external_ref    VARCHAR(100),        -- mobile money provider reference, for guest orders (no wallet transaction row)
  idempotency_key VARCHAR(100) UNIQUE, -- prevents a double-tapped "Pay" button from creating two orders
  created_at      TIMESTAMP DEFAULT NOW(),
  CHECK (student_id IS NOT NULL OR guest_name IS NOT NULL)  -- every order belongs to a student or a named guest
);

CREATE TABLE order_items (
  order_item_id   SERIAL PRIMARY KEY,
  order_id        INTEGER REFERENCES orders(order_id) ON DELETE CASCADE,
  item_id         INTEGER REFERENCES menu_items(item_id),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  subtotal        NUMERIC(12,2) NOT NULL
);

CREATE TABLE queue_tickets (
  ticket_id       SERIAL PRIMARY KEY,
  order_id        INTEGER UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  queue_number    INTEGER NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','called','closed')),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE ratings (
  rating_id       SERIAL PRIMARY KEY,
  order_id        INTEGER REFERENCES orders(order_id) ON DELETE CASCADE,
  item_id         INTEGER REFERENCES menu_items(item_id),
  student_id      INTEGER REFERENCES students(student_id),
  stars           SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  UNIQUE (order_id, item_id)  -- one rating per item per order
);

CREATE TABLE disputes (
  dispute_id      SERIAL PRIMARY KEY,
  order_id        INTEGER REFERENCES orders(order_id) ON DELETE CASCADE,
  student_id      INTEGER REFERENCES students(student_id),
  reason          VARCHAR(30) NOT NULL CHECK (reason IN ('wrong_item','missing_item','never_received','quality_issue','other')),
  description     TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
  resolution_note TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  resolved_at     TIMESTAMP
);

CREATE TABLE audit_log (
  audit_id        SERIAL PRIMARY KEY,
  staff_id        INTEGER REFERENCES staff(staff_id),
  action          VARCHAR(50) NOT NULL,   -- e.g. 'refund', 'dispute_resolved', 'staff_created', 'menu_toggled'
  target_type     VARCHAR(30),            -- e.g. 'order', 'dispute', 'staff', 'menu_item'
  target_id       INTEGER,
  details         TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Helpful indexes
CREATE INDEX idx_orders_status ON orders(order_status);
CREATE INDEX idx_orders_student ON orders(student_id);
CREATE INDEX idx_txn_wallet ON transactions(wallet_id);
CREATE INDEX idx_ratings_item ON ratings(item_id);
CREATE INDEX idx_disputes_status ON disputes(status);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- Added here (not inline on the transactions table above) because transactions is
-- created before orders in this file, and orders doesn't exist yet at that point.
ALTER TABLE transactions ADD CONSTRAINT fk_transactions_order FOREIGN KEY (order_id) REFERENCES orders(order_id);
