-- Saved bio log uploads for the DTR's "Upload Bio Logs" (My DTR tab).
--
-- One row is one saved upload: ONE employee's taps for ONE payroll period. The device
-- file itself (every employee's attendance) is never stored — the browser keeps only
-- the signed-in employee's taps before anything is sent here.
--
-- Append-only. Saving inserts a row; the newest row of a period is the one compared,
-- older rows are history. "Clear" marks the newest row cleared — the server stamps the
-- time — and that is the only change a row ever allows. Nothing can be deleted.
--
-- These rows never touch public.dtr_storage_dtr: taking bio times into a DTR day goes
-- through the DTR's own revision-checked save (see docs/data-safety.md).
--
-- The DTR checks its passcodes in the browser rather than through Supabase Auth, so
-- the policies follow the existing login-free DTR model (dtr_storage_dtr,
-- dtr_attachments): anyone holding the app's public key can read these rows. That is
-- why a row holds one employee's taps for one period and nothing more.

create table if not exists public.dtr_bio_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null,
  payroll_start date not null,
  payroll_end date not null,
  file_name text not null default '',
  device_serial text not null default '',
  -- the dates the uploaded file spanned, so coverage can still be explained later
  file_first date,
  file_last date,
  taps jsonb not null default '[]'::jsonb,
  uploaded_by_id text not null default '',
  uploaded_by_name text not null default '',
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by_id text not null default '',
  cleared_by_name text not null default '',
  constraint dtr_bio_logs_period check (payroll_end >= payroll_start),
  constraint dtr_bio_logs_taps_array check (jsonb_typeof(taps) = 'array'),
  -- a period's taps for one person are a few kilobytes; this stops a runaway write
  constraint dtr_bio_logs_taps_size check (octet_length(taps::text) <= 1000000)
);

create index if not exists dtr_bio_logs_period_idx
  on public.dtr_bio_logs (employee_id, payroll_start, payroll_end, created_at desc);

-- Clearing is the only update, it happens once, and its time is the server's.
create or replace function public.dtr_bio_logs_clear_only()
returns trigger
language plpgsql
as $$
begin
  if old.cleared_at is not null then
    raise exception 'This bio log upload is already cleared';
  end if;
  if new.cleared_at is null then
    raise exception 'A bio log upload can only be cleared';
  end if;
  if new.id is distinct from old.id
     or new.employee_id is distinct from old.employee_id
     or new.payroll_start is distinct from old.payroll_start
     or new.payroll_end is distinct from old.payroll_end
     or new.file_name is distinct from old.file_name
     or new.device_serial is distinct from old.device_serial
     or new.file_first is distinct from old.file_first
     or new.file_last is distinct from old.file_last
     or new.taps is distinct from old.taps
     or new.uploaded_by_id is distinct from old.uploaded_by_id
     or new.uploaded_by_name is distinct from old.uploaded_by_name
     or new.created_at is distinct from old.created_at then
    raise exception 'A saved bio log upload cannot be changed, only cleared';
  end if;
  new.cleared_at := now();
  return new;
end
$$;

drop trigger if exists dtr_bio_logs_clear_only on public.dtr_bio_logs;
create trigger dtr_bio_logs_clear_only
  before update on public.dtr_bio_logs
  for each row execute function public.dtr_bio_logs_clear_only();

alter table public.dtr_bio_logs enable row level security;

drop policy if exists "DTR bio logs can be read publicly" on public.dtr_bio_logs;
create policy "DTR bio logs can be read publicly"
  on public.dtr_bio_logs for select
  to anon, authenticated using (true);

drop policy if exists "DTR bio logs can be saved publicly" on public.dtr_bio_logs;
create policy "DTR bio logs can be saved publicly"
  on public.dtr_bio_logs for insert
  to anon, authenticated with check (cleared_at is null);

drop policy if exists "DTR bio logs can be cleared publicly" on public.dtr_bio_logs;
create policy "DTR bio logs can be cleared publicly"
  on public.dtr_bio_logs for update
  to anon, authenticated using (cleared_at is null) with check (cleared_at is not null);

-- No delete policy and no delete grant: history is never removed.
revoke all on public.dtr_bio_logs from anon, authenticated;
grant select, insert on public.dtr_bio_logs to anon, authenticated;
grant update (cleared_at, cleared_by_id, cleared_by_name) on public.dtr_bio_logs to anon, authenticated;
