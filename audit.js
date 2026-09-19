const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');

const router = express.Router();

// GET /api/audit — admin: who did what, most recent first
router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await pool.query(
    `SELECT a.audit_id, a.action, a.target_type, a.target_id, a.details, a.created_at, s.name AS staff_name
     FROM audit_log a JOIN staff s ON s.staff_id = a.staff_id
     ORDER BY a.created_at DESC LIMIT 200`
  );
  res.json(result.rows);
});

module.exports = router;
