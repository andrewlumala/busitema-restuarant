const pool = require('./db');

// Records who did what. Call this from any route that changes money or
// account state — never let it throw and break the actual request.
async function logAction({ staff_id, action, target_type, target_id, details }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (staff_id, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)`,
      [staff_id, action, target_type, target_id, details || null]
    );
  } catch (err) {
    console.error('Failed to write audit log entry:', err);
  }
}

module.exports = { logAction };
