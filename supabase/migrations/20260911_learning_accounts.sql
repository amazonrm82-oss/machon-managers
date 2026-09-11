-- Email + password accounts for the learning system, with admin approval.
--
-- This is the learning system's own sign-in, separate from Microsoft Entra ID
-- (which stays available for later) and completely separate from the management
-- system. Passwords are salted+hashed inside the learn-auth Edge Function and
-- never stored or compared in the browser. Registration is self-service but a
-- new account is `pending` until the single system administrator approves it.
--
-- The administrator is whoever registers with the address configured as
-- LEARN_ADMIN_EMAIL (a Supabase secret) — that one account is auto-approved and
-- is the only account that may approve, reject or manage the others.
--
-- Apply with:  supabase db push   (or paste into the SQL editor)

create table if not exists learning_accounts (
  id           text primary key,                 -- random id minted by learn-auth
  full_name    text not null,
  role         text not null default '',
  email        text not null unique,             -- stored lower-cased; must be @icelp.org.il
  national_id  text not null,                    -- ת"ז (validated by checksum in learn-auth)
  pwd          text not null,                    -- pbkdf2$<iterations>$<salt>$<hash>, never plaintext
  status       text not null default 'pending',  -- pending | approved | rejected
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now(),
  approved_by  text,
  approved_at  timestamptz
);

comment on table learning_accounts is
  'Learning-system sign-in accounts. Written only by the learn-auth Edge '
  'Function. Passwords are PBKDF2 hashes; a new account is pending until the '
  'configured administrator approves it. Isolated from the management system.';

create index if not exists learning_accounts_pending
  on learning_accounts (created_at) where status = 'pending';

alter table learning_accounts enable row level security;
-- No policies on purpose: RLS with no policies denies anon and authenticated
-- outright. Only service_role, used inside learn-auth, gets through.

-- The administrator's device push endpoints, so a new registration can ping the
-- phone. Kept in its own table — the management system's push_subscriptions is
-- never touched.
create table if not exists learning_push (
  endpoint     text primary key,
  subscription jsonb not null,
  user_id      text,
  created_at   timestamptz not null default now()
);

alter table learning_push enable row level security;
