const { Resend } = require('resend');

function getClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

async function sendEmail({ to, subject, html, text }) {
  const client = getClient();
  if (!client) {
    return { skipped: true, reason: 'RESEND_API_KEY is not configured' };
  }
  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error('EMAIL_FROM is not configured');
  if (!to || !subject || (!html && !text)) {
    throw new Error('Email requires to, subject, and html or text content');
  }

  const { data, error } = await client.emails.send({ from, to, subject, html, text });
  if (error) {
    // Avoid logging the API key or full message contents.
    console.error('Resend send failed:', error.message || 'Unknown provider error');
    throw new Error('Resend could not accept the email');
  }
  return data;
}

async function sendWelcomeEmail({ to, firstName }) {
  const safeName = escapeHtml(firstName || 'there');
  const appName = 'Gold Investment';
  const subject = 'Welcome to Gold Investment';
  const text = `Hello ${firstName || 'there'},\n\nThank you for creating a Gold Investment account. Your account has been created. If you did not create it, please contact our support team.\n\nGold Investment`;
  const html = `<!doctype html><html><body style="margin:0;background:#f4f2ed;padding:28px;font-family:Arial,sans-serif;color:#17202a"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e7dfcf;border-radius:16px;padding:32px"><p style="color:#9a762c;font-weight:bold;letter-spacing:2px">GOLD INVESTMENT</p><h1 style="font-size:26px">Welcome, ${safeName}</h1><p>Thank you for creating your Gold Investment account.</p><p>Your account has been created. Keep your sign-in details secure, and contact our support team if you did not create this account.</p><p style="margin-top:28px;color:#756f64;font-size:12px">Precious metals. Clearer ownership.</p></div></body></html>`;
  return sendEmail({ to, subject, html, text });
}

module.exports = { sendEmail, sendWelcomeEmail };
