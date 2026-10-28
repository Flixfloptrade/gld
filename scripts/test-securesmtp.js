
 // Sends one real test email using SecureSMTP.
const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '..', '.env');

// Load .env without requiring an extra package.
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  for (const row of lines) {
    const match = row.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/
    );

    if (match && process.env[match[1]] === undefined) {
      let value = match[2].trim();

      // Remove matching surrounding quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[match[1]] = value;
    }
  }
}

const { sendEmail } = require('../services/email');

async function main() {
  const apiKey = process.env.SECURESMTP_API_KEY;
  const recipient = (process.env.TEST_EMAIL || '').trim();

  if (!apiKey) {
    throw new Error('SECURESMTP_API_KEY is missing from .env.');
  }

  if (!recipient) {
    throw new Error('TEST_EMAIL is missing from .env.');
  }

  // Basic email-format check before contacting SecureSMTP.
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailPattern.test(recipient)) {
    throw new Error(
      'TEST_EMAIL does not have a valid email format. Check the .env value.'
    );
  }

  console.log('Testing SecureSMTP recipient format: valid.');

  const result = await sendEmail({
    to: recipient,
    subject: 'Gold Investment - SecureSMTP test',
    text:
      'This is a test email from Gold Investment. ' +
      'If you received it, SecureSMTP delivery is configured.',
    html:
      '<div style="font-family:Arial,sans-serif">' +
      '<h2>Gold Investment</h2>' +
      '<p>This is a test email. If you received it, ' +
      'SecureSMTP delivery is configured.</p>' +
      '</div>',
  });

  if (result?.skipped) {
    throw new Error(result.reason || 'Email sending was skipped.');
  }

  console.log(
    'SecureSMTP accepted the test email. Message ID:',
    result?.id || '(no ID returned)'
  );
  console.log(
    'Check your inbox and the SecureSMTP Email Log to confirm delivery.'
  );
}

main().catch((error) => {
  console.error('SecureSMTP test failed:', error.message);
  process.exitCode = 1;
});
