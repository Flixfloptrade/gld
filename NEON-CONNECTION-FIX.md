# Neon connection fix

The supplied archive had a local `.env` with a placeholder hostname (`YOUR-NEON-HOST-pooler.REGION.aws.neon.tech`). A real Neon connection cannot succeed until you replace that value with the connection string from your own Neon project.

## Set up locally

1. Copy `.env.example` to `.env` in this project folder.
2. In Neon Console, open your project and select **Connect**. Choose the correct branch and database, then copy the pooled PostgreSQL connection string.
3. Put it on one line as `DATABASE_URL=postgresql://...` in `.env`. Do not share or commit `.env`.
4. Install dependencies with `npm install`.
5. Run `node test-neon.js` to test the connection.

The test now loads `.env` from the project folder and rejects obvious template values with a clear message. It never prints credentials. `db.js` also detects placeholder configuration early.

## Important

- Do not run database initialization to fix a hostname/DNS error. This fix does not reset or modify database contents.
- Configure the live service's `DATABASE_URL` separately in Render's environment settings; local `.env` does not update Render.
- The ZIP intentionally excludes `.env`, `.git`, and `node_modules` to avoid sharing secrets/history and platform-specific installed packages. Keep your original `.env` privately and update it with the real connection string.
