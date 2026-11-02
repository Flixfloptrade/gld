# Resend setup for Gold Investment

## Security first
The API key previously pasted into chat should be revoked in Resend and replaced with a new key. Do not commit the replacement key or put it in React/browser code.

## Install and configure
From the project root, run:

```powershell
npm install resend
```

This updates both `package.json` and `package-lock.json` for your local project.

Use the following settings in your local `.env` (replace placeholders with your private values):
```dotenv
ADMIN_EMAIL=lasisfantasen@hotmail.com
RESEND_API_KEY=YOUR_PRIVATE_RESEND_API_KEY
EMAIL_FROM=Gold Investment <verified-sender@your-verified-domain.com>
TEST_EMAIL=your-inbox@example.com
APP_BASE_URL=https://gold-investment.onrender.com
```

`lasisfantasen@hotmail.com` is the administrator/contact address; it is not the automated sender. For production, verify a domain you control in Resend and replace the example `EMAIL_FROM` with a sender address on that verified domain. Add `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_BASE_URL=https://gold-investment.onrender.com` to Render → Environment. Keep your working `DATABASE_URL` in `.env` and Render's Environment settings. Never upload `.env` or paste real credentials into chat or source control. The `.env.example` contains placeholders only.

## Test
Run:
```powershell
node scripts/test-resend.js
```
A successful result means Resend accepted the request. Confirm actual delivery by checking the inbox and Resend logs. The onboarding sender may be restricted to your own verified/test recipient.

## Current behavior
- New signups receive a unique verification link; sign-in is blocked until the link is verified.
- Verification links are single-use and expire after 30 minutes.
- Unverified customers can request another verification email from the sign-in page.
- Password reset links are single-use and expire after 30 minutes; a successful reset revokes existing sessions.
- Changing profile details requires the current password. Changing the email address additionally requires verification of the new address.
- `scripts/test-resend.js` sends a test message to `TEST_EMAIL`. A successful API response means Resend accepted the email; check inbox and Resend logs to confirm delivery.
- Existing accounts that predate the verification field remain able to sign in to avoid accidentally locking out current customers. New accounts must verify.

Configure `APP_BASE_URL` to your live app URL in Render (for example `https://gold-investment.onrender.com`) so email links do not point to localhost.
