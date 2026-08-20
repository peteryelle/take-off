#!/usr/bin/env bash
# Rebuilds the local Supabase database from scratch: migrations + seed.sql only.
# Use this after adding/editing a migration to confirm it's reproducible before
# committing — see DEVELOPER.md § "Why you must never edit schema via the
# dashboard SQL editor".
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npx supabase db reset
