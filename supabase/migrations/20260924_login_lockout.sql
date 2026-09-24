-- Login brute-force lockout for learn-auth. MAX_ATTEMPTS/LOCKOUT_MS were
-- declared in learn-auth from the start but never actually enforced — this
-- migration adds the two columns that enforcement needs.
--
-- Apply with: paste into the SQL editor (safe to re-run; both columns use
-- add column if not exists).

alter table learning_accounts
  add column if not exists failed_attempts int not null default 0,
  add column if not exists locked_until timestamptz;

comment on column learning_accounts.failed_attempts is
  'Consecutive wrong-password attempts since the last success or lockout. '
  'Reset to 0 on a successful login or an admin password reset.';

comment on column learning_accounts.locked_until is
  'Set once failed_attempts reaches MAX_ATTEMPTS in learn-auth; login is '
  'refused until this time passes, regardless of whether the password is '
  'now correct. Null means not locked.';
