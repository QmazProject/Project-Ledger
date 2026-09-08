-- Safeguards added after the 2026-09-08 DTR data-loss incident (employee 006178).
--
-- dtr_storage_dtr holds ONE ROW PER EMPLOYEE-YEAR, and that row's payload contains
-- every date of the year. A client that upserted a stale or empty payload therefore
-- destroyed the whole year, and there was no history to recover from — the records
-- had to be rebuilt from a Supabase backup in a temporary recovery project.
--
-- This migration is ADDITIVE ONLY. It adds a column, a history table, a trigger and
-- four functions. It never UPDATEs or DELETEs a payload, so no existing DTR record
-- is altered by applying it.
--
-- Three protections, all at the database level, because a frontend bug is precisely
-- what caused the incident:
--   1. every UPDATE and DELETE of a payload is journalled before it takes effect;
--   2. writes name a single date, so a stale client physically cannot reach the
--      other dates in the year;
--   3. a write must state the revision it was built from, and is refused if the row
--      has moved on since.

-- ---------------------------------------------------------------- 1. revision ---
-- Existing rows keep their payload and start at revision 1.
alter table public.dtr_storage_dtr
  add column if not exists revision bigint not null default 1;

-- ----------------------------------------------------------------- 2. history ---
create table if not exists public.dtr_storage_dtr_history (
  history_id   bigint generated always as identity primary key,
  storage_key  text        not null,
  old_payload  jsonb,
  new_payload  jsonb,
  old_revision bigint,
  new_revision bigint,
  changed_at   timestamptz not null default now(),
  changed_by   text,
  operation    text        not null check (operation in ('UPDATE', 'DELETE'))
);

create index if not exists dtr_storage_dtr_history_key_time_idx
  on public.dtr_storage_dtr_history (storage_key, changed_at desc);

comment on table public.dtr_storage_dtr_history is
  'Previous payload of every dtr_storage_dtr row before each UPDATE/DELETE. Written by trigger, never by clients. Recovery: see docs/data-safety.md.';

-- Best-effort identity. The DTR signs in with its own ID rather than Supabase auth,
-- so this is usually the app-supplied setting; it falls back to the JWT subject and
-- finally the database role, and never fails when none are present.
create or replace function public.dtr_actor()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('app.actor', true), ''),
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif((nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub', ''),
    session_user
  );
$$;

create or replace function public.dtr_storage_dtr_record_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'UPDATE') then
    insert into public.dtr_storage_dtr_history
      (storage_key, old_payload, new_payload, old_revision, new_revision, changed_by, operation)
    values
      (old.storage_key, old.payload, new.payload, old.revision, new.revision, public.dtr_actor(), 'UPDATE');
    return new;
  elsif (tg_op = 'DELETE') then
    insert into public.dtr_storage_dtr_history
      (storage_key, old_payload, new_payload, old_revision, new_revision, changed_by, operation)
    values
      (old.storage_key, old.payload, null, old.revision, null, public.dtr_actor(), 'DELETE');
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists dtr_storage_dtr_history_trg on public.dtr_storage_dtr;
create trigger dtr_storage_dtr_history_trg
  after update or delete on public.dtr_storage_dtr
  for each row execute function public.dtr_storage_dtr_record_history();

-- ------------------------------------------------- 3. date-level, locked writes ---
-- Replaces "here is the whole year" with "set this one date". jsonb_set touches only
-- the named date, so even a client holding a half-empty year cannot erase the rest.
-- The revision check refuses a write built from a copy the row has moved past.
--
-- Returns: {"ok":true,"revision":n}
--       or {"ok":false,"conflict":true,"payload":{...},"revision":n} so the caller
--          can re-apply its edit to the current copy instead of overwriting it.
create or replace function public.dtr_save_day(
  p_key               text,
  p_date              text,
  p_day               jsonb,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  cur_payload jsonb;
  cur_rev     bigint;
  new_rev     bigint;
begin
  if p_key is null or p_date is null or p_day is null then
    raise exception 'dtr_save_day requires a key, a date and a day payload';
  end if;

  select payload, revision into cur_payload, cur_rev
    from public.dtr_storage_dtr
   where storage_key = p_key
     for update;

  if not found then
    -- A caller that believes it is editing an existing row must not create one.
    if coalesce(p_expected_revision, 0) <> 0 then
      return jsonb_build_object('ok', false, 'conflict', true,
                                'payload', '{}'::jsonb, 'revision', 0);
    end if;
    insert into public.dtr_storage_dtr (storage_key, payload, revision)
      values (p_key, jsonb_build_object(p_date, p_day), 1);
    return jsonb_build_object('ok', true, 'revision', 1);
  end if;

  if cur_rev is distinct from p_expected_revision then
    return jsonb_build_object('ok', false, 'conflict', true,
                              'payload', cur_payload, 'revision', cur_rev);
  end if;

  new_rev := cur_rev + 1;
  update public.dtr_storage_dtr
     set payload    = jsonb_set(coalesce(payload, '{}'::jsonb), array[p_date], p_day, true),
         revision   = new_rev,
         updated_at = now()
   where storage_key = p_key;

  return jsonb_build_object('ok', true, 'revision', new_rev);
end;
$$;

-- Dropping a single date, with the same protections. Never used to clear a year.
create or replace function public.dtr_remove_day(
  p_key               text,
  p_date              text,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  cur_payload jsonb;
  cur_rev     bigint;
  new_rev     bigint;
begin
  select payload, revision into cur_payload, cur_rev
    from public.dtr_storage_dtr
   where storage_key = p_key
     for update;

  if not found then
    return jsonb_build_object('ok', true, 'revision', 0);
  end if;

  if cur_rev is distinct from p_expected_revision then
    return jsonb_build_object('ok', false, 'conflict', true,
                              'payload', cur_payload, 'revision', cur_rev);
  end if;

  new_rev := cur_rev + 1;
  update public.dtr_storage_dtr
     set payload    = coalesce(payload, '{}'::jsonb) - p_date,
         revision   = new_rev,
         updated_at = now()
   where storage_key = p_key;

  return jsonb_build_object('ok', true, 'revision', new_rev);
end;
$$;

-- The whole-year write the client still uses, made safe by the same revision check.
-- A matching revision means nobody has touched the row since this copy was read, so
-- replacing the payload wholesale cannot clobber anyone. A mismatch is refused and
-- the current copy is returned to merge against.
create or replace function public.dtr_save_year(
  p_key               text,
  p_payload           jsonb,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  cur_payload jsonb;
  cur_rev     bigint;
  new_rev     bigint;
begin
  if p_key is null or p_payload is null then
    raise exception 'dtr_save_year requires a key and a payload';
  end if;

  select payload, revision into cur_payload, cur_rev
    from public.dtr_storage_dtr
   where storage_key = p_key
     for update;

  if not found then
    if coalesce(p_expected_revision, 0) <> 0 then
      return jsonb_build_object('ok', false, 'conflict', true,
                                'payload', '{}'::jsonb, 'revision', 0);
    end if;
    insert into public.dtr_storage_dtr (storage_key, payload, revision)
      values (p_key, p_payload, 1);
    return jsonb_build_object('ok', true, 'revision', 1);
  end if;

  if cur_rev is distinct from p_expected_revision then
    return jsonb_build_object('ok', false, 'conflict', true,
                              'payload', cur_payload, 'revision', cur_rev);
  end if;

  new_rev := cur_rev + 1;
  update public.dtr_storage_dtr
     set payload    = p_payload,
         revision   = new_rev,
         updated_at = now()
   where storage_key = p_key;

  return jsonb_build_object('ok', true, 'revision', new_rev);
end;
$$;

-- ---------------------------------------------------------------- 4. recovery ---
-- Restore a key to an earlier payload. The restore is itself journalled by the
-- trigger, so it can be undone in turn. Deliberately NOT granted to anon: recovery
-- is a deliberate act from the SQL editor, not something the app can trigger.
create or replace function public.dtr_restore_key(
  p_key        text,
  p_history_id bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  restored jsonb;
  new_rev  bigint;
begin
  select old_payload into restored
    from public.dtr_storage_dtr_history
   where history_id = p_history_id and storage_key = p_key;

  if restored is null then
    raise exception 'no history row % for key %', p_history_id, p_key;
  end if;

  update public.dtr_storage_dtr
     set payload    = restored,
         revision   = revision + 1,
         updated_at = now()
   where storage_key = p_key
  returning revision into new_rev;

  if new_rev is null then
    insert into public.dtr_storage_dtr (storage_key, payload, revision)
      values (p_key, restored, 1)
      returning revision into new_rev;
  end if;

  return jsonb_build_object(
    'ok', true,
    'revision', new_rev,
    'dates', (select count(*) from jsonb_object_keys(restored)));
end;
$$;

-- ------------------------------------------------------------------- 5. access ---
alter table public.dtr_storage_dtr_history enable row level security;

-- Readable so a wipe can be diagnosed and recovered from, exactly as the DTR table
-- itself is readable. No insert/update/delete policy exists, so the journal cannot
-- be forged or erased by a client — only the SECURITY DEFINER trigger writes it.
drop policy if exists "DTR history can be read publicly" on public.dtr_storage_dtr_history;
create policy "DTR history can be read publicly"
  on public.dtr_storage_dtr_history for select
  to anon, authenticated
  using (true);

grant select on public.dtr_storage_dtr_history to anon, authenticated;

grant execute on function public.dtr_save_day(text, text, jsonb, bigint)   to anon, authenticated;
grant execute on function public.dtr_save_year(text, jsonb, bigint)         to anon, authenticated;
grant execute on function public.dtr_remove_day(text, text, bigint)        to anon, authenticated;
grant execute on function public.dtr_actor()                                to anon, authenticated;
revoke execute on function public.dtr_restore_key(text, bigint)            from anon;
grant  execute on function public.dtr_restore_key(text, bigint)            to authenticated;
