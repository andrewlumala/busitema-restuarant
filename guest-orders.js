const express = require('express');
const pool = require('../config/db');
const { initiateMomoPayment } = require('../config/momo');

module.exports = function (io) {
  const router = express.Router();

  // POST /api/guest/orders — place an order with no account required
  // body: { guest_name, guest_phone, items: [{item_id, quantity}], method: 'cash'|'mtn_momo'|'airtel_money', pickup_time? }
  //
  // Guests have no wallet, so payment always starts 'pending':
  //   - cash: a cashier confirms receipt in person → PATCH /api/orders/:id/confirm-cash
  //   - mobile money: the student approves the prompt → provider webhook confirms
  // Either way, the order (and kitchen notification) only becomes active once paid.
  router.post('/', async (req, res) => {
    const { guest_name, guest_phone, items, method, pickup_time, idempotency_key } = req.body;
    if (!guest_name || !guest_phone) {
      return res.status(400).json({ error: 'guest_name and guest_phone are required' });
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Order must contain at least one item' });
    }
    if (!['cash', 'mtn_momo', 'airtel_money'].includes(method)) {
      return res.status(400).json({ error: 'method must be cash, mtn_momo, or airtel_money' });
    }
    if (pickup_time && new Date(pickup_time) < new Date()) {
      return res.status(400).json({ error: 'Pickup time must be in the future' });
    }

    if (idempotency_key) {
      const existing = await pool.query(`SELECT order_id FROM orders WHERE idempotency_key = $1`, [idempotency_key]);
      if (existing.rows.length > 0) {
        const orderResult = await pool.query(
          `SELECT o.order_id, q.queue_number, o.payment_status FROM orders o LEFT JOIN queue_tickets q ON q.order_id = o.order_id WHERE o.order_id = $1`,
          [existing.rows[0].order_id]
        );
        return res.status(200).json(orderResult.rows[0]);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let total = 0;
      const priced = [];
      for (const line of items) {
        const itemResult = await client.query(
          `SELECT item_id, price, stock_qty, available FROM menu_items WHERE item_id = $1 FOR UPDATE`,
          [line.item_id]
        );
        const item = itemResult.rows[0];
        if (!item || !item.available) throw { status: 400, message: `Item ${line.item_id} is not available` };
        if (item.stock_qty < line.quantity) throw { status: 400, message: `Not enough stock for item ${line.item_id}` };
        const subtotal = item.price * line.quantity;
        total += subtotal;
        priced.push({ ...line, price: item.price, subtotal });
      }

      const orderResult = await client.query(
        `INSERT INTO orders (guest_name, guest_phone, total, payment_status, pickup_time, idempotency_key)
         VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING order_id, created_at`,
        [guest_name, guest_phone, total, pickup_time || null, idempotency_key || null]
      );
      const order_id = orderResult.rows[0].order_id;

      for (const line of priced) {
        await client.query(
          `INSERT INTO order_items (order_id, item_id, quantity, subtotal) VALUES ($1, $2, $3, $4)`,
          [order_id, line.item_id, line.quantity, line.subtotal]
        );
        await client.query(
          `UPDATE menu_items
           SET stock_qty = stock_qty - $1,
               available = CASE WHEN stock_qty - $1 <= 0 THEN FALSE ELSE available END
           WHERE item_id = $2`,
          [line.quantity, line.item_id]
        );
      }

      const queueResult = await client.query(
        `INSERT INTO queue_tickets (order_id, queue_number)
         VALUES ($1, (SELECT COUNT(*) + 41 FROM queue_tickets WHERE created_at::date = CURRENT_DATE))
         RETURNING queue_number`,
        [order_id]
      );

      if (method !== 'cash') {
        try {
          const momoResponse = await initiateMomoPayment({ phone: guest_phone, amount: total, method, reference: order_id });
          await client.query(`UPDATE orders SET external_ref = $1 WHERE order_id = $2`, [momoResponse.referenceId, order_id]);
        } catch (err) {
          await client.query(`UPDATE orders SET payment_status = 'failed' WHERE order_id = $1`, [order_id]);
          await client.query('COMMIT'); // keep the order row for records, but report the failure
          return res.status(502).json({ error: 'Could not reach mobile money provider' });
        }
      }

      await client.query('COMMIT');

      res.status(201).json({
        order_id,
        queue_number: queueResult.rows[0].queue_number,
        items: priced,
        total,
        payment_status: 'pending',
        method,
        message: method === 'cash'
          ? 'Show this ticket number and pay cash at the counter to confirm your order.'
          : 'Approve the payment prompt on your phone to confirm your order.',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 500).json({ error: err.message || 'Could not place order' });
    } finally {
      client.release();
    }
  });

  // GET /api/guest/orders/:id — public status check (no login, since guests have no token
  // to authenticate a Socket.IO connection with) — the student page polls this instead
  router.get('/:id', async (req, res) => {
    const result = await pool.query(
      `SELECT o.order_id, q.queue_number, o.order_status, o.payment_status, o.total
       FROM orders o LEFT JOIN queue_tickets q ON q.order_id = o.order_id
       WHERE o.order_id = $1 AND o.student_id IS NULL`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  });

  return router;
};
