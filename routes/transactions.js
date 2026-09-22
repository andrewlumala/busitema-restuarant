const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');

const router = express.Router();

// GET /api/transactions — admin: full transaction log (top-ups + order payments + refunds)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await pool.query(
    `SELECT t.transaction_id, t.amount, t.type, t.method, t.status, t.created_at, t.order_id,
            s.name AS student_name, s.reg_number,
            o.payment_status AS order_payment_status
     FROM transactions t
     JOIN wallets w ON w.wallet_id = t.wallet_id
     JOIN students s ON s.student_id = w.student_id
     LEFT JOIN orders o ON o.order_id = t.order_id
     ORDER BY t.created_at DESC
     LIMIT 100`
  );
  res.json(result.rows);
});

module.exports = router;
