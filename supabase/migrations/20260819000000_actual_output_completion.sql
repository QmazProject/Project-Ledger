-- Actual completion is now system evidence, not an editable target field.
--
-- The column remains on project_targets because target standing still needs the
-- calendar date on which delivery was first recorded. The two public RPCs keep
-- their existing signatures so the migration and the frontend can be deployed
-- in either order. p_actual_completion is retained only for that compatibility;
-- both functions deliberately ignore its value.

-- ---------------------------------------------------------------------------
-- Preserve legacy manual dates in the Actual output audit trail
-- ---------------------------------------------------------------------------
-- Prefer the actor, timestamp and batch from the original Actual completion
-- audit row. When older data has no such row, use the target's last editor and
-- midnight on the preserved date in the application's Manila timezone. The
-- date-level NOT EXISTS makes this safe to run again and avoids duplicating an
-- Actual output event that already provides the requested evidence.
with completion_evidence as (
  select
    t.id as target_id,
    t.project_id,
    t.scope,
    t.actual_completion,
    t.actual_output,
    t.updated_by,
    completion_audit.id as completion_audit_id,
    completion_audit.action as completion_action,
    completion_audit.source as completion_source,
    completion_audit.batch_id as completion_batch_id,
    completion_audit.changed_by as completion_changed_by,
    completion_audit.changed_by_username as completion_username,
    completion_audit.changed_at as completion_changed_at
  from public.project_targets t
  left join lateral (
    select a.*
    from public.project_manual_update_audit a
    where a.target_id = t.id
      and (a.field_key = 'actual_completion' or a.column_name = 'Actual completion')
      and a.new_value = t.actual_completion::text
    order by a.changed_at desc, a.id desc
    limit 1
  ) completion_audit on true
  where t.actual_completion is not null
), missing_output_evidence as (
  select e.*
  from completion_evidence e
  where not exists (
    select 1
    from public.project_manual_update_audit output_audit
    where output_audit.target_id = e.target_id
      and (output_audit.field_key = 'actual_output' or output_audit.column_name = 'Actual output')
      and timezone('Asia/Manila', output_audit.changed_at)::date = e.actual_completion
  )
)
insert into public.project_manual_update_audit (
  project_id, target_id, target_scope, column_name, field_key,
  old_value, new_value, action, source, batch_id,
  changed_by, changed_by_username, changed_at
)
select
  public.project_audit_id(e.project_id),
  e.target_id,
  e.scope,
  'Actual output',
  'actual_output',
  null,
  e.actual_output::text,
  coalesce(e.completion_action, 'update'),
  case
    when e.completion_audit_id is not null then coalesce(e.completion_source, 'panel')
    else 'completion_backfill'
  end,
  case
    when e.completion_audit_id is not null then e.completion_batch_id
    else gen_random_uuid()
  end,
  coalesce(e.completion_changed_by, e.updated_by),
  coalesce(e.completion_username, p.username, 'Unknown user'),
  coalesce(
    e.completion_changed_at,
    e.actual_completion::timestamp at time zone 'Asia/Manila'
  )
from missing_output_evidence e
left join public.profiles p on p.id = e.updated_by;

-- ---------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------
create or replace function public.create_project_target(
  p_project_id        text,
  p_scope             text,
  p_target_qty        numeric default null,
  p_unit              text    default null,
  p_start_date        date    default null,
  p_target_completion date    default null,
  p_actual_completion date    default null,
  p_actual_output     numeric default null,
  p_batch_id          uuid    default null
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
    start_date, target_completion, actual_completion, actual_output,
    created_by, created_at, updated_by, updated_at
  ) values (
    p_project_id, public.project_key(p_project_id), v_scope, p_target_qty, v_unit,
    p_start_date, p_target_completion, v_completion, p_actual_output,
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
    ('actual_output',     'Actual output',     p_actual_output::text)
  ) as f(field_key, label, new_value)
  where f.new_value is not null;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Update
-- ---------------------------------------------------------------------------
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
  p_batch_id          uuid    default null
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
       v_output_changed)
  ) as f(field_key, label, old_value, new_value, changed)
  where f.changed;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

-- CREATE OR REPLACE retains existing grants, but restating the boundary keeps
-- this migration safe if it is applied to a database with altered privileges.
revoke all on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid) from public, anon;
revoke all on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid) from public, anon;

grant execute on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid) to authenticated;
grant execute on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid) to authenticated;

comment on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid) is
  'Creates a target and its audit rows atomically. Actual completion is generated from the first supplied Actual output that reaches Target qty; p_actual_completion is retained only for API compatibility and is ignored.';
comment on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid) is
  'Updates editable target fields and audits their database-computed diff atomically. Actual completion is generated once from a changed Actual output that reaches Target qty, then permanently retained; p_actual_completion is ignored.';
