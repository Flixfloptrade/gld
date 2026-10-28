
const SECURESMTP_SEND_URL = 'https://securessmtp.com/api/v1/mail/send';

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.SECURESMTP_API_KEY;

  if (!apiKey) {
    return {
      skipped: true,
      reason: 'SECURESMTP_API_KEY is not configured',
    };
  }

  if (!to || !subject || (!html && !text)) {
    throw new Error('Email requires to, subject, and html or text content');
  }

  const configuredBase =
    process.env.APP_BASE_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : (process.env.RENDER || process.env.RENDER_SERVICE_ID)
        ? 'https://gold-investment.onrender.com'
        : 'http://localhost:3001');

  const siteUrl = String(configuredBase).replace(/\/$/, '');
  const replyTo = process.env.EMAIL_REPLY_TO || process.env.ADMIN_EMAIL;

  const payload = {
    to,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    from: {
      name: process.env.EMAIL_FROM_NAME || 'Gold Investment',
    },
  };

  if (replyTo) {
    payload.reply_to = replyTo;
  }

  let response;

  try {
    response = await fetch(SECURESMTP_SEND_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-securessmtp-api-key': apiKey,
        'x-qcs-site-url': siteUrl,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error('SecureSMTP request failed:', error.name || 'NetworkError');
    throw new Error('SecureSMTP could not be reached');
  }

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error('SecureSMTP returned an unreadable response');
  }

  if (!response.ok || result?.ok !== true || result?.sent === false) {
    console.error(
      'SecureSMTP send failed:',
      JSON.stringify({
        reason: result?.reason,
        error: result?.error,
        details: result?.details,
        status: response.status,
      })
    );

    throw new Error('SecureSMTP could not accept the email');
  }

  return {
    id: result.message_id || null,
    mode: result.mode || 'relay',
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function getAppBaseUrl() {
  const configuredBase =
    process.env.APP_BASE_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : (process.env.RENDER || process.env.RENDER_SERVICE_ID)
        ? 'https://gold-investment.onrender.com'
        : 'http://localhost:3001');

  return String(configuredBase).replace(/\/$/, '');
}

async function sendWelcomeEmail({ to, firstName }) {
  const safeName = escapeHtml(firstName || 'there');
  const subject = 'Welcome to Gold Investment';

  const text =
    `Hello ${firstName || 'there'},\n\n` +
    'Thank you for creating a Gold Investment account. ' +
    'Keep your sign-in details secure. If you did not create this account, contact support.\n\n' +
    'Gold Investment';

  const html =
    '<!doctype html><html><body style="margin:0;background:#f4f2ed;padding:28px;font-family:Arial,sans-serif;color:#17202a">' +
    '<div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e7dfcf;border-radius:16px;padding:32px">' +
    '<p style="color:#9a762c;font-weight:bold;letter-spacing:2px">GOLD INVESTMENT</p>' +
    `<h1 style="font-size:26px">Welcome, ${safeName}</h1>` +
    '<p>Thank you for creating a Gold Investment account.</p>' +
    '<p>Keep your sign-in details secure. Contact support if you did not create this account.</p>' +
    '<p style="margin-top:28px;color:#756f64;font-size:12px">Precious metals. Clearer ownership.</p>' +
    '</div></body></html>';

  return sendEmail({ to, subject, html, text });
}

async function sendVerificationEmail({
  to,
  firstName,
  token,
  purpose = 'signup',
}) {
  const base = getAppBaseUrl();
  const link =
    `${base}/verify-email?token=${encodeURIComponent(token)}` +
    `&purpose=${encodeURIComponent(purpose)}`;

  const safeName = escapeHtml(firstName || 'there');
  const isEmailChange = purpose === 'email-change';

  const subject = isEmailChange
    ? 'Confirm your new Gold Investment email'
    : 'Verify your Gold Investment email';

  const action = isEmailChange
    ? 'confirm your new email address'
    : 'verify your email address';

  const buttonLabel = isEmailChange
    ? 'Confirm email address'
    : 'Verify email address';

  const text =
    `Hello ${firstName || 'there'},\n\n` +
    `Use this link to ${action}: ${link}\n\n` +
    'This link expires in 30 minutes and can be used once. ' +
    'If you did not request this, you can ignore this message.\n\n' +
    'Gold Investment';

  const html =
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#17202a;padding:28px">' +
    '<div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e7dfcf;border-radius:16px;padding:32px">' +
    '<p style="color:#9a762c;font-weight:bold;letter-spacing:2px">GOLD INVESTMENT</p>' +
    `<h1>${isEmailChange ? 'Confirm your new email' : 'Verify your email'}, ${safeName}</h1>` +
    `<p>Use the button below to ${action}.</p>` +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#b68b35;color:#fff;text-decoration:none;padding:13px 20px;border-radius:8px">${buttonLabel}</a></p>` +
    '<p>This link expires in 30 minutes and can be used once.</p>' +
    '<p>If you did not request this, you can ignore this message.</p>' +
    '</div></body></html>';

  return sendEmail({ to, subject, html, text });
}

async function sendPasswordResetEmail({ to, firstName, token }) {
  const base = getAppBaseUrl();
  const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
  const safeName = escapeHtml(firstName || 'there');
  const subject = 'Reset your Gold Investment password';

  const text =
    `Hello ${firstName || 'there'},\n\n` +
    `Use this link to reset your password: ${link}\n\n` +
    'This link expires in 30 minutes and can be used once. ' +
    'If you did not request a reset, ignore this email.\n\n' +
    'Gold Investment';

  const html =
    '<!doctype html><html><body style="font-family:Arial,sans-serif;color:#17202a;padding:28px">' +
    '<div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e7dfcf;border-radius:16px;padding:32px">' +
    '<p style="color:#9a762c;font-weight:bold;letter-spacing:2px">GOLD INVESTMENT</p>' +
    `<h1>Password reset, ${safeName}</h1>` +
    '<p>We received a request to reset your password.</p>' +
    `<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#b68b35;color:#fff;text-decoration:none;padding:13px 20px;border-radius:8px">Reset password</a></p>` +
    '<p>This link expires in 30 minutes and can be used once. If you did not request a reset, ignore this email.</p>' +
    '</div></body></html>';

  return sendEmail({ to, subject, html, text });
}

module.exports = {
  sendEmail,
  sendWelcomeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
};
