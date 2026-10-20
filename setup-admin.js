const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

const root = path.resolve(__dirname);
const envPath = path.join(root, '.env');
const credentialsPath = path.join(root, 'ADMIN-CREDENTIALS.txt');
const suppliedEmail = process.argv[2];

function askEmail() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Admin email: ', answer => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

(async () => {
  const email = String(suppliedEmail || await askEmail()).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const password = crypto.randomBytes(24).toString('base64url');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const values = {
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD_SALT: salt.toString('hex'),
    ADMIN_PASSWORD_HASH: hash,
  };
  const lines = current.split(/\r?\n/).filter(line => !/^\s*ADMIN_TOKEN\s*=/.test(line));
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, 'm');
    if (pattern.test(lines.join('\n'))) {
      for (let i = 0; i < lines.length; i++) if (new RegExp(`^\\s*${name}\\s*=`).test(lines[i])) lines[i] = `${name}=${value}`;
    } else lines.push(`${name}=${value}`);
  }
  fs.writeFileSync(envPath, lines.join('\n').replace(/\n+$/, '') + '\n', { mode: 0o600 });
  fs.writeFileSync(credentialsPath, `Gold Investment admin login\nEmail: ${email}\nPassword: ${password}\n\nThis file contains a one-time generated admin password. Keep it private, store the password in a password manager, then delete this file.\n`, { mode: 0o600 });
  console.log(`Admin credentials saved. Open ${credentialsPath} to read the generated password.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
