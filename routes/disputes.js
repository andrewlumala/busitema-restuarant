const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');
const { logAction } = require('../config/audit');

module.exports = function (io) {
  const router = express.Router();

  // POST /api/disputes — student reports an issue with one of their orders
  // body: { order_id, reason, description }
  // reason: 'wrong_item' | 'missing_item' | 'never_received' | 'quality_issue' | 'other'
  router.post('/', requireAuth, async (req, res) => {
    const { order_id, reason, description } = req.body;
    const validReasons = ['wrong_item', 'missing_item', 'never_received', 'quality_issue', 'other'];
    if (!order_id || !validReasons.includes(reason)) {
      return res.status(400).json({ error: 'order_id and a valid reason are required' });
    }

    const orderResult = await pool.query(`SELECT student_id FROM orders WHERE order_id = $1`, [order_id]);
    const order = orderResult.rows[0];
    if (!order || order.student_id !== req.user.student_id) {
      return res.status(403).json({ error: 'You can only report issues with your own orders' });
    }

    const result = await pool.query(
      `INSERT INTO disputes (order_id, student_id, reason, description) VALUES ($1, $2, $3, $4) RETURNING *`,
      [order_id, req.user.student_id, reason, description || null]
    );

    io.to('kitchen').emit('dispute:new', result.rows[0]); // kitchen/admin clients share this room today
    res.status(201).json(result.rows[0]);
  });

  // GET /api/disputes — admin: list disputes, optionally filtered by status
  router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
    const { status } = req.query; // 'open' | 'resolved' | 'rejected'
    const result = await pool.query(
      `SELECT d.*, s.name AS student_name, s.reg_number, o.total AS order_total
       FROM disputes d
       JOIN students s ON s.student_id = d.student_id
       JOIN orders o ON o.order_id = d.order_id
       WHERE $1::text IS NULL OR d.status = $1
       ORDER BY d.created_at DESC`,
      [status || null]
    );
    res.json(result.rows);
  });

  // PATCH /api/disputes/:id — admin resolves or rejects a dispute.
  // body: { status: 'resolved' | 'rejected', resolution_note, refund: boolean }
  // If refund is true, this reuses the same wallet-credit logic as a direct refund.
  router.patch('/:id', requireAuth, requireRole('admin'), async (req, res) => {
    const { status, resolution_note, refund } = req.body;
    if (!['resolved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status must be 'resolved' or 'rejected'" });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const disputeResult = await client.query(`SELECT dispute_id, order_id, student_id FROM disputes WHERE dispute_id = $1 FOR UPDATE`, [req.params.id]);
      const dispute = disputeResult.rows[0];
      if (!dispute) throw { status: 404, message: 'Dispute not found' };

      if (refund) {
        const orderResult = await client.query(
          `SELECT total, payment_status FROM orders WHERE order_id = $1 FOR UPDATE`,
          [dispute.order_id]
        );
        const order = orderResult.rows[0];
        if (order.payment_status === 'paid') {
          const walletResult = await client.query(`SELECT wallet_id FROM wallets WHERE student_id = $1 FOR UPDATE`, [dispute.student_id]);
          await client.query(`UPDATE wallets SET balance = balance + $1 WHERE wallet_id = $2`, [order.total, walletResult.rows[0].wallet_id]);
          await client.query(
            `INSERT INTO transactions (wallet_id, amount, type, method, status) VALUES ($1, $2, 'refund', 'wallet', 'success')`,
            [walletResult.rows[0].wallet_id, order.total]
          );
          await client.query(`UPDATE orders SET payment_status = 'refunded', refund_reason = $1 WHERE order_id = $2`, [resolution_note || 'Dispute resolved with refund', dispute.order_id]);
        }
      }

      const result = await client.query(
        `UPDATE disputes SET status = $1, resolution_note = $2, resolved_at = NOW() WHERE dispute_id = $3 RETURNING *`,
        [status, resolution_note || null, req.params.id]
      );

      await client.query('COMMIT');
      await logAction({ staff_id: req.user.staff_id, action: `dispute_${status}`, target_type: 'dispute', target_id: dispute.dispute_id, details: resolution_note || null });
      io.to(`student:${dispute.student_id}`).emit('dispute:resolved', result.rows[0]);
      res.json(result.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 500).json({ error: err.message || 'Could not update dispute' });
    } finally {
      client.release();
    }
  });

  return router;
};
