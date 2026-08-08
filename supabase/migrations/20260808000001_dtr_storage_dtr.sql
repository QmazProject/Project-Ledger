-- Login-free DTR storage. The _dtr suffix keeps this data separate from Project Ledger.
create table if not exists public.dtr_storage_dtr (
  storage_key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.dtr_storage_dtr enable row level security;

drop policy if exists "DTR data can be read publicly" on public.dtr_storage_dtr;
create policy "DTR data can be read publicly"
  on public.dtr_storage_dtr for select
  to anon, authenticated
  using (true);

drop policy if exists "DTR data can be created publicly" on public.dtr_storage_dtr;
create policy "DTR data can be created publicly"
  on public.dtr_storage_dtr for insert
  to anon, authenticated
  with check (true);

drop policy if exists "DTR data can be updated publicly" on public.dtr_storage_dtr;
create policy "DTR data can be updated publicly"
  on public.dtr_storage_dtr for update
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update on public.dtr_storage_dtr to anon, authenticated;
