
const { query } = require('../db');

let writeQueue = Promise.resolve();

async function load() {
  const result = await query(
    'SELECT data FROM application_state WHERE id = $1',
    [1]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const data = result.rows[0].data;

  if (
    !data ||
    !Array.isArray(data.users) ||
    !Array.isArray(data.orders) ||
    !Array.isArray(data.sales) ||
    !Array.isArray(data.audit) ||
    !Array.isArray(data.products)
  ) {
    throw new Error(
      'Neon application state is invalid. Refusing to overwrite it.'
    );
  }

  return data;
}

function save(snapshot) {
  if (
    !snapshot ||
    !Array.isArray(snapshot.users) ||
    !Array.isArray(snapshot.orders) ||
    !Array.isArray(snapshot.sales) ||
    !Array.isArray(snapshot.audit) ||
    !Array.isArray(snapshot.products)
  ) {
    return Promise.reject(
      new Error('Refusing to save an incomplete application state.')
    );
  }

  const serialized = JSON.stringify(snapshot);

  const write = writeQueue.then(async () => {
    const result = await query(
      `INSERT INTO application_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
       RETURNING updated_at`,
      [1, serialized]
    );

    return result.rows[0];
  });

  writeQueue = write.catch(() => {});
  return write;
}

async function initialize() {
  const state = await load();
  return { created: false, state };
}

async function flush() {
  await writeQueue;
}

module.exports = {
  load,
  save,
  initialize,
  flush,
};
