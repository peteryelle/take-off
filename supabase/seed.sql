-- Local/dev seed data, applied after migrations by `supabase db reset`.
-- Keep this idempotent (safe to re-run) and free of real customer data.

-- The "schematics" bucket holds uploaded drawing-set PDFs and annotated page
-- images (netlify/functions/pdf-storage-url.js, pass-c-detect.js). It's a data
-- row in storage.buckets, not part of the schema, so migrations don't create it.
insert into storage.buckets (id, name, public)
values ('schematics', 'schematics', false)
on conflict (id) do nothing;

-- Local dev login: dev@example.com / devpassword123
-- Inserting directly into auth.users (rather than via the admin API) so this
-- account exists immediately after `supabase db reset`, with no manual step.
-- email_change / email_change_token_new must be '' not NULL — GoTrue's Go
-- scanner errors ("converting NULL to string") on login otherwise; every
-- other auth.users column not set here already defaults to '' or NULL-safe.
-- on_auth_user_created still fires on this insert, same as any real signup,
-- so it gets its own organizations + profiles (role owner) row automatically.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change, email_change_token_new
) values (
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-00000000000a',
  'authenticated', 'authenticated',
  'dev@example.com',
  crypt('devpassword123', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}', '{}',
  '', '', '', ''
) on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  gen_random_uuid(), 'a0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-00000000000a', 'email', 'dev@example.com'),
  'email', now(), now(), now()
) on conflict do nothing;
