const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');

const router = express.Router();

// GET /api/transactions — admin: full transaction log (top-ups + order payments + refunds)
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await pool.query(
    `SELECT t.transaction_id, t.amount, t.type, t.method, t.status, t.created_at,
            s.name AS student_name, s.reg_number
     FROM transactions t
     JOIN wallets w ON w.wallet_id = t.wallet_id
     JOIN students s ON s.student_id = w.student_id
     ORDER BY t.created_at DESC
     LIMIT 100`
  );
  res.json(result.rows);
});

module.exports = router;
