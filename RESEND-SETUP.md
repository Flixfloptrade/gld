# Resend setup for Gold Investment

## Security first
The API key previously pasted into chat should be revoked in Resend and replaced with a new key. Do not commit the replacement key or put it in React/browser code.

## Install and configure
From the project root, run:

```powershell
npm install resend
```

This updates both `package.json` and `package-lock.json` for your local project.

Add these entries to your local `.env` (use your NEW key):
```dotenv
RESEND_API_KEY=re_your_new_key_here
EMAIL_FROM=Gold Investment <onboarding@resend.dev>
TEST_EMAIL=your-inbox@example.com
APP_BASE_URL=http://localhost:3001
```

For production, verify your sending domain in Resend and set `EMAIL_FROM` to an address on that verified domain. Add `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_BASE_URL=https://gold-investment.onrender.com` to the Render service's Environment settings. Never upload `.env`.

## Test
Run:
```powershell
node scripts/test-resend.js
```
A successful result means Resend accepted the request. Confirm actual delivery by checking the inbox and Resend logs. The onboarding sender may be restricted to your own verified/test recipient.

## Current behavior
- Signup sends a branded welcome email when Resend is configured.
- Email delivery failure does not cancel or roll back account creation.
- `scripts/test-resend.js` sends a test message to `TEST_EMAIL`.
- This does NOT yet enforce email verification before login, nor implement password reset/order/funding/withdrawal emails. Those require additional route and UI work and should be implemented/tested separately rather than treating a welcome email as proof of email verification.
