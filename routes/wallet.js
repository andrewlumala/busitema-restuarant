const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');
const { initiateMomoPayment, MTN_MERCHANT_CODE, AIRTEL_MERCHANT_CODE } = require('../config/momo');
const { logAction } = require('../config/audit');

const router = express.Router();

// GET /api/wallet — the logged-in student's own balance
router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(`SELECT balance FROM wallets WHERE student_id = $1`, [req.user.student_id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Wallet not found' });
  res.json(result.rows[0]);
});

// POST /api/wallet/topup — top up via the MoMo Collections API (needs real provider
// credentials in .env — see config/momo.js). Until you have those, use /topup-direct instead.
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
    await pool.query(`UPDATE transactions SET external_ref = $1 WHERE transaction_id = $2`, [momoResponse.referenceId, transaction_id]);
    res.json({ transaction_id, status: 'pending', message: 'Approve the payment prompt on your phone' });
  } catch (err) {
    await pool.query(`UPDATE transactions SET status = 'failed' WHERE transaction_id = $1`, [transaction_id]);
    res.status(502).json({ error: 'Could not reach mobile money provider' });
  }
});

// POST /api/wallet/topup-direct — student pays the merchant code directly via USSD on
// their own phone (no API involved at all). We have no way to know this happened until
// a cashier/admin confirms it — see GET /pending-topups and POST /confirm-topup/:id below.
router.post('/topup-direct', requireAuth, async (req, res) => {
  const { amount, method } = req.body; // method: 'mtn_momo' | 'airtel_money'
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  if (!['mtn_momo', 'airtel_money'].includes(method)) {
    return res.status(400).json({ error: 'method must be mtn_momo or airtel_money' });
  }

  const walletResult = await pool.query(`SELECT wallet_id FROM wallets WHERE student_id = $1`, [req.user.student_id]);
  const wallet = walletResult.rows[0];
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const txnResult = await pool.query(
    `INSERT INTO transactions (wallet_id, amount, type, method, status)
     VALUES ($1, $2, 'topup', $3, 'pending') RETURNING transaction_id`,
    [wallet.wallet_id, amount, method]
  );

  const merchantCode = method === 'mtn_momo' ? MTN_MERCHANT_CODE : AIRTEL_MERCHANT_CODE;
  const dialCode = method === 'mtn_momo' ? '*165*3#' : '*185*9#';

  res.status(201).json({
    transaction_id: txnResult.rows[0].transaction_id,
    merchant_code: merchantCode,
    dial_code: dialCode,
    amount,
    status: 'pending',
    instructions: `Dial ${dialCode}, enter merchant code ${merchantCode}, enter amount ${amount}, then confirm with your PIN. Your wallet updates once staff confirms the payment.`,
  });
});

// GET /api/wallet/pending-topups — staff: mobile-money top-ups awaiting confirmation
router.get('/pending-topups', requireAuth, requireRole('admin', 'cashier'), async (req, res) => {
  const result = await pool.query(
    `SELECT t.transaction_id, t.amount, t.method, t.created_at, s.name AS student_name, s.reg_number
     FROM transactions t
     JOIN wallets w ON w.wallet_id = t.wallet_id
     JOIN students s ON s.student_id = w.student_id
     WHERE t.status = 'pending' AND t.type = 'topup' AND t.method IN ('mtn_momo', 'airtel_money')
     ORDER BY t.created_at ASC`
  );
  res.json(result.rows);
});

// POST /api/wallet/confirm-topup/:transactionId — staff confirms a direct mobile-money
// top-up actually arrived (checked against the merchant's own MoMo/Airtel statement or SMS)
router.post('/confirm-topup/:transactionId', requireAuth, requireRole('admin', 'cashier'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txnResult = await client.query(
      `SELECT transaction_id, wallet_id, amount, status FROM transactions WHERE transaction_id = $1 FOR UPDATE`,
      [req.params.transactionId]
    );
    const txn = txnResult.rows[0];
    if (!txn) throw { status: 404, message: 'Top-up request not found' };
    if (txn.status !== 'pending') throw { status: 400, message: 'Already processed' };

    await client.query(`UPDATE transactions SET status = 'success' WHERE transaction_id = $1`, [txn.transaction_id]);
    await client.query(`UPDATE wallets SET balance = balance + $1 WHERE wallet_id = $2`, [txn.amount, txn.wallet_id]);
    await client.query('COMMIT');

    await logAction({ staff_id: req.user.staff_id, action: 'topup_confirmed', target_type: 'transaction', target_id: txn.transaction_id, details: `Confirmed UGX ${txn.amount} mobile money top-up` });
    res.json({ transaction_id: txn.transaction_id, status: 'success' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message || 'Could not confirm top-up' });
  } finally {
    client.release();
  }
});

// POST /api/wallet/admin-topup — student hands cash directly to admin/cashier in person;
// credited immediately since the staff member receiving the cash IS the confirmation.
router.post('/admin-topup', requireAuth, requireRole('admin', 'cashier'), async (req, res) => {
  const { reg_number, amount } = req.body;
  if (!reg_number || !amount || amount <= 0) return res.status(400).json({ error: 'reg_number and a positive amount are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const walletResult = await client.query(
      `SELECT w.wallet_id, s.name FROM wallets w JOIN students s ON s.student_id = w.student_id WHERE s.reg_number = $1 FOR UPDATE`,
      [reg_number]
    );
    const wallet = walletResult.rows[0];
    if (!wallet) throw { status: 404, message: 'No student found with that registration number' };

    await client.query(`UPDATE wallets SET balance = balance + $1 WHERE wallet_id = $2`, [amount, wallet.wallet_id]);
    const txnResult = await client.query(
      `INSERT INTO transactions (wallet_id, amount, type, method, status) VALUES ($1, $2, 'topup', 'cash', 'success') RETURNING transaction_id`,
      [wallet.wallet_id, amount]
    );
    await client.query('COMMIT');

    await logAction({ staff_id: req.user.staff_id, action: 'cash_topup', target_type: 'transaction', target_id: txnResult.rows[0].transaction_id, details: `UGX ${amount} cash credited to ${wallet.name} (${reg_number})` });
    res.status(201).json({ student_name: wallet.name, amount, status: 'success' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.status || 500).json({ error: err.message || 'Could not process cash top-up' });
  } finally {
    client.release();
  }
});

module.exports = router;
