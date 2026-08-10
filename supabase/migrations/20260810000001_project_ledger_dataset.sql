-- The Project Ledger figures used to be a hardcoded snapshot in the bundle.
-- They now come from the workbooks a user uploads, and the parsed result is kept
-- here so every signed-in user opens the same figures without re-uploading.
--
-- One row, id = 'current'. An upload replaces it; there is no per-user copy.
-- The payload is the parsed store: { version, coll: [...], dim: [[key, {...}], ...] }.
create table if not exists public.project_ledger_dataset (
  id text primary key default 'current',
  payload jsonb not null,
  source_label text not null default '',
  project_count integer not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_username text,
  uploaded_at timestamptz not null default now(),
  constraint project_ledger_dataset_single_row check (id = 'current'),
  constraint project_ledger_dataset_payload_object check (jsonb_typeof(payload) = 'object')
);

alter table public.project_ledger_dataset enable row level security;

drop policy if exists "Authenticated users can read the ledger dataset" on public.project_ledger_dataset;
create policy "Authenticated users can read the ledger dataset"
  on public.project_ledger_dataset for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can create the ledger dataset" on public.project_ledger_dataset;
create policy "Authenticated users can create the ledger dataset"
  on public.project_ledger_dataset for insert
  to authenticated
  with check ((select auth.uid()) = uploaded_by);

drop policy if exists "Authenticated users can replace the ledger dataset" on public.project_ledger_dataset;
create policy "Authenticated users can replace the ledger dataset"
  on public.project_ledger_dataset for update
  to authenticated
  using (true)
  with check ((select auth.uid()) = uploaded_by);

-- The dataset is replaced by the next upload, never dropped.
revoke delete on public.project_ledger_dataset from authenticated;
grant select, insert, update on public.project_ledger_dataset to authenticated;
