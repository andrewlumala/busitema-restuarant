const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');

const router = express.Router();

// GET /api/menu — public, students browse available items
router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT item_id, name, category, price, available, stock_qty, image_url
     FROM menu_items ORDER BY category, name`
  );
  res.json(result.rows);
});

// POST /api/menu — admin adds a new item
router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, category, price, stock_qty, image_url } = req.body;
  if (!name || !category || price == null) {
    return res.status(400).json({ error: 'name, category and price are required' });
  }
  const result = await pool.query(
    `INSERT INTO menu_items (name, category, price, stock_qty, image_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, category, price, stock_qty || 0, image_url || null]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /api/menu/:id — admin updates price, stock, availability, or photo
router.patch('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, category, price, available, stock_qty, image_url } = req.body;
  const result = await pool.query(
    `UPDATE menu_items SET
       name = COALESCE($1, name),
       category = COALESCE($2, category),
       price = COALESCE($3, price),
       available = COALESCE($4, available),
       stock_qty = COALESCE($5, stock_qty),
       image_url = COALESCE($6, image_url)
     WHERE item_id = $7 RETURNING *`,
    [name, category, price, available, stock_qty, image_url, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  res.json(result.rows[0]);
});

module.exports = router;
