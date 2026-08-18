// provision-owner.mjs
// One-off: create the first owner account on an existing org.
//
// Run from inside the repo (so @supabase/supabase-js resolves), passing the
// values inline. Single-quote the password so shell specials like # are literal:
//
//   cd ~/take-off
//   SUPABASE_URL="https://lpjpqmpjxtwsnakcwqvb.supabase.co" \
//   SUPABASE_SERVICE_KEY="your-service-role-key" \
//   OWNER_EMAIL="peter@biq-i.com" \
//   OWNER_PW='Test1234#' \
//   node provision-owner.mjs
//
// app_metadata.org_id = 1 makes the handle_new_user trigger attach this user
// to org 1 (Winquest) as owner — no remap needed. Omit org_id to create a new org.

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const { data, error } = await sb.auth.admin.createUser({
  email: process.env.OWNER_EMAIL,
  password: process.env.OWNER_PW,
  email_confirm: true,
  app_metadata: { org_id: 1, role: "owner" }
});

if (error) {
  console.error("FAILED:", error.message);
  process.exit(1);
}
console.log("created " + data.user.id);
