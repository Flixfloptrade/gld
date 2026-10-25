
require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });
const { Pool } = require('pg');

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) {
  throw new Error(
    'DATABASE_URL is missing. Set it in your local .env or production environment.'
  );
}

// Fail early with a clear message instead of attempting DNS for template values.
try {
  const databaseUrl = new URL(process.env.DATABASE_URL);
  const host = databaseUrl.hostname.toLowerCase();
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
  }
  if (/your-neon-host|your[-_]?host|region|username|password|database|example/i.test(host)) {
    throw new Error('DATABASE_URL still contains a placeholder. Set the real Neon connection string in the environment.');
  }
} catch (error) {
  if (error.message.includes('placeholder') || error.message.includes('PostgreSQL protocol')) throw error;
  throw new Error('DATABASE_URL is not a valid PostgreSQL connection URL. Check the value in your environment.');
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
