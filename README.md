# Gold Investment React app

A worldwide-facing React precious-metals marketplace with a Node.js API that validates quotes and preview orders on the server. Gold and silver are priced in USD. The app retrieves spot references from Gold API's public XAU/XAG endpoints and visibly falls back to labelled mock prices if the feed is unavailable. Signup, delivery-address collection and a vault-or-delivery checkout preference are available in the preview.

## Requirements and setup

Use Node.js 20 or later. From this folder, install packages and start the development site:

```sh
npm install
npm run dev
```

Open <http://localhost:3000>. Vite serves the React app and proxies API requests to the Node server on port 3001.

For a production build preview:

```sh
npm run build
npm start
```

Open <http://localhost:3001>. The Node server serves the built site and API. Configure `PORT` to choose another server port.

### Start the separate admin portal on Windows

Run `npm run admin:setup` once if this folder does not already have its private `.env` and `ADMIN-CREDENTIALS.txt`. Then run:

```sh
npm run admin:stack
```

This starts the customer/API server on port 3001 and the separate staff portal on port 3003. Open <http://localhost:3003/admin/login>. The launcher starts both Node processes directly and does not require `cmd.exe` or `concurrently`. If port 3001 is already in use, stop the older project/server first, then retry.


## Responsive layouts

Customer, checkout, account, and restricted admin pages share responsive layout rules for phones as narrow as 320 CSS pixels, tablets, laptops, and wide desktop displays. Navigation becomes scrollable on compact screens; multi-column forms and cards stack as space narrows; admin tables remain readable in horizontally scrollable containers. Reduced-motion preferences are respected.

## Website routes

- Public: `/`, `/how-it-works`, `/prices`, `/shop`, `/shop/gold`, `/shop/silver`, `/sell`, `/products/:slug`, `/calculator`, `/delivery`, `/security`, `/help`, `/contact`, `/returns`.
- Account: `/register`, `/login`, `/account`, `/account/metals`, `/account/transactions`, `/account/orders`, `/account/orders/:id`, `/account/orders/:id/tracking`, `/account/addresses`, `/account/settings`, `/account/settings/password`, `/account/notifications`, `/account/documents`, `/account/funds`, `/account/trade`, `/account/explore`, `/account/customer-care`.
- Cart and checkout: `/cart`, `/checkout`, `/checkout/payment`, `/checkout/success`, `/order-status/:id`.
- Legal: `/legal/terms`, `/legal/privacy`, `/legal/cookies`, `/legal/pricing`, `/legal/shipping`, `/legal/refunds`, `/legal/risks`, `/legal/tax`.
- Administration: separate staff portal at `/admin/login`, then `/admin` and `/admin/orders`, `/admin/inventory`, `/admin/products`, `/admin/pricing`, `/admin/customers`, `/admin/payments`, `/admin/fulfillment`, `/admin/promotions`, `/admin/support`, `/admin/reports`, `/admin/staff`, `/admin/audit-logs`, `/admin/settings`. The portal uses its own branded shell with no customer site navigation/footer; it is a separate experience in the same app deployment, not a separate domain or security boundary.

The first visit defaults to Arabic (Saudi Arabia), sets the document language to `ar-SA`, applies right-to-left direction, and opens a language chooser. A visible language box is also available in the home hero; selecting Arabic or English saves the preference in local storage. Main navigation, the homepage content, footer links, and selected marketplace labels have Arabic translations. This is a bilingual Arabic/English preview, not a full translation of every customer and staff screen. USD remains the display and transaction currency in both languages; Saudi language selection does not imply SAR pricing or Saudi shipping availability. The homepage hero uses a full-bleed cinematic video sequence: one muted bullion clip plays at a time, fades to the next at end, then cycles. A pause control is available, and reduced-motion settings are respected. Realistic gold and silver bullion photos float in the foreground. This iteration uses direct Pinterest MP4 clips already available in the project because the three newly supplied pin.it short links could not be resolved to direct video media in this environment; provide direct MP4 URLs to use those exact clips. The homepage presents the gold and silver USD spot reference near the top, with clear Buy Gold and Sell Gold actions and featured bullion. The shop provides metal, weight, availability, and price filters. The marketplace now uses realistic, product-type-specific Pexels bullion photographs: gold and silver coins have separate photos, and gold and silver bars use bar photos. Each image is labeled representative because photos do not guarantee the exact mint/design or physical dimensions of preview inventory. Photos are remote and need internet access. Product details show metal, troy weight, purity, indicative USD pricing, sample availability, and delivery or vault preference information. The homepage also includes the requested Saudi gold and silver market photo story and four Pinterest video slides. The eight supplied Pexels images rotate with arrows, dots, and a progress indicator. The Pinterest clips autoplay muted, loop, and link back to their source pins. Market photos and third-party clips are inspiration, not verified seller or inventory information.

The customer dashboard presents order activity, a portfolio estimate, gold ownership records, and links to receipts and settings. Ownership is included in holdings only when a record shows settled payment and completed fulfillment. Because the preview collects no payment and allocates no bullion, preview orders are explicitly not treated as proof of ownership and no receipt is issued. The protected admin workspace displays inventory, premiums, orders, customer-verification status, fulfillment, payment/refund readiness, market references, and audit events.

## Preview behavior

### Registered account storage

Customer accounts (including password hashes and delivery profiles), orders, sell requests, admin-updated inventory fields, and audit history are now saved between restarts in an encrypted file at `DATA_DIR` (`./data` by default). The server creates a local AES-256-GCM key in that directory when no `DATA_ENCRYPTION_KEY` is configured. Keep the key file and encrypted database together, back both up securely, and never commit or email them. For a hosted deployment, mount a persistent disk and set `DATA_DIR` to its mount path; the hosting provider controls how much disk capacity is allocated. A 1 GB disk can hold a very large number of account records, but this application does not reserve or provision cloud storage itself. Existing accounts that only existed in a previous in-memory server process cannot be recovered unless that process's data was exported. Login sessions and temporary quotes still expire when the server stops.

- The server enforces a **$10,000 USD minimum combined purchase subtotal per order**, before tax and shipping. The cart shows a red minimum notice and disables checkout until the combined subtotal reaches $10,000; the server repeats this validation when quoting. Sell requests retain their separate per-metal minimum.
- The server sell-estimate endpoint enforces a **$10,000 USD minimum estimated payout per metal**, after an illustrative 5% buyback adjustment.
- Signup collects name, email, password, country, and delivery address. Passwords are scrypt-hashed; login uses an HTTP-only, same-site session cookie. The customer dashboard and order history show records associated with the signed-in customer's email.
- When a signed-in customer has both trusted-provider `identityProviderVerified=true` and `verificationStatus=verified`, checkout loads the saved customer and delivery profile from `GET /api/account/checkout-profile`, and skips the repeat identity/address step after the fresh order quote. The order endpoint uses the authenticated server-side customer profile, not identity fields submitted by the browser. An admin preview status alone cannot mark a customer verified.
- Sell quotes are illustrative only. The sell-order endpoint is disabled by default. It remains blocked unless `SELL_WORKFLOW_ENABLED=true`, `IDENTITY_PROVIDER_ENABLED=true`, and a signed-in customer has provider-set `identityProviderVerified=true` and `verificationStatus=verified`. Do not enable these flags until approved identity verification, liveness, metal inspection, shipment handling, and regulated payout workflows are implemented and reviewed. No sell request is accepted in the default preview.
- Gold and silver spot references are polled every 5 seconds through Gold API (`https://api.gold-api.com/price/XAU` and `/price/XAG`); a fresh server quote is requested when checkout is reviewed and checked again before the identity step continues to payment. If the quote differs, checkout shows the old and updated totals and requires the customer to accept the updated quote before continuing. The order API performs a final server-side price/cart comparison and rejects stale quotes with a price-change response. No API key is needed for this public feed. If it fails or returns invalid data, the app falls back to clearly labelled mock prices. Provider spot references can be delayed or differ from a dealer's executable quote; catalog premiums, inventory, tax, fees and buyback adjustments remain illustrative. This feed is not an offer to transact.
- The checkout records a server-validated preference for vault storage or home delivery. Both are preview choices only: no payment is collected, no metal is allocated or vaulted, and no shipment is created. The server quote adds a configurable flat service fee (`CHECKOUT_DELIVERY_FEE_CENTS`, default $25 delivery, or `CHECKOUT_VAULT_FEE_CENTS`, default $10 vault) plus a configurable general tax estimate (`CHECKOUT_ESTIMATED_TAX_RATE`, default `0.08` or 8%) on the bullion subtotal. This same general percentage is used for every country; it is not a country/state/province/county tax calculation or a final amount due. Configure it for an illustrative preview only; obtain jurisdiction-specific tax treatment before production. The per-metal $10,000 minimum applies to eligible bullion value before fees and tax.
- Identity step includes front/back government-ID and proof-of-address file selection, mobile snap-photo options, and selfie capture. It uses MediaPipe's bundled JavaScript package with its WebAssembly runtime and model; auto-capture runs across mainstream Chrome, Firefox, and Safari browsers, including Safari on iOS 16 or later. Model/WASM downloads need internet access, and camera access requires a browser-supported secure context (localhost or HTTPS). Manual camera and upload/snap options remain available if automatic detection cannot initialize. Detection frames are processed on-device, but the SDK sends usage/performance metrics to Google after the user consents. The detector does not prove that a person is live or verify identity. Verification ID front, ID back, and proof-of-address files are uploaded to the local backend over HTTPS (localhost is permitted for development), validated by file signature and encrypted at rest with AES-256-GCM in `data/identity-documents/`. The encryption key is kept in the ignored `data/identity-documents/.key` file with restricted local permissions, or can be supplied through `VERIFICATION_DOCUMENTS_KEY` as a 64-character hex secret. Back up and protect the key separately; losing it makes stored files unreadable. An authorized admin can view files through the Customers review panel, and retrieval is not cached. Active file deletion does not purge backups/cloud history. A production system must route verification through an approved identity provider.
- The checkout identity step keeps its continue button available and shows a red, field-specific message for missing documents, a country mismatch, an invalid/expired ID date, or a missing selfie. Selecting Continue to payment opens the payment-method preview only when all local checklist fields are present. The checkout preview locally requires front/back ID, proof-of-address file selection, a manually entered issuing country matching the checkout country, an unexpired date entered by the customer, and a face-framed selfie capture before showing payment options. These are only browser-side completeness checks, not document OCR, authenticity checks, or live-person verification. Server-side purchases require either trusted-provider verification or a completed manual admin review: all submitted documents must be opened and marked reviewed before an administrator can approve the customer. Sell requests still require a trusted identity provider. Card and bank methods remain unconfigured. Crypto checkout creates an unpaid order and invoice when enabled, but does not credit the customer until admin approval. Selecting card shows a country-specific unavailable warning. Selecting crypto reveals USDT, USDC, or BTC with only the supported networks for that asset (USDT: TRON, Ethereum, BNB Smart Chain; USDC: Ethereum; BTC: Bitcoin). Choosing a network opens the next checkout screen with the configured deposit wallet address, exact amount, and 5-minute timer. The order is not sent to admin review until the customer enters the transaction hash and selects Confirm transfer.
- Checkout uses three stages: order/custody details and server quote; an identity and proof-of-address checklist; then card, cryptocurrency, or local bank transfer method selection. Identity documents are uploaded to encrypted local storage for authorized admin review; this is not a trusted identity, OCR, authenticity, or liveness check. The payment step does not collect card data or bank credentials. Crypto deposits use the configured wallet address and remain uncredited until the transaction is checked and an admin approves it. No payment provider is configured for cards or bank transfer.
- Login sessions and temporary quotes are stored in server memory and expire when the server stops. Customer accounts, order records, and audit events are persisted in the encrypted local store. The shopping cart is saved in browser local storage.
- The checkout does not collect payment or create a shipment. International address collection does not mean shipping is available worldwide; destination coverage has not been configured.
- A payment provider should return the customer to `/checkout/success?order=<order-id>` after checkout. The page verifies the order belongs to the signed-in customer and asks the server whether payment status is `paid`; it redirects to `/account` only after that server confirmation. No provider or signed webhook is configured in this preview, so a browser redirect alone cannot mark an order paid or trigger the dashboard redirect.
- Admin access uses a dedicated email and password. Run `npm run admin:setup` to generate credentials: the script saves a salted password hash in `.env` and writes the generated password to a local `ADMIN-CREDENTIALS.txt` file. Open that file to sign in at `/admin/login`; keep it private and delete it after saving the password in a password manager. The `/admin/login` page is also linked as “Staff / Admin portal” in the site footer. The separate staff web server runs on port 3003 and proxies API calls to the main backend on port 3001, so the staff UI stays separate while using the same backend and records. Start both with `npm run admin:stack` after configuring the account. Stop any existing server using port 3001 first. The customer storefront is at `http://localhost:3001`; the admin portal is at `http://localhost:3003/admin/login`. Admin APIs accept only short-lived, server-issued sessions created after successful email/password login. Inventory stock, product premium, fulfillment status, and customer verification status can be edited in memory from the admin pages; the server validates those changes and writes audit events. Changes disappear when the server stops. Shipping cannot be marked shipped or delivered until a verified payment integration records settlement. Refunds remain unavailable because the preview takes no payments. This preview has one admin account; named staff roles, MFA, and dual approval for sensitive changes are not implemented. Do not commit `.env`.

- **Permanent account removal:** Admin → Customers provides an irreversible delete action. The admin must enter the account email and type `DELETE`; the API independently checks both values and the admin session. It removes that user's account, active sessions, linked purchase and sell records, and audit entries that identify the user, then writes the updated encrypted store. The app cannot erase copies held in backups, OneDrive/cloud version history, exports, snapshots, or storage-device remnants. Set and enforce backup/version-history retention separately before treating a deletion as complete under a legal retention policy.

## API routes

`GET /api/health`, `GET /api/prices`, `GET /api/products`, `POST /api/quote` (send `items`, `country`, and `custodyPreference`), `POST /api/orders`, `POST /api/sell/quote`, `POST /api/sell/orders`, `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/account/dashboard`, `GET /api/account/checkout-profile`, `POST /api/account/password`, `GET /api/account/orders/:id/payment-status`, `GET /api/admin/summary`, and admin-session-protected `PATCH /api/admin/products/:id`, `PATCH /api/admin/orders/:id`, `PATCH /api/admin/customers/:id`.

## Production work still required

Before accepting real orders, replace or formally license the public spot feed for commercial quote use, add durable encrypted storage for users and pending verification requests, account recovery, MFA, production-grade distributed rate limiting and monitoring (the preview includes only process-memory per-IP throttles), payment processing, country-specific tax and delivery calculations, destination eligibility and export controls, inventory reservation, contracted vault custody and insurance, carrier tracking, monitoring, and legal, tax, privacy, financial and security review for every country served. Most account subpages and admin workflows remain previews. Review all policy text with qualified legal counsel before launch.

## Customer dashboard

The signed-in account area uses a responsive customer portal with navigation for Dashboard, Vault, Transactions, Fund & withdraw, Buy & sell, Explore, Settings, and Customer care center. Purchase and sell activity comes from the account preview API. Vault holdings and money movement are deliberately marked unavailable until custody, payment, and banking integrations exist. These screens are account-facing previews and do not transfer funds or custody metals.

Registration uses separate first and last name fields, password confirmation with server-side match validation, and optional show/hide controls for both password fields. Successful registration creates a preview account and signs the customer in immediately; email verification is not part of the signup flow. It also uses country-dependent state/province and city selectors, backed by the CountriesNow public location directory. If that directory cannot be reached, region and city fields allow manual entry. Account Settings separates editable account details (including email, phone, and delivery address) from the Security section. The customer header shows a blue verification check only when trusted-provider verification is confirmed; all other states show a red check and an unverified label. The vault area is labelled “Vault.”




Password changes are available in Account Settings → Security. The server requires the current password, checks the new-password confirmation and 12-character minimum, re-hashes the new password with a fresh salt, limits repeated attempts, records an audit event, and rotates active sessions while keeping the current session signed in.

## Cryptocurrency payment verification (disabled by default)

Crypto checkout remains disabled until the feature flag and trusted-identity provider are configured on the server. Network API keys enable automatic on-chain checking; without them, submitted hashes go to required manual admin review. After the customer selects a supported coin and network, the next screen shows the receiving wallet address, exact amount, and a 5-minute timer. The payment is not marked pending before the customer enters a transaction ID/hash and presses Confirm transfer. After confirmation, the server checks the network, token contract, recipient, invoice amount, payment window, and confirmation state where the chain API is available. Reused hashes cannot be used for another order. The order then remains pending admin review. An admin must inspect the blockchain record and approve it before the order is marked paid and recorded on the customer account. An unavailable chain API sends the hash to manual review; it never credits the customer automatically. Inventory is held while the invoice is active and during admin review.

Configured public receiving addresses:

- Ethereum ERC-20 and BNB Smart Chain BEP-20: `0xbc3fe9d192350492b3882097b05349937d378e16`
- TRON TRC-20: `TTYH8oJoKrzrg2dAAVnUi1mYm4baPEK8PM`

Supported combinations are BTC on Bitcoin, USDT on Ethereum, BNB Smart Chain, and TRON, and USDC on Ethereum only. The server uses Blockchain.com for BTC; Etherscan API V2 for Ethereum and BNB Smart Chain; and TronGrid’s solidified transaction receipt for TRON. Ethereum and BNB Smart Chain require 12 confirmations; Bitcoin requires 3; TRON must be solidified by the network. The customer sees a warning to send before pressing Confirm, and can Cancel or submit the transaction hash with Confirm. USDC is limited to Ethereum to avoid accepting an ambiguous bridged token. Stablecoin invoice amounts are priced 1:1 against the USD order total; customers must send the displayed exact amount.

To enable it, set `CRYPTO_PAYMENTS_ENABLED=true` in `.env` and restart the server. Etherscan and TronGrid API keys enable automatic chain checking but are optional: without them, a submitted transaction hash enters manual admin review and must be checked in the linked block explorer before approval. Purchases remain blocked until an administrator has reviewed all required identity documents and approved the customer. The public addresses are included in `.env.example`; they can be overridden using `CRYPTO_EVM_RECEIVE_ADDRESS` and `CRYPTO_TRON_RECEIVE_ADDRESS`. Never put a seed phrase or private key in the project. Blockchain.com’s optional key is `BLOCKCHAIN_EXPLORER_API_KEY`.

The app currently uses the same receiving address for each invoice on a given network. For a real high-volume store, switch to a regulated custody/payment provider or unique per-invoice deposit addresses, with webhook monitoring, refunds, compliance screening, reconciliation, and operational review. The transaction verifier does not make the unconfigured preview a production-ready financial service.


## Repository layout

- `src/` — React application entry point, page components, and frontend styles.
- `styles.css` — shared global styles imported by the frontend.
- `scripts/` — storage, setup, and admin helper scripts.
- `server.js` — Node.js API and production web server.
- `admin-server.js` — separate staff/admin portal server for local use.
- `package.json` / `package-lock.json` — scripts and reproducible dependency versions.
- `.github/workflows/ci.yml` — GitHub Actions build check on pushes and pull requests.
- `render.yaml` — starting configuration for deploying the customer website and API to Render.
- `.env.example` — names and examples of configuration variables; copy to `.env` for local use.

Private `.env` values, local databases, credentials, `node_modules`, generated `dist`, and Git history are intentionally not included in this ZIP. Never commit secrets or real customer data.

## GitHub: upload the project

1. Create a new **empty** repository on GitHub.
2. Extract this ZIP, open the `gold-investment` folder, and upload its contents (including the `.github` folder) to the repository root. Do not upload the parent folder as an extra nested directory.
3. Confirm the repository contains `package.json`, `src/`, `server.js`, and `.github/workflows/ci.yml`.
4. After pushing to `main` or `master`, open the repository's **Actions** tab. The workflow installs dependencies and checks that the production frontend build succeeds.

## Publish the website

This project includes a Node.js API, so **GitHub Pages alone will not run the complete application**. Use a Node-capable host such as Render:

1. Push the repository to GitHub.
2. Sign in to Render and choose **New → Blueprint**, then connect the GitHub repository containing `render.yaml`.
3. Review the service settings and deploy. Render will build with `npm ci && npm run build` and start with `npm start`.
4. Open the public URL Render provides and check the home page and `/api/health`.

Before handling real customers, payments, identity documents, or investment funds, arrange persistent encrypted storage, configure production secrets in the host's environment settings, review authentication/security, and obtain the appropriate legal and compliance advice. The included Render configuration is a deployment starting point, not a production-readiness or financial-regulatory certification. The separate admin portal is not automatically exposed by this customer web service.


## Neon PostgreSQL setup

1. Use Node.js 20 or newer.
2. In the Neon console, open your project and choose **Connect**. Copy the **pooled** connection string (the host usually contains `-pooler`).
3. Copy `.env.example` to `.env`, then replace the `DATABASE_URL` placeholder with your real pooled connection string. Do not commit or share `.env`.
4. Install dependencies with `npm ci`.
5. Check the connection with `npm run db:test`.
6. Create/check the application table with `npm run db:init`. The server also creates this table automatically at startup if it is missing.
7. Start the app with `npm start` or `npm run dev`.

If Neon credentials were previously committed, pasted into a chat, or included in an archive, reset the database password in Neon and update the `DATABASE_URL` environment variable wherever the app is deployed.
