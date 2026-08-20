# Developer Setup

Use this file to start Take-off locally.

For most development work, use the **shared Supabase `development` branch**. Only use the fully local Supabase/Docker setup when you are changing the database schema, migrations, or RLS policies.

---

## Start the system — normal development

### 1. Clone the repo

```bash
git clone <repo-url>
cd take-off
```

### 2. Use the correct Node version and install dependencies

```bash
nvm use
npm install
```

> If you do not use `nvm`, install Node.js 20 or newer.

### 3. Create your local environment file

```bash
cp .env.example .env.local
```

### 4. Add the Supabase `development` credentials

In the Supabase dashboard:

1. Open the Take-off project.
2. Switch the branch selector to **`development`**.
3. Open **Project Settings → API**.
4. Copy the development branch values into `.env.local`.

Your `.env.local` should contain:

```bash
SUPABASE_URL=<development-project-url>
SUPABASE_ANON_KEY=<development-anon-key>
SUPABASE_SERVICE_KEY=<development-service-role-key>
```

Ask a teammate for the `SUPABASE_SERVICE_KEY` if you do not already have access to it.

If you are working on AI detection features, also add:

```bash
ANTHROPIC_API_KEY=<your-anthropic-key>
```

Invite-email testing may also require:

```bash
RESEND_API_KEY=<your-resend-key>
RESEND_FROM=<verified-sender>
```

### 5. Start the app

```bash
npm run dev
```

### 6. Open the app

```text
http://localhost:8888
```

That is all you need for normal frontend, Netlify Function, and application development.

---

# Fully local database setup

Use this only when changing:

- database schema
- migrations
- RLS policies
- database functions or triggers

Docker must be running first.

## Fast setup

```bash
./scripts/setup-local.sh
npm run dev
```

Then open:

```text
http://localhost:8888
```

## Manual setup

If you need to run the setup manually:

```bash
npm install
cp .env.example .env.local
npx supabase start
npx supabase db reset
npx supabase status
```

Copy the values printed by `npx supabase status` into `.env.local`:

```bash
SUPABASE_URL=<API_URL>
SUPABASE_ANON_KEY=<ANON_KEY>
SUPABASE_SERVICE_KEY=<SERVICE_ROLE_KEY>
```

Then start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:8888
```

Local Supabase tools:

```text
Supabase API:    http://127.0.0.1:54321
Supabase Studio: http://127.0.0.1:54323
Mailpit:         http://127.0.0.1:54324
```

A local test account is created automatically after `supabase db reset`:

```text
Email:    dev@example.com
Password: devpassword123
```

To stop local Supabase:

```bash
npx supabase stop
```

To rebuild the local database from migrations and seed data:

```bash
npx supabase db reset
```

---

# Database changes

All schema changes must be made through files in:

```text
supabase/migrations/
```

Do **not** make schema changes directly in the hosted Supabase dashboard.

Use this workflow:

```bash
git checkout -b feature/my-change
npx supabase start
npx supabase migration new my_change_description
```

Edit the generated migration, then run:

```bash
npx supabase db reset
npm test
git add supabase/migrations/
git commit -m "Describe the database change"
git push
```

Open a PR into `development`.

For detailed database rules, see:

```text
docs/SUPABASE_DATABASE_DEVELOPMENT_BEST_PRACTICES.md
```

For Git workflow conventions, see:

```text
docs/GIT_BEST_PRACTICES.md
```

---

# Useful commands

Start the app:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Start local Supabase:

```bash
npx supabase start
```

Stop local Supabase:

```bash
npx supabase stop
```

Reset local database:

```bash
npx supabase db reset
```

Check local Supabase credentials and URLs:

```bash
npx supabase status
```

---

# Important security rule

Never commit `.env.local` or expose these values in browser code:

```text
SUPABASE_SERVICE_KEY
ANTHROPIC_API_KEY
RESEND_API_KEY
```

`SUPABASE_ANON_KEY` is intentionally browser-safe and is protected by Supabase RLS policies.
