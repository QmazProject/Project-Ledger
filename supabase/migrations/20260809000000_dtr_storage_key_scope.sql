-- Narrows what the public anon key can do to the DTR table.
--
-- Read this before assuming it does more than it does. The DTR sign-in is a passcode
-- checked in the browser, not a Supabase session, so every request arrives as `anon` with
-- no identity attached. RLS can only test what the request carries, which means it cannot
-- tell employee 1001 apart from employee 1002 here. Per-employee isolation at the database
-- level needs real auth (auth.uid()), and until that exists anyone holding the anon key --
-- which ships in the browser bundle -- can still read and write any DTR row directly.
--
-- What this migration does buy:
--   * the table can no longer be used as free storage for arbitrary keys
--   * rows cannot be deleted by anon at all
--   * the payload must be a JSON object, so a row cannot be replaced with a scalar
-- The passcode work is what protects one employee from another *in the app*; this keeps
-- the table itself from being a general-purpose dumping ground.

alter table public.dtr_storage_dtr enable row level security;

-- 'dtr:roster', 'dtr:cfg', or 'dtr:log:<employee id>:<year>'. The employee-id segment is
-- left unconstrained on purpose: IDs are free text in Settings, and a stricter pattern
-- would reject rows that already exist.
create or replace function public.dtr_storage_key_ok(key text)
returns boolean
language sql
immutable
as $$
  select key ~ '^dtr:(roster|cfg)$' or key ~ '^dtr:log:.+:[0-9]{4}$';
$$;

drop policy if exists "DTR data can be read publicly" on public.dtr_storage_dtr;
create policy "DTR data can be read publicly"
  on public.dtr_storage_dtr for select
  to anon, authenticated
  using (public.dtr_storage_key_ok(storage_key));

drop policy if exists "DTR data can be created publicly" on public.dtr_storage_dtr;
create policy "DTR data can be created publicly"
  on public.dtr_storage_dtr for insert
  to anon, authenticated
  with check (public.dtr_storage_key_ok(storage_key) and jsonb_typeof(payload) = 'object');

drop policy if exists "DTR data can be updated publicly" on public.dtr_storage_dtr;
create policy "DTR data can be updated publicly"
  on public.dtr_storage_dtr for update
  to anon, authenticated
  using (public.dtr_storage_key_ok(storage_key))
  with check (public.dtr_storage_key_ok(storage_key) and jsonb_typeof(payload) = 'object');

-- no delete policy, and no delete grant: a DTR row is corrected, never dropped
revoke delete on public.dtr_storage_dtr from anon, authenticated;
grant select, insert, update on public.dtr_storage_dtr to anon, authenticated;
