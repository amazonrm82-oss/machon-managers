-- Real, shared backing for the learning system's supervision, content and
-- session-registration features — everything that was, until now, a
-- per-browser demo (learning_state/learning_submissions already existed and
-- keep working as before; this file only adds what those tables did not
-- cover).
--
-- Apply with:  supabase db push      (or paste into the SQL editor)

-- ------------------------------------------------------- shared content

-- The curriculum (stages/tracks/chapters) and the enrichment-session
-- schedule, as ONE shared row — same pattern as the management system's
-- app_state singleton. Every learner reads this row; only the learning
-- system administrator (matanz@icelp.org.il, checked in learning-gateway,
-- not here) may write it. A missing row simply means "nobody has customized
-- the content yet" — the client's own built-in defaults cover that case.
create table if not exists learning_content (
  id          int primary key default 1,
  curriculum  jsonb not null default '{}'::jsonb,
  sessions    jsonb not null default '[]'::jsonb,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  constraint learning_content_singleton check (id = 1)
);

comment on table learning_content is
  'The one shared copy of the curriculum and the enrichment-session schedule. '
  'Every learner reads it; only the administrator may write it (enforced in '
  'learning-gateway). Analogous to app_state in the management system, but a '
  'completely separate table — see the isolation note in learning_state.';

alter table learning_content enable row level security;
-- No policies on purpose: only the service_role used inside learning-gateway
-- may read or write this table.

-- ---------------------------------------------------- session registration

-- Real attendance intent for an enrichment session, so "32 registered" and
-- "who registered" are real numbers instead of demo text, and a learner who
-- registers gets access to what is inside the session (recording, Zoom link).
create table if not exists learning_session_registrations (
  user_id       text not null,
  session_ref   text not null,        -- index into learning_content.sessions, as a string
  registered_at timestamptz not null default now(),
  primary key (user_id, session_ref)
);

comment on table learning_session_registrations is
  'Who registered for which enrichment session. Any signed-in learner may add '
  'their own row; only the administrator may list a session''s registrants — '
  'enforced in learning-gateway.';

alter table learning_session_registrations enable row level security;

-- -------------------------------------------------------- chapter oversight

-- Per-chapter oversight, orthogonal to the person-hierarchy manager_id
-- relationship already in learning_roles. A chapter manager sees every
-- learner's status and exam for that one chapter, regardless of who their
-- direct mentor is. Assignment is restricted to the administrator — enforced
-- in learning-gateway, not here.
create table if not exists learning_chapter_managers (
  user_id      text not null,
  chapter_ref  text not null,
  assigned_by  text,
  assigned_at  timestamptz not null default now(),
  primary key (user_id, chapter_ref)
);

comment on table learning_chapter_managers is
  'Per-chapter oversight: user_id may see every learner''s status and exam for '
  'chapter_ref, regardless of the ordinary mentor relationship. Only the '
  'administrator may grant or revoke this — enforced in learning-gateway.';

alter table learning_chapter_managers enable row level security;

-- --------------------------------------------------------- topic attendance

-- Per-topic attendance inside a chapter (the chapter's "outline" items,
-- already admin-authored — see learning_content). Marked ONLY by the
-- learner's mentor, that chapter's chapter-manager, the coordinator, or the
-- administrator — never by the learner themself, since this represents
-- real-world attendance the supervisor observed, not self-reported progress.
create table if not exists learning_topic_attendance (
  user_id      text not null,
  chapter_ref  text not null,
  topic_index  int  not null,
  marked_by    text not null,
  marked_at    timestamptz not null default now(),
  primary key (user_id, chapter_ref, topic_index)
);

comment on table learning_topic_attendance is
  'Attendance checkmarks for one topic inside one chapter, for one learner — '
  'set only by that learner''s mentor, the chapter''s chapter-manager, the '
  'coordinator, or the administrator (enforced in learning-gateway). Presence '
  'of a row means "present/attended"; there is nothing else to the mark.';

alter table learning_topic_attendance enable row level security;

-- ------------------------------------------------------------------ cohorts

-- A cohort ("תקופה") is a group of learners moving through the 90-day track
-- together, on their own timeline. Several cohorts may run at once (a new
-- intake starting while an earlier one is mid-programme) or one after
-- another — nothing here assumes there is only one. A learner's day-in-track
-- (which stage is open, how the certificate's 90-day window is counted) is
-- computed from their cohort's start_date, not a global clock.
create table if not exists learning_cohorts (
  id          text primary key,
  name        text not null,
  start_date  date not null,
  end_date    date,
  created_by  text,
  created_at  timestamptz not null default now()
);

comment on table learning_cohorts is
  'A named group of learners ("class") with its own start date, so the '
  '90-day track opens on the cohort''s own clock. Created and edited only by '
  'the administrator.';

alter table learning_cohorts enable row level security;

create table if not exists learning_cohort_members (
  cohort_id  text not null references learning_cohorts(id) on delete cascade,
  user_id    text not null,
  added_by   text,
  added_at   timestamptz not null default now(),
  primary key (cohort_id, user_id)
);

comment on table learning_cohort_members is
  'Who belongs to which cohort. Membership is set only by the administrator, '
  'full-replace per cohort (see the setCohortMembers action) rather than '
  'incremental add/remove, so the roster shown in the admin screen is always '
  'exactly what gets saved.';

alter table learning_cohort_members enable row level security;

-- ------------------------------------------------------------ guardrail

-- Same reminder as learning_tables.sql: nothing in this file may ever gain a
-- path to app_state or any management table. A new learning_* table is
-- always the right answer, never a shared one.
