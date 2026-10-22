
require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is missing. Set it in your local .env or production environment.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
  max: 5,
  // Neon requires TLS. The connection string should include sslmode=require.
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (error) => {
  console.error('Unexpected Neon PostgreSQL pool error:', error.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function checkConnection() {
  const result = await query(
    'SELECT current_database() AS database, NOW() AS server_time'
  );

  return result.rows[0];
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  checkConnection,
  closePool,
};
