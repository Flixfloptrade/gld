
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is missing. Check your local .env file.'
    );
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    max: 1,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const result = await pool.query(
      'SELECT current_database() AS database, NOW() AS server_time'
    );

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
