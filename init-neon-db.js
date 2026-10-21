
const { query, closePool } = require('./db');

async function main() {
  await query(`
    CREATE TABLE IF NOT EXISTS application_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('Neon application_state table is ready.');

  const result = await query(`
    SELECT
      to_regclass('public.application_state') AS table_name,
      EXISTS (
        SELECT 1
        FROM application_state
        WHERE id = 1
      ) AS has_saved_state
  `);

  console.log('Table:', result.rows[0].table_name);
  console.log('Existing saved state:', result.rows[0].has_saved_state);
}

main()
  .catch((error) => {
    console.error('Database initialization failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
