const express = require('express');
const crypto = require('crypto');
const pool = require('../config/db');

// Verifies the webhook actually came from your provider, not a stranger
// hitting this endpoint directly. This is a generic HMAC check — most
// providers (MTN, Airtel) have their own signature scheme once you're
// registered; swap this for whatever header/algorithm their docs specify.
// Until MOMO_WEBHOOK_SECRET is set, this ALLOWS all requests through, so
// local testing keeps working — but it logs a loud warning so it's obvious
// this isn't safe to deploy as-is.
function verifyWebhookSignature(req, res, next) {
  const secret = process.env.MOMO_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[momo-webhook] MOMO_WEBHOOK_SECRET is not set — accepting unverified webhook calls. Do not deploy like this.');
    return next();
  }
  const signature = req.headers['x-signature'];
  // Note: this re-serializes the already-parsed body, which works for testing but isn't
  // byte-identical to what a provider actually signed (whitespace/key-order can differ).
  // For production, capture the raw request body before JSON parsing and sign that instead.
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
  if (signature !== expected) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

module.exports = function (io) {
  const router = express.Router();

  // POST /api/momo/webhook
  //
  // Called by MTN/Airtel when a payment prompt is approved, declined, or times
  // out. The exact payload shape differs per provider — adjust the field names
  // below (referenceId, status) once you're registered and see a real payload
  // in their sandbox. The logic (find by external_ref, then confirm payment)
  // stays the same either way. A reference can belong to either:
  //   - a wallet top-up (transactions.external_ref)
  //   - a guest order paid by mobile money (orders.external_ref)
  //
  // IMPORTANT: verify the request is genuinely from the provider before
  // trusting it (signature header, IP allowlist, or shared secret — check
  // your provider's docs) before this goes live. Without that check, anyone
  // could call this endpoint and top up a wallet or confirm an order for free.
  router.post('/webhook', verifyWebhookSignature, async (req, res) => {
    const { referenceId, status } = req.body; // adjust to match the real provider payload
    const newStatus = status === 'SUCCESSFUL' ? 'success' : 'failed';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Try a wallet top-up transaction first
      const txnResult = await client.query(
        `SELECT transaction_id, wallet_id, amount, status AS current_status
         FROM transactions WHERE external_ref = $1 FOR UPDATE`,
        [referenceId]
      );
      const txn = txnResult.rows[0];
      if (txn) {
        if (txn.current_status !== 'pending') { await client.query('ROLLBACK'); return res.json({ received: true }); }
        await client.query(`UPDATE transactions SET status = $1 WHERE transaction_id = $2`, [newStatus, txn.transaction_id]);
        if (newStatus === 'success') {
          await client.query(`UPDATE wallets SET balance = balance + $1 WHERE wallet_id = $2`, [txn.amount, txn.wallet_id]);
        }
        await client.query('COMMIT');
        return res.json({ received: true });
      }

      // Otherwise, try a guest order paid by mobile money
      const orderResult = await client.query(
        `SELECT order_id, order_status, payment_status FROM orders WHERE external_ref = $1 FOR UPDATE`,
        [referenceId]
      );
      const order = orderResult.rows[0];
      if (!order) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No transaction or order found for this reference' });
      }
      if (order.payment_status !== 'pending') { await client.query('ROLLBACK'); return res.json({ received: true }); }

      const orderPaymentStatus = newStatus === 'success' ? 'paid' : 'failed';
      await client.query(`UPDATE orders SET payment_status = $1 WHERE order_id = $2`, [orderPaymentStatus, order.order_id]);

      if (orderPaymentStatus === 'paid') {
        const itemsResult = await client.query(
          `SELECT m.name, oi.quantity FROM order_items oi JOIN menu_items m ON m.item_id = oi.item_id WHERE oi.order_id = $1`,
          [order.order_id]
        );
        const ticketResult = await client.query(`SELECT queue_number FROM queue_tickets WHERE order_id = $1`, [order.order_id]);
        io.to('kitchen').emit('order:new', {
          order_id: order.order_id,
          queue_number: ticketResult.rows[0]?.queue_number,
          items: itemsResult.rows,
          order_status: order.order_status,
        });
      }

      await client.query('COMMIT');
      res.json({ received: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Webhook processing failed' });
    } finally {
      client.release();
    }
  });

  return router;
};
