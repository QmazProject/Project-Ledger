-- Balance Work (stored as `scope`) is optional on every target.
--
-- It was required on newly created targets, enforced both in the modal and here
-- with `raise exception 'Scope is required for a new target.'`. The business
-- has asked for it to be the author's choice, so the rule is dropped in both
-- places. Removing it only in the frontend would leave a modal that offers to
-- save a target the database then refuses.
--
-- The column has always been nullable — targets created by the original
-- backfill have no scope — so no column change is needed and no existing row is
-- affected. This migration only relaxes the function.
--
-- The signature is unchanged from 20260901000000_target_remarks.sql, so CREATE
-- OR REPLACE genuinely replaces rather than overloading, and existing grants are
-- retained.

create or replace function public.create_project_target(
  p_project_id        text,
  p_scope             text,
  p_target_qty        numeric default null,
  p_unit              text    default null,
  p_start_date        date    default null,
  p_target_completion date    default null,
  p_actual_completion date    default null,
  p_actual_output     numeric default null,
  p_batch_id          uuid    default null,
  p_remarks           text    default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_username   text;
  v_batch      uuid := coalesce(p_batch_id, gen_random_uuid());
  v_scope      text := nullif(btrim(coalesce(p_scope, '')), '');
  v_unit       text := nullif(btrim(coalesce(p_unit, '')), '');
  v_remarks    text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_audit_id   text;
  v_now        timestamptz := now();
  v_completion date;
  v_id         uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to add a target.';
  end if;
  if nullif(btrim(coalesce(p_project_id, '')), '') is null then
    raise exception 'A target must belong to a project.';
  end if;

  -- No scope check. A target with no Balance Work is a target whose author has
  -- not described it yet, which is now a legitimate state rather than an error.

  -- p_actual_completion is intentionally ignored. Completion exists only when
  -- this same save supplies an Actual output that reaches the target.
  if p_target_qty is not null
     and p_actual_output is not null
     and p_actual_output >= p_target_qty then
    v_completion := timezone('Asia/Manila', v_now)::date;
  end if;

  if v_completion is not null
     and p_start_date is not null
     and v_completion < p_start_date then
    raise exception 'Start date cannot be after the automatic completion date.';
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;
  v_username := coalesce(v_username, 'Unknown user');
  v_audit_id := public.project_audit_id(p_project_id);

  insert into public.project_targets (
    project_id, project_key, scope, target_qty, unit,
    start_date, target_completion, actual_completion, actual_output, remarks,
    created_by, created_at, updated_by, updated_at
  ) values (
    p_project_id, public.project_key(p_project_id), v_scope, p_target_qty, v_unit,
    p_start_date, p_target_completion, v_completion, p_actual_output, v_remarks,
    v_uid, v_now, v_uid, v_now
  )
  returning id into v_id;

  -- The creation event. Its new_value carries the scope when there is one; the
  -- history reads this row for its `action` and not its value, so a target
  -- created without a Balance Work still records that it was created.
  insert into public.project_manual_update_audit (
    project_id, target_id, target_scope, column_name, field_key,
    old_value, new_value, action, source, batch_id, changed_by, changed_by_username,
    changed_at
  ) values (
    v_audit_id, v_id, v_scope, 'Target', 'target',
    null, v_scope, 'create', 'target_modal', v_batch, v_uid, v_username, v_now
  );

  -- Actual completion has no separate audit field. The Actual output entry and
  -- its changed_at timestamp are the evidence for v_completion.
  insert into public.project_manual_update_audit (
    project_id, target_id, target_scope, column_name, field_key,
    old_value, new_value, action, source, batch_id, changed_by, changed_by_username,
    changed_at
  )
  select v_audit_id, v_id, v_scope, f.label, f.field_key,
         null, f.new_value, 'create', 'target_modal', v_batch, v_uid, v_username,
         v_now
  from (values
    ('scope',             'Scope',             v_scope),
    ('target_qty',        'Target qty',        p_target_qty::text),
    ('unit',              'Unit',              v_unit),
    ('start_date',        'Start date',        p_start_date::text),
    ('target_completion', 'Target completion', p_target_completion::text),
    ('actual_output',     'Actual output',     p_actual_output::text),
    ('remarks',           'Target remarks',    v_remarks)
  ) as f(field_key, label, new_value)
  where f.new_value is not null;

  return v_id;
end;
$$;

comment on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid, text) is
  'Creates a target and its audit rows atomically. Balance Work (scope) is optional. Actual completion is generated from the first supplied Actual output that reaches Target qty; p_actual_completion is retained only for API compatibility and is ignored. p_remarks is the per-target remark, audited as ''Target remarks'' so it never mixes with the project-level Remarks trail.';
