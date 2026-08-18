-- Per-target Remarks.
--
-- Each target carries its own remark, edited in the Manage Targets modal. This
-- is NOT the project's Remarks column: that one stays on project_manual_updates
-- and is the project's final remark. The two are separate fields and neither is
-- derived from the other.
--
-- The audit label is deliberately 'Target remarks' and not 'Remarks'.
-- AuditModal reads a cell's history with
--     .eq("column_name", AUDIT_FIELD_LABELS[field])
-- and applies a target_id filter ONLY when the cell belongs to a target. The
-- project's Remarks cell has no target, so it queries column_name = 'Remarks'
-- across the whole project. Storing target remarks under that same label would
-- pour every target's remark history into the project's final-Remarks trail.
-- This mirrors the existing split where scope displays as "Balance Work" but is
-- stored as 'Scope' — see SCOPE_LABEL in src/lib/targets.js.

alter table public.project_targets
  add column if not exists remarks text;

comment on column public.project_targets.remarks is
  'Per-target remark, edited in the Manage Targets modal. Separate from the project-level final Remarks on project_manual_updates. Audited under column_name = ''Target remarks''.';

-- ---------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: adding a parameter produces a second overload
-- instead of replacing the function, which would leave the old signature live
-- and silently discarding remarks.
drop function if exists public.create_project_target(
  text, text, numeric, text, date, date, date, numeric, uuid
);

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
  if v_scope is null then
    raise exception 'Scope is required for a new target.';
  end if;

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

-- ---------------------------------------------------------------------------
-- Update
-- ---------------------------------------------------------------------------
drop function if exists public.update_project_target(
  uuid, text, text, numeric, text, date, date, date, numeric, uuid
);

create or replace function public.update_project_target(
  p_target_id         uuid,
  p_project_id        text,
  p_scope             text    default null,
  p_target_qty        numeric default null,
  p_unit              text    default null,
  p_start_date        date    default null,
  p_target_completion date    default null,
  p_actual_completion date    default null,
  p_actual_output     numeric default null,
  p_batch_id          uuid    default null,
  p_remarks           text    default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid            uuid := auth.uid();
  v_username       text;
  v_batch          uuid := coalesce(p_batch_id, gen_random_uuid());
  v_scope          text := nullif(btrim(coalesce(p_scope, '')), '');
  v_unit           text := nullif(btrim(coalesce(p_unit, '')), '');
  v_remarks        text := nullif(btrim(coalesce(p_remarks, '')), '');
  v_row            public.project_targets%rowtype;
  v_audit_id       text;
  v_scope_for_audit text;
  v_now            timestamptz := now();
  v_completion     date;
  v_output_changed boolean;
  v_changed        integer := 0;
begin
  if v_uid is null then
    raise exception 'You must be signed in to edit a target.';
  end if;

  select * into v_row
  from public.project_targets
  where id = p_target_id
  for update;

  if not found then
    raise exception 'That target no longer exists. Reload and try again.';
  end if;
  if v_row.project_key is distinct from public.project_key(p_project_id) then
    raise exception 'That target belongs to a different project.';
  end if;
  if v_row.archived_at is not null then
    raise exception 'This target is archived. Restore it before editing.';
  end if;

  v_output_changed := v_row.actual_output is distinct from p_actual_output;
  v_completion := v_row.actual_completion;

  -- Once present, v_completion is never replaced or cleared. A new completion
  -- is created only by a changed, non-null Actual output in this save; changing
  -- Target qty by itself does not manufacture a delivery timestamp.
  if v_completion is null
     and v_output_changed
     and p_actual_output is not null
     and p_target_qty is not null
     and p_actual_output >= p_target_qty then
    v_completion := timezone('Asia/Manila', v_now)::date;
  end if;

  if v_completion is not null
     and p_start_date is not null
     and v_completion < p_start_date then
    raise exception 'Start date cannot be after the automatic completion date.';
  end if;

  -- p_actual_completion is deliberately absent from this comparison. A caller
  -- cannot turn a no-op into an edit by sending a manual completion date.
  if not (
       v_row.scope             is distinct from v_scope
    or v_row.target_qty        is distinct from p_target_qty
    or v_row.unit              is distinct from v_unit
    or v_row.start_date        is distinct from p_start_date
    or v_row.target_completion is distinct from p_target_completion
    or v_row.remarks           is distinct from v_remarks
    or v_output_changed
  ) then
    return 0;
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;
  v_username := coalesce(v_username, 'Unknown user');
  v_audit_id := public.project_audit_id(p_project_id);
  v_scope_for_audit := coalesce(v_scope, v_row.scope);

  update public.project_targets
  set scope             = v_scope,
      target_qty        = p_target_qty,
      unit              = v_unit,
      start_date        = p_start_date,
      target_completion = p_target_completion,
      actual_completion = v_completion,
      actual_output     = p_actual_output,
      remarks           = v_remarks,
      updated_by        = v_uid,
      updated_at        = v_now
  where id = p_target_id;

  insert into public.project_manual_update_audit (
    project_id, target_id, target_scope, column_name, field_key,
    old_value, new_value, action, source, batch_id, changed_by, changed_by_username,
    changed_at
  )
  select v_audit_id, p_target_id, v_scope_for_audit, f.label, f.field_key,
         f.old_value, f.new_value, 'update', 'target_modal', v_batch, v_uid, v_username,
         v_now
  from (values
    ('scope',             'Scope',             v_row.scope,                    v_scope,
       v_row.scope is distinct from v_scope),
    ('target_qty',        'Target qty',        v_row.target_qty::text,         p_target_qty::text,
       v_row.target_qty is distinct from p_target_qty),
    ('unit',              'Unit',              v_row.unit,                     v_unit,
       v_row.unit is distinct from v_unit),
    ('start_date',        'Start date',        v_row.start_date::text,         p_start_date::text,
       v_row.start_date is distinct from p_start_date),
    ('target_completion', 'Target completion', v_row.target_completion::text,  p_target_completion::text,
       v_row.target_completion is distinct from p_target_completion),
    ('actual_output',     'Actual output',     v_row.actual_output::text,      p_actual_output::text,
       v_output_changed),
    ('remarks',           'Target remarks',    v_row.remarks,                  v_remarks,
       v_row.remarks is distinct from v_remarks)
  ) as f(field_key, label, old_value, new_value, changed)
  where f.changed;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

-- The old signatures were dropped above, so these are new functions and carry
-- only default privileges. Restate the boundary explicitly rather than relying
-- on what CREATE OR REPLACE would have retained.
revoke all on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid, text) from public, anon;
revoke all on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid, text) from public, anon;

grant execute on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid, text) to authenticated;
grant execute on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid, text) to authenticated;

comment on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid, text) is
  'Creates a target and its audit rows atomically. Actual completion is generated from the first supplied Actual output that reaches Target qty; p_actual_completion is retained only for API compatibility and is ignored. p_remarks is the per-target remark, audited as ''Target remarks'' so it never mixes with the project-level Remarks trail.';
comment on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid, text) is
  'Updates editable target fields and audits their database-computed diff atomically. Actual completion is generated once from a changed Actual output that reaches Target qty, then permanently retained; p_actual_completion is ignored. p_remarks is the per-target remark, audited as ''Target remarks''.';
