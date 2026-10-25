// Safely test the Neon connection using this project's local .env file.
// This script never prints the connection string or database credentials.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Pool } = require('pg');

function validateDatabaseUrl(value) {
  if (!value || !value.trim()) {
    throw new Error('DATABASE_URL is missing. Add your real Neon connection string to the project-root .env file.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL. Copy the connection string from Neon Console → Connect.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }

  const host = parsed.hostname.toLowerCase();
  if (
    /your-neon-host|your[-_]?host|region|username|password|database/i.test(host) ||
    host.includes('example') ||
    host === 'localhost'
  ) {
    throw new Error('DATABASE_URL still contains a placeholder hostname. Copy the real connection string from Neon Console → your project → Connect, then update .env.');
  }

  if (!host.endsWith('.neon.tech')) {
    throw new Error('The DATABASE_URL hostname does not look like a Neon hostname. Copy the PostgreSQL connection string from Neon Console → Connect.');
  }
  return value;
}

async function main() {
  const connectionString = validateDatabaseUrl(process.env.DATABASE_URL);
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 10000,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query('SELECT current_database() AS database, NOW() AS server_time');
    console.log('Neon connection successful!');
    console.log('Database:', result.rows[0].database);
    console.log('Server time:', result.rows[0].server_time);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Neon connection failed:', error.message);
  process.exitCode = 1;
});
