const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createStore(root, products) {
  const isRender = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID);

  const dataDir = process.env.DATA_DIR
    ? path.resolve(root, process.env.DATA_DIR)
    : isRender
      ? '/var/data'
      : path.resolve(root, 'data');

  const dataFile = path.join(dataDir, 'store.enc');
  const keyFile = path.join(dataDir, '.encryption-key');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let key;
  if (process.env.DATA_ENCRYPTION_KEY) {
    if (!/^[a-f0-9]{64}$/i.test(process.env.DATA_ENCRYPTION_KEY)) {
      throw new Error('DATA_ENCRYPTION_KEY must be 64 hexadecimal characters (32 bytes).');
    }
    key = Buffer.from(process.env.DATA_ENCRYPTION_KEY, 'hex');
  } else if (fs.existsSync(keyFile)) {
    key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error(`Invalid encryption key file: ${keyFile}`);
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
  }

  function save(snapshot) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
    const envelope = Buffer.concat([Buffer.from('GI01'), iv, cipher.getAuthTag(), ciphertext]);
    const tempFile = `${dataFile}.${process.pid}.tmp`;

    fs.writeFileSync(tempFile, envelope, { mode: 0o600 });
    fs.renameSync(tempFile, dataFile);
  }

  function load() {
    if (!fs.existsSync(dataFile)) return { users: [], orders: [], sales: [], audit: [], products };

    try {
      const envelope = fs.readFileSync(dataFile);
      if (envelope.length < 32 || envelope.subarray(0, 4).toString() !== 'GI01') throw new Error('Unknown data format.');
      const iv = envelope.subarray(4, 16);
      const tag = envelope.subarray(16, 32);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(envelope.subarray(32)), decipher.final()]).toString('utf8');
      const data = JSON.parse(plaintext);
      if (!Array.isArray(data.users) || !Array.isArray(data.orders) || !Array.isArray(data.sales) || !Array.isArray(data.audit)) throw new Error('Stored data is incomplete.');
      const savedProducts = new Map((Array.isArray(data.products) ? data.products : []).map(product => [product.id, product]));
      for (const product of products) {
        const saved = savedProducts.get(product.id);
        if (saved) Object.assign(product, { stock: saved.stock, premiumPct: saved.premiumPct, name: saved.name });
      }
      return data;
    } catch (error) {
      throw new Error(`Could not decrypt/read customer database at ${dataFile}: ${error.message}. Preserve the data and encryption key; do not delete either file.`);
    }
  }

  return { load, save, dataDir };
}

module.exports = { createStore };