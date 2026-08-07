-- User-entered project tracking fields. One shared row per project ID.
create table if not exists public.project_manual_updates (
  project_id text primary key,
  target_qty numeric,
  unit text,
  start_date date,
  target_completion date,
  actual_output numeric,
  remarks text,
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now()
);

alter table public.project_manual_updates enable row level security;

drop policy if exists "Authenticated users can read project updates" on public.project_manual_updates;
create policy "Authenticated users can read project updates"
  on public.project_manual_updates for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can insert project updates" on public.project_manual_updates;
create policy "Authenticated users can insert project updates"
  on public.project_manual_updates for insert
  to authenticated
  with check ((select auth.uid()) = updated_by);

drop policy if exists "Authenticated users can update project updates" on public.project_manual_updates;
create policy "Authenticated users can update project updates"
  on public.project_manual_updates for update
  to authenticated
  using (true)
  with check ((select auth.uid()) = updated_by);

grant select, insert, update on public.project_manual_updates to authenticated;
