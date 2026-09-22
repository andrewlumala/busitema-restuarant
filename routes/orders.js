const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');
const { sendSms } = require('../config/notifications');
const { logAction } = require('../config/audit');
const { initiateMomoPayment } = require('../config/momo');

module.exports = function (io) {
  const router = express.Router();

  // POST /api/orders — place a new order
  // body: { items: [{ item_id, quantity }], method: 'wallet' | 'mtn_momo' | 'airtel_money', pickup_time?, idempotency_key? }
  // pickup_time: ISO timestamp for a scheduled pickup slot, or omit/null for ASAP
  // idempotency_key: a client-generated UUID per checkout attempt — stops a double-tapped
  // "Pay" button (or a retried request after a flaky connection) from creating two orders.
  router.post('/', requireAuth, async (req, res) => {
    const { items, method, pickup_time, idempotency_key } = req.body;
    if (!items || items.length === 0) return res.status(400).json({ error: 'Order must contain at least one item' });
    if (!['wallet', 'mtn_momo', 'airtel_money'].includes(method)) {
      return res.status(400).json({ error: 'method must be wallet, mtn_momo, or airtel_money' });
    }
    if (pickup_time && new Date(pickup_time) < new Date()) {
      return res.status(400).json({ error: 'Pickup time must be in the future' });
    }

    if (idempotency_key) {
      const existing = await pool.query(`SELECT order_id FROM orders WHERE idempotency_key = $1`, [idempotency_key]);
      if (existing.rows.length > 0) {
        // Same request came through twice — return the original order instead of creating another
        const orderResult = await pool.query(
          `SELECT o.order_id, o.total, o.payment_status, o.order_status, q.queue_number
           FROM orders o LEFT JOIN queue_tickets q ON q.order_id = o.order_id WHERE o.order_id = $1`,
          [existing.rows[0].order_id]
        );
        return res.status(200).json(orderResult.rows[0]);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Price the order server-side — never trust prices from the client
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

      // Wallet is checked up front so we never create an order the student can't
      // afford — mobile money is different: we don't know it'll succeed until the
      // provider responds, so that order gets created first (see below).
      if (method === 'wallet') {
        const walletResult = await client.query(`SELECT wallet_id, balance FROM wallets WHERE student_id = $1 FOR UPDATE`, [req.user.student_id]);
        const wallet = walletResult.rows[0];
        if (!wallet || wallet.balance < total) throw { status: 402, message: 'Insufficient wallet balance' };
      }

      const orderResult = await client.query(
        `INSERT INTO orders (student_id, total, payment_status, pickup_time, idempotency_key) VALUES ($1, $2, 'pending', $3, $4) RETURNING order_id, created_at`,
        [req.user.student_id, total, pickup_time || null, idempotency_key || null]
      );
      const order_id = orderResult.rows[0].order_id;

      for (const line of priced) {
        await client.query(
          `INSERT INTO order_items (order_id, item_id, quantity, subtotal) VALUES ($1, $2, $3, $4)`,
          [order_id, line.item_id, line.quantity, line.subtotal]
        );
        // Deduct stock, and auto-mark unavailable the moment it hits zero —
        // stops the next student from ordering something that's already finished.
        await client.query(
          `UPDATE menu_items
           SET stock_qty = stock_qty - $1,
               available = CASE WHEN stock_qty - $1 <= 0 THEN FALSE ELSE available END
           WHERE item_id = $2`,
          [line.quantity, line.item_id]
        );
      }

      // Queue number: simplest reliable approach is the day's row count + 1.
      // For higher concurrency, back this with a DB sequence reset daily via cron.
      const queueResult = await client.query(
        `INSERT INTO queue_tickets (order_id, queue_number)
         VALUES ($1, (SELECT COUNT(*) + 41 FROM queue_tickets WHERE created_at::date = CURRENT_DATE))
         RETURNING queue_number`,
        [order_id]
      );

      let payment_status = 'pending';
      if (method === 'wallet') {
        const walletResult = await client.query(`SELECT wallet_id FROM wallets WHERE student_id = $1 FOR UPDATE`, [req.user.student_id]);
        await client.query(`UPDATE wallets SET balance = balance - $1 WHERE wallet_id = $2`, [total, walletResult.rows[0].wallet_id]);
        await client.query(
          `INSERT INTO transactions (wallet_id, amount, type, method, status, order_id) VALUES ($1, $2, 'order_payment', 'wallet', 'success', $3)`,
          [walletResult.rows[0].wallet_id, total, order_id]
        );
        await client.query(`UPDATE orders SET payment_status = 'paid' WHERE order_id = $1`, [order_id]);
        payment_status = 'paid';
      } else {
        // Mobile money — actually send the payment request this time (this used to be a silent no-op)
        const studentResult = await client.query(`SELECT phone FROM students WHERE student_id = $1`, [req.user.student_id]);
        try {
          const momoResponse = await initiateMomoPayment({ phone: studentResult.rows[0].phone, amount: total, method, reference: order_id });
          await client.query(`UPDATE orders SET external_ref = $1 WHERE order_id = $2`, [momoResponse.referenceId, order_id]);
        } catch (momoErr) {
          await client.query(`UPDATE orders SET payment_status = 'failed' WHERE order_id = $1`, [order_id]);
          await client.query('COMMIT'); // keep the order row for the record, but report the failure
          return res.status(502).json({ error: 'Could not reach mobile money provider', order_id });
        }
      }

      await client.query('COMMIT');

      const orderPayload = {
        order_id,
        queue_number: queueResult.rows[0].queue_number,
        items: priced,
        total,
        payment_status,
        order_status: 'placed',
        pickup_time: pickup_time || null,
      };

      // Push the new order straight to the kitchen display in real time.
      // For momo orders this only fires once the webhook confirms payment (see momo-webhook.js).
      if (payment_status === 'paid') {
        io.to('kitchen').emit('order:new', orderPayload);
      }

      res.status(201).json(orderPayload);
    } catch (err) {
      await client.query('ROLLBACK');
      const status = err.status || 500;
      console.error(err);
      res.status(status).json({ error: err.message || 'Could not place order' });
    } finally {
      client.release();
    }
  });

  // GET /api/orders/mine — a student's own order history
  router.get('/mine', requireAuth, async (req, res) => {
    const result = await pool.query(
      `SELECT o.order_id, o.total, o.order_status, o.payment_status, o.created_at, q.queue_number
       FROM orders o LEFT JOIN queue_tickets q ON q.order_id = o.order_id
       WHERE o.student_id = $1 ORDER BY o.created_at DESC LIMIT 50`,
      [req.user.student_id]
    );
    res.json(result.rows);
  });

  // GET /api/orders/kitchen — active orders for the kitchen display
  router.get('/kitchen', requireAuth, requireRole('kitchen', 'cashier', 'admin'), async (req, res) => {
    const result = await pool.query(
      `SELECT o.order_id, o.order_status, o.created_at, o.pickup_time, q.queue_number,
              json_agg(json_build_object('name', m.name, 'quantity', oi.quantity)) AS items
       FROM orders o
       JOIN queue_tickets q ON q.order_id = o.order_id
       JOIN order_items oi ON oi.order_id = o.order_id
       JOIN menu_items m ON m.item_id = oi.item_id
       WHERE o.order_status IN ('placed','preparing','ready') AND o.payment_status = 'paid'
       GROUP BY o.order_id, q.queue_number
       ORDER BY o.pickup_time ASC NULLS FIRST, o.created_at ASC`
    );
    res.json(result.rows);
  });

  // PATCH /api/orders/:id/status — kitchen advances an order's status
  router.patch('/:id/status', requireAuth, requireRole('kitchen', 'cashier', 'admin'), async (req, res) => {
    const { status } = req.body; // 'preparing' | 'ready' | 'served'
    const timestampColumn = { preparing: 'preparing_at', ready: 'ready_at', served: 'served_at' }[status];
    const result = await pool.query(
      `UPDATE orders SET order_status = $1${timestampColumn ? `, ${timestampColumn} = NOW()` : ''} WHERE order_id = $2
       RETURNING order_id, student_id, guest_name, guest_phone, order_status`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = result.rows[0];

    // Notify the specific student's app instantly, and refresh the kitchen board
    if (order.student_id) {
      io.to(`student:${order.student_id}`).emit('order:status', { order_id: order.order_id, status });
    }
    io.to('kitchen').emit('order:updated', { order_id: order.order_id, status });

    // SMS matters most right here — a student who's stepped away from the app
    // still needs to know their food is ready
    if (status === 'ready') {
      const ticketResult = await pool.query(`SELECT queue_number FROM queue_tickets WHERE order_id = $1`, [order.order_id]);
      const queueNum = ticketResult.rows[0]?.queue_number;
      let phone = order.guest_phone;
      if (order.student_id && !phone) {
        const studentResult = await pool.query(`SELECT phone FROM students WHERE student_id = $1`, [order.student_id]);
        phone = studentResult.rows[0]?.phone;
      }
      if (phone) {
        await sendSms({ phone, message: `Busitema Restaurant: your order B-${queueNum} is ready for pickup!` });
      }
    }

    res.json(order);
  });

  // GET /api/orders/:id/receipt — full receipt for an order (student's own, staff, or public if guest)
  router.get('/:id/receipt', async (req, res) => {
    const orderResult = await pool.query(
      `SELECT o.order_id, o.total, o.payment_status, o.order_status, o.created_at,
              q.queue_number, o.student_id,
              COALESCE(s.name, o.guest_name) AS student_name,
              s.reg_number
       FROM orders o
       LEFT JOIN students s ON s.student_id = o.student_id
       LEFT JOIN queue_tickets q ON q.order_id = o.order_id
       WHERE o.order_id = $1`,
      [req.params.id]
    );
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Registered students may only view their own receipt. Guest orders (student_id
    // is NULL) have no login to check against, so the ticket number is the access control.
    const header = req.headers.authorization;
    if (order.student_id) {
      if (!header) return res.status(401).json({ error: 'Login required to view this receipt' });
      try {
        const jwt = require('jsonwebtoken');
        const user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET || 'change-this-secret');
        if (user.role === 'student' && user.student_id !== order.student_id) {
          return res.status(403).json({ error: 'Not your order' });
        }
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }

    const itemsResult = await pool.query(
      `SELECT m.item_id, m.name, oi.quantity, oi.subtotal
       FROM order_items oi JOIN menu_items m ON m.item_id = oi.item_id
       WHERE oi.order_id = $1`,
      [req.params.id]
    );

    res.json({
      order_id: order.order_id,
      queue_number: order.queue_number,
      student: { name: order.student_name, reg_number: order.reg_number || null },
      items: itemsResult.rows,
      total: order.total,
      payment_status: order.payment_status,
      order_status: order.order_status,
      created_at: order.created_at,
    });
  });

  // POST /api/orders/:id/refund — admin refunds an order back to the student's wallet
  router.post('/:id/refund', requireAuth, requireRole('admin'), async (req, res) => {
    const { reason } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(
        `SELECT order_id, student_id, total, payment_status FROM orders WHERE order_id = $1 FOR UPDATE`,
        [req.params.id]
      );
      const order = orderResult.rows[0];
      if (!order) throw { status: 404, message: 'Order not found' };
      if (order.payment_status !== 'paid') throw { status: 400, message: 'Only paid orders can be refunded' };

      const walletResult = await client.query(
        `SELECT wallet_id FROM wallets WHERE student_id = $1 FOR UPDATE`,
        [order.student_id]
      );
      const wallet = walletResult.rows[0];

      // Refunds always return to the campus wallet, regardless of original payment
      // method — this avoids re-triggering a mobile money payout for a small refund.
      await client.query(`UPDATE wallets SET balance = balance + $1 WHERE wallet_id = $2`, [order.total, wallet.wallet_id]);
      await client.query(
        `INSERT INTO transactions (wallet_id, amount, type, method, status, order_id) VALUES ($1, $2, 'refund', 'wallet', 'success', $3)`,
        [wallet.wallet_id, order.total, order.order_id]
      );
      await client.query(
        `UPDATE orders SET payment_status = 'refunded', order_status = 'cancelled', refund_reason = $1 WHERE order_id = $2`,
        [reason || null, order.order_id]
      );

      await client.query('COMMIT');

      await logAction({ staff_id: req.user.staff_id, action: 'refund', target_type: 'order', target_id: order.order_id, details: reason || null });

      io.to(`student:${order.student_id}`).emit('order:status', { order_id: order.order_id, status: 'refunded' });
      io.to('kitchen').emit('order:updated', { order_id: order.order_id, status: 'cancelled' });

      res.json({ order_id: order.order_id, refunded_amount: order.total, status: 'refunded' });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 500).json({ error: err.message || 'Refund failed' });
    } finally {
      client.release();
    }
  });

  // POST /api/orders/:id/confirm-cash — cashier confirms cash was received for a
  // guest order (or any pending order). This is what actually pushes it to the kitchen.
  router.post('/:id/confirm-cash', requireAuth, requireRole('admin', 'kitchen', 'cashier'), async (req, res) => {
    const result = await pool.query(
      `UPDATE orders SET payment_status = 'paid' WHERE order_id = $1 AND payment_status = 'pending' RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found or already paid' });

    const order = result.rows[0];
    const itemsResult = await pool.query(
      `SELECT m.name, oi.quantity FROM order_items oi JOIN menu_items m ON m.item_id = oi.item_id WHERE oi.order_id = $1`,
      [order.order_id]
    );
    const ticketResult = await pool.query(`SELECT queue_number FROM queue_tickets WHERE order_id = $1`, [order.order_id]);

    io.to('kitchen').emit('order:new', {
      order_id: order.order_id,
      queue_number: ticketResult.rows[0]?.queue_number,
      items: itemsResult.rows,
      total: order.total,
      payment_status: 'paid',
      order_status: order.order_status,
      pickup_time: order.pickup_time,
    });

    res.json({ order_id: order.order_id, payment_status: 'paid' });
  });

  // GET /api/orders/pending-cash — guest orders waiting for a cashier to confirm cash received
  router.get('/pending-cash', requireAuth, requireRole('kitchen', 'cashier', 'admin'), async (req, res) => {
    const result = await pool.query(
      `SELECT o.order_id, o.guest_name, o.guest_phone, o.total, q.queue_number, o.created_at
       FROM orders o LEFT JOIN queue_tickets q ON q.order_id = o.order_id
       WHERE o.payment_status = 'pending' AND o.guest_name IS NOT NULL
       ORDER BY o.created_at ASC`
    );
    res.json(result.rows);
  });

  // POST /api/orders/:id/cancel — student cancels their own order, but only while
  // it's still 'placed' — once the kitchen has started preparing it, only an
  // admin refund makes sense (the food may already be committed).
  router.post('/:id/cancel', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const orderResult = await client.query(
        `SELECT order_id, student_id, total, payment_status, order_status FROM orders WHERE order_id = $1 FOR UPDATE`,
        [req.params.id]
      );
      const order = orderResult.rows[0];
      if (!order || order.student_id !== req.user.student_id) throw { status: 403, message: 'Not your order' };
      if (order.order_status !== 'placed') throw { status: 400, message: 'This order has already started being prepared and can no longer be self-cancelled — contact the counter.' };

      if (order.payment_status === 'paid') {
        const walletResult = await client.query(`SELECT wallet_id FROM wallets WHERE student_id = $1 FOR UPDATE`, [order.student_id]);
        await client.query(`UPDATE wallets SET balance = balance + $1 WHERE wallet_id = $2`, [order.total, walletResult.rows[0].wallet_id]);
        await client.query(
          `INSERT INTO transactions (wallet_id, amount, type, method, status, order_id) VALUES ($1, $2, 'refund', 'wallet', 'success', $3)`,
          [walletResult.rows[0].wallet_id, order.total, order.order_id]
        );
      }

      // Return stock for each item
      const itemsResult = await client.query(`SELECT item_id, quantity FROM order_items WHERE order_id = $1`, [order.order_id]);
      for (const line of itemsResult.rows) {
        await client.query(`UPDATE menu_items SET stock_qty = stock_qty + $1 WHERE item_id = $2`, [line.quantity, line.item_id]);
      }

      await client.query(
        `UPDATE orders SET order_status = 'cancelled', payment_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE payment_status END WHERE order_id = $1`,
        [order.order_id]
      );

      await client.query('COMMIT');
      io.to('kitchen').emit('order:updated', { order_id: order.order_id, status: 'cancelled' });
      res.json({ order_id: order.order_id, status: 'cancelled' });
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(err.status || 500).json({ error: err.message || 'Could not cancel order' });
    } finally {
      client.release();
    }
  });

  return router;
};
