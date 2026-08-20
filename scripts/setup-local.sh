#!/usr/bin/env bash
# One-time local setup: installs deps, creates .env.local, starts local Supabase.
# Safe to re-run. See DEVELOPER.md for the full picture (including Option B,
# pointing at the shared remote "development" branch instead of local Postgres).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Installing npm dependencies"
npm install

if [ ! -f .env.local ]; then
  echo "==> Creating .env.local from .env.example (fill in real values — see DEVELOPER.md)"
  cp .env.example .env.local
else
  echo "==> .env.local already exists, leaving it as-is"
fi

if ! docker info >/dev/null 2>&1; then
  echo "==> Docker is not running. Start Docker Desktop, then re-run this script"
  echo "    (or use Option B — point .env.local at the shared 'development' branch instead)."
  exit 1
fi

echo "==> Starting local Supabase (Postgres, Auth, Storage, Studio via Docker)"
npx supabase start

echo "==> Rebuilding the local database from supabase/migrations/ + supabase/seed.sql"
npx supabase db reset

echo
echo "==> Done. Local Supabase credentials:"
npx supabase status
echo
echo "If using Option A (local Postgres), copy the API_URL/ANON_KEY/SERVICE_ROLE_KEY"
echo "above into .env.local as SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY."
echo "Then run: npm run dev"
