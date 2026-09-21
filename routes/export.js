const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');

const router = express.Router();

function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map(row =>
    columns.map(col => {
      const val = row[col] == null ? '' : String(row[col]).replace(/"/g, '""');
      return /[",\n]/.test(val) ? `"${val}"` : val;
    }).join(',')
  ).join('\n');
  return header + '\n' + body;
}

// GET /api/export/sales.csv?from=YYYY-MM-DD&to=YYYY-MM-DD — admin: download orders as CSV
router.get('/sales.csv', requireAuth, requireRole('admin'), async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2100-01-01';

  const result = await pool.query(
    `SELECT o.order_id, o.created_at, COALESCE(s.name, o.guest_name) AS customer,
            COALESCE(s.reg_number, 'guest') AS reg_number,
            o.total, o.payment_status, o.order_status
     FROM orders o LEFT JOIN students s ON s.student_id = o.student_id
     WHERE o.created_at::date BETWEEN $1 AND $2
     ORDER BY o.created_at ASC`,
    [from, to]
  );

  const csv = toCsv(result.rows, ['order_id', 'created_at', 'customer', 'reg_number', 'total', 'payment_status', 'order_status']);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="sales-${from}-to-${to}.csv"`);
  res.send(csv);
});

module.exports = router;
