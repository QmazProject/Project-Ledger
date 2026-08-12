-- Verification for 20260819000000_actual_output_completion.sql.
-- Run after applying the migration in the Supabase SQL editor. Every test rolls
-- itself back. A PASS notice is success; any raised FAIL message needs review.

-- 1. The migration leaves no legacy completion date without Actual output
--    audit evidence on the same Manila calendar date.
do $$
declare
  v_missing integer;
begin
  select count(*) into v_missing
  from public.project_targets t
  where t.actual_completion is not null
    and not exists (
      select 1
      from public.project_manual_update_audit a
      where a.target_id = t.id
        and (a.field_key = 'actual_output' or a.column_name = 'Actual output')
        and timezone('Asia/Manila', a.changed_at)::date = t.actual_completion
    );

  if v_missing <> 0 then
    raise exception '1 FAIL - % completed target(s) have no same-date Actual output audit evidence', v_missing;
  end if;
  raise notice '1 PASS - every preserved completion date has Actual output audit evidence';
end
$$;

-- 2. A create that reaches its target gets today's Manila date, ignores the
--    caller's manual date, and writes no Actual completion audit field.
do $$
declare
  v_uid        uuid;
  v_id         uuid;
  v_completion date;
  v_output     integer;
  v_manual     integer;
begin
  select id into v_uid from auth.users limit 1;
  if v_uid is null then raise notice '2 SKIPPED - no auth user'; return; end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_id := public.create_project_target(
    'VERIFY-AUTO-COMPLETION-2', 'Automatic completion', 100, 'units',
    null, current_date + 10, date '2001-01-01', 100, null);

  select actual_completion into v_completion
  from public.project_targets where id = v_id;

  select count(*) filter (where field_key = 'actual_output'),
         count(*) filter (where field_key = 'actual_completion')
    into v_output, v_manual
  from public.project_manual_update_audit where target_id = v_id;

  if v_completion is distinct from timezone('Asia/Manila', now())::date then
    raise exception '2 FAIL - completion was %, expected current Manila date', v_completion;
  end if;
  if v_output <> 1 or v_manual <> 0 then
    raise exception '2 FAIL - expected 1 Actual output and 0 Actual completion audit rows, found % and %', v_output, v_manual;
  end if;

  raise notice '2 PASS - qualifying create sets automatic completion and audits Actual output only';
  raise exception 'rollback_2';
exception
  when others then
    if sqlerrm = 'rollback_2' then raise notice '2 rolled back'; else raise; end if;
end
$$;

-- 3. Updating Actual output below target does not complete; first reaching the
--    target completes; later output reductions and manual dates cannot alter it.
do $$
declare
  v_uid         uuid;
  v_id          uuid;
  v_completion  date;
  v_preserved   date;
begin
  select id into v_uid from auth.users limit 1;
  if v_uid is null then raise notice '3 SKIPPED - no auth user'; return; end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_id := public.create_project_target(
    'VERIFY-AUTO-COMPLETION-3', 'First qualifying output', 100, 'units',
    null, current_date + 10, date '2001-01-01', 20, null);

  select actual_completion into v_completion from public.project_targets where id = v_id;
  if v_completion is not null then
    raise exception '3 FAIL - below-target output incorrectly completed the target';
  end if;

  perform public.update_project_target(
    v_id, 'VERIFY-AUTO-COMPLETION-3', 'First qualifying output', 100, 'units',
    null, current_date + 10, date '2002-02-02', 100, null);

  select actual_completion into v_preserved from public.project_targets where id = v_id;
  if v_preserved is distinct from timezone('Asia/Manila', now())::date then
    raise exception '3 FAIL - first qualifying output did not set completion';
  end if;

  perform public.update_project_target(
    v_id, 'VERIFY-AUTO-COMPLETION-3', 'First qualifying output', 100, 'units',
    null, current_date + 10, date '2003-03-03', 25, null);

  select actual_completion into v_completion from public.project_targets where id = v_id;
  if v_completion is distinct from v_preserved then
    raise exception '3 FAIL - completion changed from % to % after output dropped', v_preserved, v_completion;
  end if;

  if exists (
    select 1 from public.project_manual_update_audit
    where target_id = v_id and field_key = 'actual_completion'
  ) then
    raise exception '3 FAIL - the new flow wrote an editable Actual completion audit field';
  end if;

  raise notice '3 PASS - completion is set once, ignores manual dates, and survives a later output reduction';
  raise exception 'rollback_3';
exception
  when others then
    if sqlerrm = 'rollback_3' then raise notice '3 rolled back'; else raise; end if;
end
$$;

-- 4. Supplying only a different p_actual_completion is a true no-op.
do $$
declare
  v_uid     uuid;
  v_id      uuid;
  v_changed integer;
begin
  select id into v_uid from auth.users limit 1;
  if v_uid is null then raise notice '4 SKIPPED - no auth user'; return; end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_id := public.create_project_target(
    'VERIFY-AUTO-COMPLETION-4', 'Ignored parameter', 100, 'units',
    null, current_date + 10, null, 10, null);

  v_changed := public.update_project_target(
    v_id, 'VERIFY-AUTO-COMPLETION-4', 'Ignored parameter', 100, 'units',
    null, current_date + 10, date '1999-12-31', 10, null);

  if v_changed <> 0 then
    raise exception '4 FAIL - ignored completion parameter reported % changed field(s)', v_changed;
  end if;
  if (select actual_completion from public.project_targets where id = v_id) is not null then
    raise exception '4 FAIL - ignored completion parameter changed stored data';
  end if;

  raise notice '4 PASS - manual completion parameter is ignored as a no-op';
  raise exception 'rollback_4';
exception
  when others then
    if sqlerrm = 'rollback_4' then raise notice '4 rolled back'; else raise; end if;
end
$$;
