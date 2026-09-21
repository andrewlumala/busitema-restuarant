// PostgreSQL connection pool.
//
// Local/Docker: set DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME individually.
// Cloud (Neon, Supabase, Railway Postgres, etc.): set DATABASE_URL instead — a single
// connection string, usually with sslmode=require. Cloud Postgres almost always needs
// SSL, so DATABASE_URL mode turns it on automatically.

const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // most hosted providers use a cert Node won't auto-trust
    })
  : new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'busitema_canteen',
    });

module.exports = pool;
