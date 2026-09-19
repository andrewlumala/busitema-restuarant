const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../config/auth-middleware');

const router = express.Router();

// POST /api/ratings — rate an item from an order that's been served
// body: { order_id, item_id, stars (1-5), comment }
router.post('/', requireAuth, async (req, res) => {
  const { order_id, item_id, stars, comment } = req.body;
  if (!order_id || !item_id || !stars || stars < 1 || stars > 5) {
    return res.status(400).json({ error: 'order_id, item_id and stars (1-5) are required' });
  }

  // Only the order's own student can rate it, and only once it's been served
  const orderResult = await pool.query(
    `SELECT student_id, order_status FROM orders WHERE order_id = $1`,
    [order_id]
  );
  const order = orderResult.rows[0];
  if (!order || order.student_id !== req.user.student_id) {
    return res.status(403).json({ error: 'You can only rate your own orders' });
  }
  if (order.order_status !== 'served') {
    return res.status(400).json({ error: 'You can only rate items after the order has been served' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO ratings (order_id, item_id, student_id, stars, comment)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id, item_id) DO UPDATE SET stars = $4, comment = $5
       RETURNING *`,
      [order_id, item_id, req.user.student_id, stars, comment || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save rating' });
  }
});

// GET /api/ratings/summary — average rating per menu item (for admin dashboard)
router.get('/summary', async (req, res) => {
  const result = await pool.query(
    `SELECT m.item_id, m.name,
            ROUND(AVG(r.stars)::numeric, 1) AS avg_stars,
            COUNT(r.rating_id) AS rating_count
     FROM menu_items m
     LEFT JOIN ratings r ON r.item_id = m.item_id
     GROUP BY m.item_id, m.name
     HAVING COUNT(r.rating_id) > 0
     ORDER BY avg_stars DESC`
  );
  res.json(result.rows);
});

// GET /api/ratings/order/:orderId — ratings already submitted for one order (so the
// student app can show "already rated" instead of the form again)
router.get('/order/:orderId', requireAuth, async (req, res) => {
  const result = await pool.query(`SELECT item_id, stars, comment FROM ratings WHERE order_id = $1`, [req.params.orderId]);
  res.json(result.rows);
});

module.exports = router;
