// Creates the default kitchen1/admin1 staff accounts, properly bcrypt-hashed.
// Safe to re-run — skips any account that already exists.
//
// Usage (with Docker running): docker compose exec api node scripts/seed-staff.js
// Or locally, with DB env vars set:               node scripts/seed-staff.js

const bcrypt = require('bcrypt');
const pool = require('../config/db');

const DEFAULT_PASSWORD = 'password123'; // change this before any real pilot

const accounts = [
  { name: 'kitchen1', role: 'kitchen' },
  { name: 'admin1', role: 'admin' },
];

async function main() {
  for (const account of accounts) {
    const existing = await pool.query(`SELECT staff_id FROM staff WHERE name = $1`, [account.name]);
    if (existing.rows.length > 0) {
      console.log(`- ${account.name} already exists, skipping`);
      continue;
    }
    const password_hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    await pool.query(`INSERT INTO staff (name, role, password_hash) VALUES ($1, $2, $3)`, [account.name, account.role, password_hash]);
    console.log(`✅ Created ${account.role} account "${account.name}"`);
  }
  console.log(`\nLog in with any of the above and password: ${DEFAULT_PASSWORD}`);
  console.log('Change this password (or create your own accounts via the admin Staff tab) before a real pilot.\n');
  await pool.end();
}

main().catch((err) => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
