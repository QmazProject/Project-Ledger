-- Verification for 20260908000000_dtr_storage_safety.sql
--
-- Proves the safeguards added after the 2026-09-08 data-loss incident actually
-- behave as claimed. Every assertion raises on failure, so the script either runs
-- clean or stops with the reason.
--
-- SAFE TO RUN: it only ever touches keys prefixed 'dtr:log:TEST-', which no real
-- employee can own (real keys are 'dtr:log:<numeric id>:<year>'), and it removes
-- them at the end. It never reads, writes or deletes a production DTR record.

do $$
declare
  k        text := 'dtr:log:TEST-006178:2026';
  k2       text := 'dtr:log:TEST-005582:2026';
  seed     jsonb := '{"2026-09-07":{"amIn":"07:55","amOut":"12:00","pmIn":"13:00","pmOut":"17:05"},
                      "2026-09-08":{"amIn":"07:58","amOut":"12:01"},
                      "2026-09-09":{"amIn":"08:02"}}'::jsonb;
  res      jsonb;
  cur      jsonb;
  rev      bigint;
  hid      bigint;
  n        int;
begin
  -- clean slate for the test keys only
  delete from public.dtr_storage_dtr_history where storage_key in (k, k2);
  delete from public.dtr_storage_dtr where storage_key in (k, k2);

  insert into public.dtr_storage_dtr (storage_key, payload, revision) values (k, seed, 1);
  insert into public.dtr_storage_dtr (storage_key, payload, revision) values (k2, seed, 1);
  delete from public.dtr_storage_dtr_history where storage_key in (k, k2); -- ignore the seed inserts

  ---------------------------------------------------------------- 1. date-level
  res := public.dtr_save_day(k, '2026-09-07', '{"amIn":"07:55","otIn":"18:00"}'::jsonb, 1);
  if (res->>'ok')::boolean is not true then
    raise exception 'save_day should have succeeded at the current revision: %', res;
  end if;

  select payload, revision into cur, rev from public.dtr_storage_dtr where storage_key = k;
  if cur->'2026-09-08' is null or cur->'2026-09-09' is null then
    raise exception 'save_day destroyed sibling dates — this is the incident: %', cur;
  end if;
  if cur#>>'{2026-09-07,otIn}' <> '18:00' then
    raise exception 'save_day did not apply the edit: %', cur;
  end if;
  if rev <> 2 then raise exception 'revision should have advanced to 2, got %', rev; end if;
  raise notice 'PASS  1. dtr_save_day writes one date and leaves the rest of the year intact';

  ---------------------------------------------------------- 2. optimistic locking
  -- a client still holding revision 1 must be refused, and handed the current copy
  res := public.dtr_save_day(k, '2026-09-08', '{"amIn":"09:99"}'::jsonb, 1);
  if (res->>'ok')::boolean is not false or (res->>'conflict')::boolean is not true then
    raise exception 'a stale revision must be refused: %', res;
  end if;
  if (res->'payload')->'2026-09-07' is null then
    raise exception 'a conflict must return the current payload to merge against: %', res;
  end if;
  if (res->>'revision')::bigint <> 2 then
    raise exception 'a conflict must return the current revision: %', res;
  end if;
  select payload into cur from public.dtr_storage_dtr where storage_key = k;
  if cur#>>'{2026-09-08,amIn}' <> '07:58' then
    raise exception 'the refused write must not have landed: %', cur;
  end if;
  raise notice 'PASS  2. a write built from a stale revision is refused, not applied';

  ------------------------------------------------------- 3. no accidental creation
  res := public.dtr_save_day('dtr:log:TEST-nonexistent:2026', '2026-09-07', '{"amIn":"08:00"}'::jsonb, 7);
  if (res->>'conflict')::boolean is not true then
    raise exception 'editing a row that is not there must conflict, not create: %', res;
  end if;
  raise notice 'PASS  3. a caller that thinks it is editing an existing row cannot create one';

  ------------------------------------------------------------ 4. cross-key safety
  select payload into cur from public.dtr_storage_dtr where storage_key = k2;
  if cur <> seed then
    raise exception 'writing one employee changed another: %', cur;
  end if;
  raise notice 'PASS  4. writing one employee-year never touches another';

  ------------------------------------------------------------------- 5. history
  select count(*) into n from public.dtr_storage_dtr_history where storage_key = k;
  if n < 1 then raise exception 'the UPDATE was not journalled'; end if;

  select history_id into hid from public.dtr_storage_dtr_history
   where storage_key = k and operation = 'UPDATE' order by changed_at asc limit 1;
  select old_payload into cur from public.dtr_storage_dtr_history where history_id = hid;
  if cur#>>'{2026-09-07,pmOut}' <> '17:05' then
    raise exception 'history did not capture the payload as it was BEFORE the change: %', cur;
  end if;
  if (select changed_by from public.dtr_storage_dtr_history where history_id = hid) is null then
    raise exception 'history did not record who changed it';
  end if;
  raise notice 'PASS  5. every UPDATE journals the previous payload, with an actor';

  --------------------------------------------- 6. the incident, and recovery from it
  -- simulate the old client: upsert an (almost) empty year straight over the top
  update public.dtr_storage_dtr set payload = '{"2026-09-07":{}}'::jsonb where storage_key = k;
  select payload into cur from public.dtr_storage_dtr where storage_key = k;
  if cur->'2026-09-08' is not null then raise exception 'the wipe did not simulate'; end if;

  -- ...and recover, which is what previously needed a whole backup project
  select history_id into hid from public.dtr_storage_dtr_history
   where storage_key = k and operation = 'UPDATE'
     and (select count(*) from jsonb_object_keys(old_payload)) = 3
   order by changed_at desc limit 1;
  if hid is null then raise exception 'no history row holds the pre-wipe payload'; end if;

  res := public.dtr_restore_key(k, hid);
  select payload into cur from public.dtr_storage_dtr where storage_key = k;
  if cur->'2026-09-08' is null or cur->'2026-09-09' is null then
    raise exception 'restore did not bring the year back: %', cur;
  end if;
  raise notice 'PASS  6. a wipe is journalled and recoverable with one call (% dates back)', res->>'dates';

  --------------------------------------------------------------- 7. DELETE journal
  delete from public.dtr_storage_dtr where storage_key = k2;
  select count(*) into n from public.dtr_storage_dtr_history
   where storage_key = k2 and operation = 'DELETE'
     and (select count(*) from jsonb_object_keys(old_payload)) = 3;
  if n <> 1 then raise exception 'a DELETE must journal the payload it removed'; end if;
  raise notice 'PASS  7. DELETE journals the payload it removed';

  -------------------------------------------------------------- 8. remove_day only
  select revision into rev from public.dtr_storage_dtr where storage_key = k;
  res := public.dtr_remove_day(k, '2026-09-09', rev);
  select payload into cur from public.dtr_storage_dtr where storage_key = k;
  if cur->'2026-09-09' is not null then raise exception 'remove_day did not remove the date'; end if;
  if cur->'2026-09-07' is null or cur->'2026-09-08' is null then
    raise exception 'remove_day took other dates with it: %', cur;
  end if;
  raise notice 'PASS  8. dtr_remove_day drops one date and only that date';

  ------------------------------------------------- 9. revision-checked year write
  select revision into rev from public.dtr_storage_dtr where storage_key = k;
  res := public.dtr_save_year(k, '{"2026-09-07":{"amIn":"06:30"}}'::jsonb, rev - 1);
  if (res->>'conflict')::boolean is not true then
    raise exception 'a whole-year write from a stale revision must be refused: %', res;
  end if;
  select payload into cur from public.dtr_storage_dtr where storage_key = k;
  if cur->'2026-09-08' is null then
    raise exception 'the refused whole-year write clobbered the row anyway: %', cur;
  end if;
  res := public.dtr_save_year(k, cur || '{"2026-09-10":{"amIn":"07:45"}}'::jsonb, rev);
  if (res->>'ok')::boolean is not true then
    raise exception 'a whole-year write at the current revision must succeed: %', res;
  end if;
  raise notice 'PASS  9. whole-year writes are refused from a stale revision, accepted at the current one';

  -- tidy up the test keys
  delete from public.dtr_storage_dtr where storage_key in (k, k2);
  delete from public.dtr_storage_dtr_history where storage_key in (k, k2);

  raise notice '--- all safeguards verified ---';
end $$;
