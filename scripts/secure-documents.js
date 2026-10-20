const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createSecureDocuments(root) {
  const directory = path.resolve(root, process.env.VERIFICATION_DOCUMENTS_DIR || 'data/identity-documents');
  const keyPath = path.join(directory, '.key');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let key;
  if (process.env.VERIFICATION_DOCUMENTS_KEY) {
    if (!/^[a-f0-9]{64}$/i.test(process.env.VERIFICATION_DOCUMENTS_KEY)) throw new Error('VERIFICATION_DOCUMENTS_KEY must be 64 hexadecimal characters.');
    key = Buffer.from(process.env.VERIFICATION_DOCUMENTS_KEY, 'hex');
  } else if (fs.existsSync(keyPath)) {
    key = fs.readFileSync(keyPath);
    if (key.length !== 32) throw new Error('Invalid verification document encryption key.');
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
  }

  function put(buffer) {
    const id = crypto.randomUUID();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    const envelope = Buffer.concat([Buffer.from('GID1'), iv, cipher.getAuthTag(), encrypted]);
    const finalPath = path.join(directory, `${id}.enc`);
    const temporaryPath = `${finalPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, envelope, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, finalPath);
    return id;
  }

  function get(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Invalid document reference.');
    const envelope = fs.readFileSync(path.join(directory, `${id}.enc`));
    if (envelope.length < 32 || envelope.subarray(0, 4).toString() !== 'GID1') throw new Error('Invalid encrypted document.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.subarray(4, 16));
    decipher.setAuthTag(envelope.subarray(16, 32));
    return Buffer.concat([decipher.update(envelope.subarray(32)), decipher.final()]);
  }

  function remove(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) return;
    const file = path.join(directory, `${id}.enc`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  function removeAll(documents = []) {
    for (const document of documents) remove(document.fileId);
  }

  return { put, get, remove, removeAll, directory };
}

module.exports = { createSecureDocuments };
