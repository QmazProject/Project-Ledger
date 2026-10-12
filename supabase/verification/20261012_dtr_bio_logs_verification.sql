-- Verification for 20261012000000_dtr_bio_logs.sql
--
-- Proves the bio log table is append-only as claimed: a row can be saved and cleared
-- once (with the server's time), and never changed, re-cleared or deleted. Every
-- assertion raises on failure, so the script either runs clean or stops with the reason.
--
-- SAFE TO RUN: it acts as the app's own role (anon), touches only employee_id
-- 'TEST-BIO', and runs inside one transaction that is rolled back at the end — nothing
-- it writes is kept, and no real employee's row is read or changed.

begin;
set local role anon;

do $$
declare
  rid     uuid;
  n       int;
  stamped timestamptz;
begin
  insert into public.dtr_bio_logs (employee_id, payroll_start, payroll_end, file_name, taps)
  values ('TEST-BIO', '2026-09-13', '2026-09-27', 'test.dat',
          '[{"date":"2026-09-15","time":"07:51","kind":"in","code":"0"}]'::jsonb)
  returning id into rid;

  -- 1. clearing updates the row once, and the time is the server's, not the client's
  update public.dtr_bio_logs set cleared_at = '2000-01-01', cleared_by_id = 'TEST'
   where id = rid and cleared_at is null;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'clearing should update exactly one row, updated %', n; end if;
  select cleared_at into stamped from public.dtr_bio_logs where id = rid;
  if stamped < now() - interval '1 minute' then
    raise exception 'cleared_at should be stamped by the server, got %', stamped;
  end if;

  -- 2. a cleared row cannot be cleared again
  update public.dtr_bio_logs set cleared_at = now() where id = rid;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a cleared upload was updated again'; end if;

  -- 3. the saved taps cannot be changed
  begin
    update public.dtr_bio_logs set taps = '[]'::jsonb where id = rid;
    raise exception 'changing saved taps should have been refused';
  exception when insufficient_privilege then null;
  end;

  -- 4. nothing can be deleted
  begin
    delete from public.dtr_bio_logs where id = rid;
    raise exception 'deleting an upload should have been refused';
  exception when insufficient_privilege then null;
  end;

  -- 5. an upload cannot be saved already cleared
  begin
    insert into public.dtr_bio_logs (employee_id, payroll_start, payroll_end, cleared_at)
    values ('TEST-BIO', '2026-09-13', '2026-09-27', now());
    raise exception 'saving an already-cleared upload should have been refused';
  exception when insufficient_privilege then null;
  end;

  -- 6. a period that ends before it starts is refused
  begin
    insert into public.dtr_bio_logs (employee_id, payroll_start, payroll_end)
    values ('TEST-BIO', '2026-09-27', '2026-09-13');
    raise exception 'a backwards period should have been refused';
  exception when check_violation then null;
  end;

  raise notice 'dtr_bio_logs verification passed';
end
$$;

rollback;
