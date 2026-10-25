// Send a real test email to the address you control.
// Configure RESEND_API_KEY, EMAIL_FROM, and TEST_EMAIL in your local .env first.
const fs = require('node:fs');
const path = require('node:path');
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const row of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = row.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const { sendEmail } = require('../services/email');

async function main() {
  if (!process.env.TEST_EMAIL) throw new Error('Set TEST_EMAIL in .env to an inbox you control.');
  const result = await sendEmail({
    to: process.env.TEST_EMAIL,
    subject: 'Gold Investment — Resend test',
    text: 'This is a test email from Gold Investment. If you received it, the Resend integration is configured.',
    html: '<div style="font-family:Arial,sans-serif"><h2>Gold Investment</h2><p>This is a test email. If you received it, the Resend integration is configured.</p></div>',
  });
  if (result?.skipped) throw new Error(result.reason);
  console.log('Resend accepted the test email. Email ID:', result?.id || '(no ID returned)');
}

main().catch((error) => {
  console.error('Resend test failed:', error.message);
  process.exitCode = 1;
});
