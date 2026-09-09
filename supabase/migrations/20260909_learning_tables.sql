-- Storage for the learning system, on the same Supabase project as the
-- management system and deliberately unable to touch it.
--
-- ISOLATION — the point of this file. The management system keeps everything
-- in one shared `app_state` row, reached only through the app-state-gateway
-- Edge Function. The learning system gets its own tables here, reached only
-- through its own learning-gateway function. There is no shared table, no
-- shared row and no shared code path, so a bug or a compromise on the
-- learning side cannot read, overwrite or delete a single byte of institute
-- operations data. The two systems share a database server and nothing else.
--
-- The second difference is identity. Management authenticates with role
-- passwords (role_passwords + a token minted by role-auth). Learning
-- authenticates with the institute's Microsoft Entra ID account, verified
-- against Microsoft's public keys inside learning-gateway. Neither trust path
-- can mint a token the other accepts.
--
-- Apply with:  supabase db push      (or paste into the SQL editor)

-- ---------------------------------------------------------------- learners

create table if not exists learning_state (
  user_id     text primary key,          -- Entra object id (oid claim)
  email       text,
  display_name text,
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

comment on table learning_state is
  'One row per learner: their path progress, saved answers, practice journal '
  'and continuing-education record. Written only by the learning-gateway Edge '
  'Function, which resolves user_id from a verified Microsoft token — a learner '
  'can never name a different user_id. Never touched by the management system.';

alter table learning_state enable row level security;
-- Intentionally no policies: RLS with no policies denies anon and authenticated
-- outright. Only service_role, used inside the Edge Function, gets through.

-- ------------------------------------------------------------ hand-ins

create table if not exists learning_submissions (
  id           bigint generated always as identity primary key,
  user_id      text not null references learning_state(user_id) on delete cascade,
  kind         text not null,            -- 'chapter' | 'final' | 'session_quiz'
  ref          text not null,            -- chapter id, or the session id
  answers      jsonb not null default '[]'::jsonb,
  submitted_at timestamptz not null default now(),
  -- the direct manager's response
  feedback     jsonb,
  feedback_by  text,
  feedback_at  timestamptz,
  unique (user_id, kind, ref)
);

comment on table learning_submissions is
  'Tests handed in and the feedback written back. The learner writes the '
  'answers; only a manager or the training coordinator may write feedback — '
  'enforced in learning-gateway, not here.';

create index if not exists learning_submissions_pending
  on learning_submissions (submitted_at)
  where feedback is null;

alter table learning_submissions enable row level security;

-- ------------------------------------------------- who manages whom

create table if not exists learning_roles (
  user_id    text primary key,
  role       text not null default 'learner',   -- learner | manager | coordinator
  manager_id text,                              -- the learner's direct manager
  department text,
  updated_at timestamptz not null default now()
);

comment on table learning_roles is
  'Who is a learner, who is a direct manager, and who reports to whom. A '
  'manager may read their own team''s files and write feedback; the training '
  'coordinator may read every branch. Seeded by the coordinator; the default '
  'for an unknown account is the least-privileged role, learner.';

alter table learning_roles enable row level security;

-- --------------------------------------------------------------- shelf

create table if not exists learning_assets (
  id          bigint generated always as identity primary key,
  title       text not null,
  topic       text,
  kind        text,
  audience    text,
  body        jsonb not null default '{}'::jsonb,
  created_by  text,
  created_at  timestamptz not null default now(),
  reviewed    boolean not null default false
);

comment on table learning_assets is
  'The open knowledge base. Anyone signed in may add; the training coordinator '
  'tags and prunes afterwards, which is the governance the institute chose.';

alter table learning_assets enable row level security;

-- ------------------------------------------------------------ guardrail

-- A standing reminder for whoever reads this later: the learning system must
-- never be given a path to app_state. If a future feature seems to need one,
-- the answer is a new learning_* table, not a shared one.
