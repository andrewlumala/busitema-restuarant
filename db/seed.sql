-- Sample data to test the API locally before real menu/staff data is entered.

INSERT INTO menu_items (name, category, price, available, stock_qty) VALUES
  ('Rice & Beans', 'Main', 4000, TRUE, 50),
  ('Posho & Greens', 'Main', 3500, TRUE, 40),
  ('Chicken & Chips', 'Main', 8000, TRUE, 20),
  ('Matooke & Beef Stew', 'Main', 6500, TRUE, 25),
  ('Rolex', 'Snacks', 2500, TRUE, 60),
  ('Samosa (2 pcs)', 'Snacks', 1500, TRUE, 40),
  ('Passion Juice', 'Drinks', 2000, TRUE, 35),
  ('Soda', 'Drinks', 1800, TRUE, 45);

-- Staff accounts (kitchen1 / admin1) are NOT seeded here — bcrypt hashing needs
-- real bcrypt, which isn't available to plain SQL. Instead, after your first
-- `docker compose up`, run this once:
--
--   docker compose exec api node scripts/seed-staff.js
--
-- It creates kitchen1 and admin1 with the password "password123" (safe to
-- re-run — it skips accounts that already exist). Change that password before
-- any real pilot.
