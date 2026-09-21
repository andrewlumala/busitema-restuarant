const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('../config/auth-middleware');
const { sendSms } = require('../config/notifications');
const { logAction } = require('../config/audit');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

// 10 attempts per 15 minutes per IP — generous enough for a real person who
// mistypes a password a few times, tight enough to stop brute-forcing.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please wait a few minutes and try again.' },
});

// POST /api/auth/register — new student sign-up
router.post('/register', async (req, res) => {
  const { reg_number, name, phone, password } = req.body;
  if (!reg_number || !name || !phone || !password) {
    return res.status(400).json({ error: 'reg_number, name, phone and password are required' });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const studentResult = await client.query(
        `INSERT INTO students (reg_number, name, phone, password_hash)
         VALUES ($1, $2, $3, $4) RETURNING student_id, reg_number, name`,
        [reg_number, name, phone, password_hash]
      );
      const student = studentResult.rows[0];
      await client.query(`INSERT INTO wallets (student_id, balance) VALUES ($1, 0)`, [student.student_id]);
      await client.query('COMMIT');

      const token = jwt.sign({ student_id: student.student_id, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
      res.status(201).json({ student, token });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Registration number already registered' });
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login — student login
router.post('/login', loginLimiter, async (req, res) => {
  const { reg_number, password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM students WHERE reg_number = $1`, [reg_number]);
    const student = result.rows[0];
    if (!student || !(await bcrypt.compare(password, student.password_hash))) {
      return res.status(401).json({ error: 'Invalid registration number or password' });
    }
    const token = jwt.sign({ student_id: student.student_id, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ student: { student_id: student.student_id, name: student.name, reg_number: student.reg_number }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/staff-login — kitchen/admin/cashier login
router.post('/staff-login', loginLimiter, async (req, res) => {
  const { name, password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM staff WHERE name = $1`, [name]);
    const staff = result.rows[0];
    if (!staff || !(await bcrypt.compare(password, staff.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ staff_id: staff.staff_id, role: staff.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ staff: { staff_id: staff.staff_id, name: staff.name, role: staff.role }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/create-staff — admin creates a kitchen/admin/cashier account
router.post('/create-staff', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, password, role } = req.body;
  if (!name || !password || !['kitchen', 'admin', 'cashier'].includes(role)) {
    return res.status(400).json({ error: 'name, password, and a valid role (kitchen/admin/cashier) are required' });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO staff (name, role, password_hash) VALUES ($1, $2, $3) RETURNING staff_id, name, role`,
      [name, role, password_hash]
    );
    await logAction({ staff_id: req.user.staff_id, action: 'staff_created', target_type: 'staff', target_id: result.rows[0].staff_id, details: `Created ${role} account "${name}"` });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That staff username is already taken' });
    console.error(err);
    res.status(500).json({ error: 'Could not create staff account' });
  }
});

// POST /api/auth/forgot-password — student requests a reset token
//
// No SMS/email provider is wired up yet (see config/notifications.js), so
// this sends the reset link by SMS via that same stub — check your server
// logs for the "would send" message during local testing. Swap in a real
// SMS provider before this goes live, or the token will only ever appear
// in your server console, not on the student's phone.
router.post('/forgot-password', async (req, res) => {
  const { reg_number } = req.body;
  if (!reg_number) return res.status(400).json({ error: 'reg_number is required' });

  const result = await pool.query(`SELECT student_id, phone FROM students WHERE reg_number = $1`, [reg_number]);
  const student = result.rows[0];
  // Always respond the same way whether or not the account exists — avoids
  // leaking which registration numbers are real to someone probing the API.
  if (!student) return res.json({ message: 'If that account exists, a reset code has been sent.' });

  const rawToken = crypto.randomBytes(4).toString('hex').toUpperCase(); // short code, easy to read off an SMS
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await pool.query(`UPDATE students SET reset_token_hash = $1, reset_token_expires = $2 WHERE student_id = $3`, [tokenHash, expires, student.student_id]);
  await sendSms({ phone: student.phone, message: `Your Busitema Restaurant reset code is ${rawToken}. Expires in 15 minutes.` });

  res.json({ message: 'If that account exists, a reset code has been sent.' });
});

// POST /api/auth/reset-password — student submits the code + new password
router.post('/reset-password', async (req, res) => {
  const { reg_number, code, new_password } = req.body;
  if (!reg_number || !code || !new_password) {
    return res.status(400).json({ error: 'reg_number, code, and new_password are required' });
  }

  const result = await pool.query(`SELECT student_id, reset_token_hash, reset_token_expires FROM students WHERE reg_number = $1`, [reg_number]);
  const student = result.rows[0];
  const tokenHash = crypto.createHash('sha256').update(code.toUpperCase()).digest('hex');

  if (!student || !student.reset_token_hash || student.reset_token_hash !== tokenHash || new Date() > new Date(student.reset_token_expires)) {
    return res.status(400).json({ error: 'Invalid or expired reset code' });
  }

  const password_hash = await bcrypt.hash(new_password, 10);
  await pool.query(`UPDATE students SET password_hash = $1, reset_token_hash = NULL, reset_token_expires = NULL WHERE student_id = $2`, [password_hash, student.student_id]);
  res.json({ message: 'Password reset — you can log in now.' });
});

module.exports = router;
