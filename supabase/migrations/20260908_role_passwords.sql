-- Moves role/institute passwords out of the client-shipped app_state blob and out of
-- index.html's own source, into a table that only the role-auth Edge Function (using
-- the service_role key, never the public anon key) can read or write.
--
-- Before this migration, every password in the system (national/president/budget
-- manager/building manager/each institute manager/each institute's staff PIN, plus
-- the national recovery code) was either:
--   1. hardcoded as a plaintext constant directly in index.html's shipped JavaScript, or
--   2. stored inside the single `app_state` row's JSON `data` column, fetched by every
--      client on every page load via the public anon key with no server-side check.
-- Both meant anyone who loaded the public site (or just called the Supabase REST API
-- directly with the already-public anon key) could read every password with zero
-- authentication. See SECURITY_FIX_README.md in the repo root for the full writeup.

create table if not exists role_passwords (
  role_key text primary key,
  password text not null,
  updated_at timestamptz not null default now()
);

comment on table role_passwords is
  'Password per role/institute key (e.g. national, president, institute_<id>, staff_<id>, '
  'nationalRecoveryCode). Read/written ONLY by the role-auth Edge Function via the '
  'service_role key. RLS below has no policies at all, so anon/authenticated get zero '
  'access — do not add a policy here without a real reason.';

alter table role_passwords enable row level security;
-- Intentionally no policies: RLS with no policies denies anon/authenticated entirely.
-- service_role (used only inside the Edge Function) bypasses RLS by default.

create table if not exists role_auth_lockout (
  role_key text primary key,
  failed_count int not null default 0,
  locked_until timestamptz
);

comment on table role_auth_lockout is
  'Brute-force throttle for role-auth: after too many wrong attempts against a given '
  'role_key, further checks are refused for a cooldown window without even comparing '
  'the password. Written only by the role-auth Edge Function.';

alter table role_auth_lockout enable row level security;
-- Same as above: no policies, service_role only.

-- ── One-time seed of the CURRENT real passwords ──
-- Deliberately NOT included as INSERT statements in this file: this migration may end
-- up in git history / a shared repo, and putting live passwords in a committed SQL
-- file would just move the plaintext-exposure problem instead of fixing it.
--
-- Run this once yourself, directly in the Supabase SQL editor (not committed anywhere),
-- filling in the real current values for every institute you have:
--
--   insert into role_passwords (role_key, password) values
--     ('national', '<current national password>'),
--     ('president', '<current president password>'),
--     ('budgetManager', '<current budget manager password>'),
--     ('buildingManager', '<current building manager password>'),
--     ('nationalRecoveryCode', '<current recovery code>'),
--     ('institute_rishon', '<current rishon institute-manager password>'),
--     ('staff_rishon', '<current rishon staff password>'),
--     ('institute_sderot', '<...>'),
--     ('staff_sderot', '<...>'),
--     ('institute_beersheva', '<...>'),
--     ('staff_beersheva', '<...>'),
--     ('institute_jerusalem-head', '<...>'),
--     ('staff_jerusalem-head', '<...>'),
--     ('institute_jerusalem-trauma', '<...>'),
--     ('staff_jerusalem-trauma', '<...>')
--   on conflict (role_key) do update set password = excluded.password, updated_at = now();
--
-- Add one (institute_<id>, staff_<id>) pair per institute that exists today — check the
-- real, current ids/passwords in "מצב מערכת" (as the national admin) BEFORE deploying
-- this fix, since the app will stop being able to show them once the new code is live.
