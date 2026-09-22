const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');

const router = express.Router();

// GET /api/overview — admin: today's KPIs, a 7-day revenue trend, and top sellers.
// Everything here is computed from real orders/transactions — no placeholder numbers.
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const todayStats = await pool.query(
    `SELECT
       COALESCE(SUM(total) FILTER (WHERE payment_status = 'paid'), 0) AS revenue_today,
       COUNT(*) FILTER (WHERE payment_status = 'paid') AS orders_today
     FROM orders
     WHERE created_at::date = CURRENT_DATE`
  );

  const prepTime = await pool.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (ready_at - preparing_at)) / 60) AS avg_minutes
     FROM orders
     WHERE created_at::date = CURRENT_DATE AND preparing_at IS NOT NULL AND ready_at IS NOT NULL`
  );

  const activeWallets = await pool.query(`SELECT COUNT(*) AS count FROM wallets WHERE balance > 0`);

  const revenueTrend = await pool.query(
    `SELECT d::date AS day, COALESCE(SUM(o.total) FILTER (WHERE o.payment_status = 'paid'), 0) AS revenue
     FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d
     LEFT JOIN orders o ON o.created_at::date = d::date
     GROUP BY d
     ORDER BY d`
  );

  const topSelling = await pool.query(
    `SELECT m.name, SUM(oi.quantity) AS total_sold
     FROM order_items oi
     JOIN orders o ON o.order_id = oi.order_id
     JOIN menu_items m ON m.item_id = oi.item_id
     WHERE o.created_at::date = CURRENT_DATE AND o.payment_status = 'paid'
     GROUP BY m.name
     ORDER BY total_sold DESC
     LIMIT 5`
  );

  const methodSplit = await pool.query(
    `SELECT method, COUNT(*) AS count
     FROM transactions
     WHERE type = 'order_payment' AND status = 'success' AND created_at::date = CURRENT_DATE
     GROUP BY method`
  );

  res.json({
    revenue_today: Number(todayStats.rows[0].revenue_today),
    orders_today: Number(todayStats.rows[0].orders_today),
    avg_prep_minutes: prepTime.rows[0].avg_minutes ? Number(prepTime.rows[0].avg_minutes).toFixed(1) : null,
    active_wallets: Number(activeWallets.rows[0].count),
    revenue_trend: revenueTrend.rows.map(r => ({ day: r.day, revenue: Number(r.revenue) })),
    top_selling: topSelling.rows.map(r => ({ name: r.name, count: Number(r.total_sold) })),
    method_split: methodSplit.rows.map(r => ({ method: r.method, count: Number(r.count) })),
  });
});

module.exports = router;
