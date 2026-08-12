-- Keep the original Project Ledger workbooks so administrators can review the
-- upload history per user.  The bucket is private; signed links are created by
-- the existing admin-only Edge Function after it verifies the caller's role.
insert into storage.buckets (id, name, public)
values ('project-ledger-uploads', 'project-ledger-uploads', false)
on conflict (id) do update set public = false;

create table if not exists public.project_ledger_uploads (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  original_filename text not null,
  storage_path text not null unique,
  uploaded_at timestamptz not null default now(),
  constraint project_ledger_uploads_filename_present
    check (char_length(btrim(original_filename)) > 0)
);

create index if not exists project_ledger_uploads_user_time_idx
  on public.project_ledger_uploads (uploaded_by, uploaded_at desc);

alter table public.project_ledger_uploads enable row level security;

drop policy if exists "Users can record their own ledger uploads" on public.project_ledger_uploads;
create policy "Users can record their own ledger uploads"
  on public.project_ledger_uploads for insert
  to authenticated
  with check (
    (select auth.uid()) = uploaded_by
    and split_part(storage_path, '/', 1) = (select auth.uid())::text
  );

-- Uploaders only need INSERT. Admin reads and signed-link generation use the
-- service-role client inside admin-users, which bypasses RLS.
revoke all on public.project_ledger_uploads from authenticated;
grant insert on public.project_ledger_uploads to authenticated;

drop policy if exists "Users can archive their own ledger workbooks" on storage.objects;
create policy "Users can archive their own ledger workbooks"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'project-ledger-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and lower(storage.extension(name)) in ('xlsx', 'xls', 'xlsm')
  );
