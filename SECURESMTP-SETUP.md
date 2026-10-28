# SecureSMTP setup for Gold Investment

This project sends verification, password-reset, and email-change confirmation messages through SecureSMTP's REST API relay. It uses Node's built-in `fetch`; no email SDK dependency is required.

## Configure Render

In Render → your `gold-investment` service → Environment, set:

- `SECURESMTP_API_KEY` = your current SecureSMTP site API key (starts with `qcs_live_`). Keep it secret and do not commit it.
- `APP_BASE_URL` = `https://gold-investment.onrender.com`
- `EMAIL_FROM_NAME` = `Gold Investment`
- `EMAIL_REPLY_TO` = `lasisfantasen@hotmail.com`
- `ADMIN_EMAIL` = `lasisfantasen@hotmail.com`

After SecureSMTP is configured and tested, remove any obsolete email-provider variables from Render. Do not add the API key to React code, `.env.example`, GitHub, or a ZIP file.

The API request is made server-side to `https://securessmtp.com/api/v1/mail/send` with the SecureSMTP API key header and the registered site URL header. Free-plan relay mode uses SecureSMTP's shared sending domain; the configured reply-to address is the address customers reach when replying.

## Test locally

Put the private key only in your ignored local `.env`, and set `TEST_EMAIL` to an inbox you control:

```dotenv
SECURESMTP_API_KEY=YOUR_PRIVATE_SECURESMTP_KEY
APP_BASE_URL=https://gold-investment.onrender.com
EMAIL_FROM_NAME=Gold Investment
EMAIL_REPLY_TO=lasisfantasen@hotmail.com
TEST_EMAIL=your-inbox@example.com
```

Then run:

```powershell
node scripts/test-securesmtp.js
```

A successful API response means SecureSMTP accepted the message, not that it necessarily landed in the inbox. Check the inbox and SecureSMTP's email log.

## Account security flows preserved

- New accounts receive a unique email-verification link that expires after 30 minutes and can be used once.
- Sign-in is blocked for new accounts until email is verified.
- Unverified users can request another verification email.
- Password reset links expire after 30 minutes, are single-use, and successful reset invalidates active sessions.
- Changing the account email requires verification at the new address.

## Key safety

The API key pasted into chat should be rotated/revoked in SecureSMTP and replaced with a new key before production use. Never commit `.env` or share keys in chat.
