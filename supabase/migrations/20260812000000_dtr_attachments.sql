-- Supporting documents for a DTR date, kept separate from punch records.
-- The DTR app uses passcodes in the browser rather than Supabase Auth, so these
-- policies follow the existing login-free DTR storage model.
create table if not exists public.dtr_attachments (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null,
  employee_name text not null default '',
  payroll_start date not null,
  payroll_end date not null,
  work_date date not null,
  attachment_type text not null,
  note text not null default '',
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null default 'application/octet-stream',
  file_size integer not null default 0,
  uploaded_by_id text not null default '',
  uploaded_by_name text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists dtr_attachments_period_idx
  on public.dtr_attachments (employee_id, payroll_start, payroll_end, work_date);

alter table public.dtr_attachments enable row level security;

drop policy if exists "DTR attachments can be read publicly" on public.dtr_attachments;
create policy "DTR attachments can be read publicly"
  on public.dtr_attachments for select
  to anon, authenticated using (true);

drop policy if exists "DTR attachments can be created publicly" on public.dtr_attachments;
create policy "DTR attachments can be created publicly"
  on public.dtr_attachments for insert
  to anon, authenticated with check (true);

drop policy if exists "DTR attachments can be removed publicly" on public.dtr_attachments;
create policy "DTR attachments can be removed publicly"
  on public.dtr_attachments for delete
  to anon, authenticated using (true);

grant select, insert, delete on public.dtr_attachments to anon, authenticated;

insert into storage.buckets (id, name, public)
values ('dtr-attachments', 'dtr-attachments', false)
on conflict (id) do update set public = false;

drop policy if exists "DTR attachment files can be read" on storage.objects;
create policy "DTR attachment files can be read"
  on storage.objects for select
  to anon, authenticated using (bucket_id = 'dtr-attachments');

drop policy if exists "DTR attachment files can be uploaded" on storage.objects;
create policy "DTR attachment files can be uploaded"
  on storage.objects for insert
  to anon, authenticated with check (bucket_id = 'dtr-attachments');

drop policy if exists "DTR attachment files can be removed" on storage.objects;
create policy "DTR attachment files can be removed"
  on storage.objects for delete
  to anon, authenticated using (bucket_id = 'dtr-attachments');
