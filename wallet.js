const express = require('express');
const pool = require('../config/db');
const { requireAuth } = require('../config/auth-middleware');
const { initiateMomoPayment } = require('../config/momo');

const router = express.Router();

// GET /api/wallet — the logged-in student's own balance
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(`SELECT balance FROM wallets WHERE student_id = $1`, [req.user.student_id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Wallet not found' });
  res.json(result.rows[0]);
});

// POST /api/wallet/topup — top up via mobile money
// Flow: create a 'pending' transaction, trigger the MoMo prompt on the
// student's phone, then a webhook (see routes/momo-webhook.js) confirms
// success and credits the wallet.
router.post('/topup', requireAuth, async (req, res) => {
  const { amount, method, phone } = req.body; // method: 'mtn_momo' | 'airtel_money'
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const walletResult = await pool.query(`SELECT wallet_id FROM wallets WHERE student_id = $1`, [req.user.student_id]);
  const wallet = walletResult.rows[0];
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const txnResult = await pool.query(
    `INSERT INTO transactions (wallet_id, amount, type, method, status)
     VALUES ($1, $2, 'topup', $3, 'pending') RETURNING transaction_id`,
    [wallet.wallet_id, amount, method]
  );
  const transaction_id = txnResult.rows[0].transaction_id;

  try {
    const momoResponse = await initiateMomoPayment({ phone, amount, method, reference: transaction_id });
    await pool.query(
      `UPDATE transactions SET external_ref = $1 WHERE transaction_id = $2`,
      [momoResponse.referenceId, transaction_id]
    );
    res.json({ transaction_id, status: 'pending', message: 'Approve the payment prompt on your phone' });
  } catch (err) {
    await pool.query(`UPDATE transactions SET status = 'failed' WHERE transaction_id = $1`, [transaction_id]);
    res.status(502).json({ error: 'Could not reach mobile money provider' });
  }
});

module.exports = router;
