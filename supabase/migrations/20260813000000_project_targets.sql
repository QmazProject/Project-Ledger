-- Multiple Targets per project.
--
-- Until now a project could carry exactly one set of target values, because they
-- were six columns on project_manual_updates, whose primary key is the project
-- ID. A project can have several deliverables running at once, so the target
-- fields move to their own table with one row per target.
--
-- The six columns on project_manual_updates are deliberately left in place and
-- are no longer read by the application. They are the rollback path: this
-- migration copies rather than moves, so reverting the app restores the old
-- behaviour without restoring data. A later migration drops them.

-- ---------------------------------------------------------------------------
-- Canonical project key
-- ---------------------------------------------------------------------------
-- Project IDs are matched two different ways today, and only one of them is
-- safe. The workbook readers join master attributes to collectibles rows on a
-- normalised key (uppercased, apostrophes stripped), but hand-typed rows are
-- keyed on the raw ID, so a project whose ID changes case or loses an
-- apostrophe between workbook versions silently orphans its manual data. This
-- function is the normalisation, expressed once, so targets never inherit that
-- weakness. It mirrors NORM() in src/lib/targets.js exactly.
--
-- Whitespace is NOT part of the problem: the readers already collapse and trim
-- it on both the write and the read path. Case and apostrophes are.
-- The whitespace class is spelled out rather than written as \s on purpose.
-- PostgreSQL's \s means [[:space:]], which is resolved against the database
-- locale: under glibc it does NOT include U+00A0 (non-breaking space), because
-- glibc deliberately classifies NBSP as non-breaking rather than as space.
-- JavaScript's \s does include it, along with U+FEFF and the Unicode Zs set.
-- Left as \s the two normalisations would disagree on any ID carrying an NBSP -
-- which is exactly what pasting a cell out of Word or a web page into Excel
-- produces - and the SQL key would silently stop matching the JS one.
-- Enumerating the set makes the function locale-independent as well as correct.
create or replace function public.project_key(value text)
returns text
language sql
immutable
parallel safe
as $$
  select btrim(
           regexp_replace(
             translate(upper(coalesce(value, '')), '''’', ''),
             '[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
             ' ', 'g'
           )
         );
$$;

comment on function public.project_key(text) is
  'Canonical form of a project ID for matching: uppercased, apostrophes removed, whitespace collapsed and trimmed. Mirrors NORM() in src/lib/targets.js, including JavaScript''s wider definition of whitespace. Display IDs are never rewritten - this is only ever a join key. Known limitation: upper() folds non-ASCII letters per the database locale, so an ID containing (for example) a German sharp s would differ from the JavaScript result; project IDs in this system are ASCII.';

-- ---------------------------------------------------------------------------
-- Targets
-- ---------------------------------------------------------------------------
-- No foreign key to a projects table, because there is no projects table: the
-- project list lives in the project_ledger_dataset JSONB payload and is
-- replaced wholesale by each workbook import. A key to project_manual_updates
-- would be wrong too - that row only exists once somebody has typed something,
-- and a target must be creatable before that. project_key is the join.
create table if not exists public.project_targets (
  id uuid primary key default gen_random_uuid(),

  -- the ID exactly as the workbook spells it, kept for display and export
  project_id text not null,
  -- what everything actually joins on
  project_key text not null,

  -- Nullable on purpose. Targets created by the backfill below have no scope,
  -- because nothing in the old schema held one and inventing it from Remarks
  -- would merge two fields the business has explicitly separated. The
  -- application requires a scope for newly created targets; existing ones are
  -- shown as needing a scope until somebody fills it in.
  scope text,

  target_qty numeric,
  unit text,
  start_date date,
  target_completion date,
  actual_completion date,
  actual_output numeric,

  -- Soft removal. No table in this schema grants DELETE to anyone, and audit
  -- history references targets, so removing a target hides it rather than
  -- destroying the record of the work.
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,

  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),

  -- Set only by the backfill below, to the project_manual_updates row it came
  -- from. This is what makes re-running the migration safe; it is never set for
  -- targets created through the application.
  migrated_from_project_id text
);

create index if not exists project_targets_project_key_idx
  on public.project_targets (project_key)
  where archived_at is null;

create index if not exists project_targets_lookup_idx
  on public.project_targets (project_key, target_completion);

-- Hard guarantee that the backfill cannot double-insert, independent of how it
-- is invoked.
create unique index if not exists project_targets_migration_once_idx
  on public.project_targets (migrated_from_project_id)
  where migrated_from_project_id is not null;

alter table public.project_targets enable row level security;

drop policy if exists "Authenticated users can read project targets" on public.project_targets;
create policy "Authenticated users can read project targets"
  on public.project_targets for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert project targets" on public.project_targets;
create policy "Authenticated users can insert project targets"
  on public.project_targets for insert
  to authenticated
  with check ((select auth.uid()) = created_by);

drop policy if exists "Authenticated users can update project targets" on public.project_targets;
create policy "Authenticated users can update project targets"
  on public.project_targets for update
  to authenticated
  using (true)
  with check ((select auth.uid()) = updated_by);

-- Matches every other table here: nothing is ever deleted, only archived.
revoke delete on public.project_targets from authenticated;
grant select, insert, update on public.project_targets to authenticated;

-- Belt and braces on the anonymous role. RLS already blocks it - there is no
-- policy naming anon, so every statement it could attempt returns nothing - but
-- a project may carry ALTER DEFAULT PRIVILEGES that grants the API roles table
-- privileges automatically, and a grant that RLS happens to neutralise is still
-- a grant nobody intended. Revoking makes the intent explicit rather than
-- leaving it to be inferred from the absence of a policy.
revoke all on public.project_targets from anon;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Every project that already holds any target information becomes a project
-- with exactly one target. The old primary key guarantees at most one set per
-- project, so there is no ambiguity to resolve.
--
-- A project whose six target fields are all empty gets no target at all.
-- Creating an empty one would flip it from "No target" to "With target" in the
-- filter and change the tracking counts without anybody entering data.
--
-- Re-runnable: the NOT EXISTS test plus the unique index above mean a second
-- run inserts nothing.
insert into public.project_targets (
  project_id, project_key,
  target_qty, unit, start_date, target_completion, actual_completion, actual_output,
  created_by, created_at, updated_by, updated_at,
  migrated_from_project_id
)
select
  m.project_id,
  public.project_key(m.project_id),
  m.target_qty, m.unit, m.start_date, m.target_completion, m.actual_completion, m.actual_output,
  m.updated_by, m.updated_at, m.updated_by, m.updated_at,
  m.project_id
from public.project_manual_updates m
where (
    m.target_qty is not null
    or m.unit is not null
    or m.start_date is not null
    or m.target_completion is not null
    or m.actual_completion is not null
    or m.actual_output is not null
  )
  and not exists (
    select 1
    from public.project_targets t
    where t.migrated_from_project_id = m.project_id
  );

comment on table public.project_targets is
  'One row per target. Project-level values (contract, status, remarks, district, engineer, and every imported figure) deliberately have no column here - they have a single source of truth on the project and are only ever read, never copied.';
