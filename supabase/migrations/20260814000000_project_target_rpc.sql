-- Target writes and their audit rows in one transaction.
--
-- Until now the client wrote a target through one PostgREST request and its
-- audit rows through the next. Each request is its own transaction, so an audit
-- insert that failed left the target changed with no record of who changed it -
-- and the user saw an error for a save that had in fact happened. A function
-- runs its whole body in a single transaction, so the two either both land or
-- neither does.
--
-- Three functions rather than four: archive and restore are one state change in
-- opposite directions, and a single function with a boolean keeps the surface
-- smaller without making it generic. None of them accepts a column name or a
-- user id - the columns are fixed by the signature and the actor is read from
-- auth.uid() inside the database.

-- ---------------------------------------------------------------------------
-- Declarative invariants
-- ---------------------------------------------------------------------------
-- Added NOT VALID on purpose. These are the rules the modal already enforces,
-- but legacy rows migrated out of project_manual_updates were never checked
-- against them, and a VALIDATE pass that failed would take the whole migration
-- down. NOT VALID applies them to every insert and update from here on while
-- leaving existing rows alone. Section 12 of the verification script lists any
-- legacy row that would fail, so they can be corrected and the constraints
-- validated later.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'project_targets_qty_non_negative') then
    alter table public.project_targets
      add constraint project_targets_qty_non_negative
      check (target_qty is null or target_qty >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'project_targets_output_non_negative') then
    alter table public.project_targets
      add constraint project_targets_output_non_negative
      check (actual_output is null or actual_output >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'project_targets_completion_after_start') then
    alter table public.project_targets
      add constraint project_targets_completion_after_start
      check (start_date is null or target_completion is null or target_completion >= start_date) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'project_targets_actual_after_start') then
    alter table public.project_targets
      add constraint project_targets_actual_after_start
      check (start_date is null or actual_completion is null or actual_completion >= start_date) not valid;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Where a project's history is filed
-- ---------------------------------------------------------------------------
-- A project whose ID changed case or apostrophe form between workbook versions
-- has its manual row - and therefore its existing history - under the older
-- spelling. Resolving that here rather than accepting it as a parameter means
-- one project keeps one history, and the client cannot get it wrong.
create or replace function public.project_audit_id(p_project_id text)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select m.project_id
       from public.project_manual_updates m
      where public.project_key(m.project_id) = public.project_key(p_project_id)
      limit 1),
    p_project_id
  );
$$;

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
  v_uid       uuid := auth.uid();
  v_username  text;
  v_batch     uuid := coalesce(p_batch_id, gen_random_uuid());
  v_scope     text := nullif(btrim(coalesce(p_scope, '')), '');
  v_unit      text := nullif(btrim(coalesce(p_unit, '')), '');
  v_audit_id  text;
  v_now       timestamptz := now();
  v_id        uuid;
begin
  if v_uid is null then
    raise exception 'You must be signed in to add a target.';
  end if;
  if nullif(btrim(coalesce(p_project_id, '')), '') is null then
    raise exception 'A target must belong to a project.';
  end if;
  -- Mirrors validateTarget({ isNew: true }): a new target must be named.
  -- Migrated targets legitimately have no scope, which is why this is checked
  -- on creation only and never on update.
  if v_scope is null then
    raise exception 'Scope is required for a new target.';
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
    p_start_date, p_target_completion, p_actual_completion, p_actual_output,
    v_uid, v_now, v_uid, v_now
  )
  returning id into v_id;

  -- One creation event, so the history reads as a creation rather than as a
  -- list of edits from nothing.
  insert into public.project_manual_update_audit (
    project_id, target_id, target_scope, column_name, field_key,
    old_value, new_value, action, source, batch_id, changed_by, changed_by_username
  ) values (
    v_audit_id, v_id, v_scope, 'Target', 'target',
    null, v_scope, 'create', 'target_modal', v_batch, v_uid, v_username
  );

  -- Then the values it was created with, one row per field, so per-cell history
  -- has a starting point.
  insert into public.project_manual_update_audit (
    project_id, target_id, target_scope, column_name, field_key,
    old_value, new_value, action, source, batch_id, changed_by, changed_by_username
  )
  select v_audit_id, v_id, v_scope, f.label, f.field_key,
         null, f.new_value, 'create', 'target_modal', v_batch, v_uid, v_username
  from (values
    ('scope',             'Scope',             v_scope),
    ('target_qty',        'Target qty',        p_target_qty::text),
    ('unit',              'Unit',              v_unit),
    ('start_date',        'Start date',        p_start_date::text),
    ('target_completion', 'Target completion', p_target_completion::text),
    ('actual_completion', 'Actual completion', p_actual_completion::text),
    ('actual_output',     'Actual output',     p_actual_output::text)
  ) as f(field_key, label, new_value)
  where f.new_value is not null;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Update
-- ---------------------------------------------------------------------------
-- The caller sends the full set of field values; the database works out which
-- of them actually changed. Accepting a client-supplied list of changed fields
-- would let a save under-report itself, and the comparison has to happen
-- against the current row anyway.
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
  v_uid      uuid := auth.uid();
  v_username text;
  v_batch    uuid := coalesce(p_batch_id, gen_random_uuid());
  v_scope    text := nullif(btrim(coalesce(p_scope, '')), '');
  v_unit     text := nullif(btrim(coalesce(p_unit, '')), '');
  v_row      public.project_targets%rowtype;
  v_audit_id text;
  v_scope_for_audit text;
  v_changed  integer := 0;
begin
  if v_uid is null then
    raise exception 'You must be signed in to edit a target.';
  end if;

  -- Locked for the rest of the transaction, so two people saving the same
  -- target cannot interleave a read and a write between them.
  select * into v_row
  from public.project_targets
  where id = p_target_id
  for update;

  if not found then
    raise exception 'That target no longer exists. Reload and try again.';
  end if;
  -- Compared on the canonical key, never on display casing.
  if v_row.project_key is distinct from public.project_key(p_project_id) then
    raise exception 'That target belongs to a different project.';
  end if;
  if v_row.archived_at is not null then
    raise exception 'This target is archived. Restore it before editing.';
  end if;

  if not (
       v_row.scope             is distinct from v_scope
    or v_row.target_qty        is distinct from p_target_qty
    or v_row.unit              is distinct from v_unit
    or v_row.start_date        is distinct from p_start_date
    or v_row.target_completion is distinct from p_target_completion
    or v_row.actual_completion is distinct from p_actual_completion
    or v_row.actual_output     is distinct from p_actual_output
  ) then
    return 0;   -- nothing to write, and nothing to audit
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
      actual_completion = p_actual_completion,
      actual_output     = p_actual_output,
      updated_by        = v_uid,
      updated_at        = now()
  where id = p_target_id;

  -- One row per changed field, all sharing this save's batch. Field-level
  -- granularity is what the panel's per-cell history reads, so it is preserved
  -- rather than collapsed into a single JSON event.
  insert into public.project_manual_update_audit (
    project_id, target_id, target_scope, column_name, field_key,
    old_value, new_value, action, source, batch_id, changed_by, changed_by_username
  )
  select v_audit_id, p_target_id, v_scope_for_audit, f.label, f.field_key,
         f.old_value, f.new_value, 'update', 'target_modal', v_batch, v_uid, v_username
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
    ('actual_completion', 'Actual completion', v_row.actual_completion::text,  p_actual_completion::text,
       v_row.actual_completion is distinct from p_actual_completion),
    ('actual_output',     'Actual output',     v_row.actual_output::text,      p_actual_output::text,
       v_row.actual_output is distinct from p_actual_output)
  ) as f(field_key, label, old_value, new_value, changed)
  where f.changed;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Archive / restore
-- ---------------------------------------------------------------------------
create or replace function public.set_project_target_archived(
  p_target_id  uuid,
  p_project_id text,
  p_archived   boolean,
  p_batch_id   uuid default null
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_username text;
  v_batch    uuid := coalesce(p_batch_id, gen_random_uuid());
  v_row      public.project_targets%rowtype;
  v_audit_id text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to archive a target.';
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

  -- Already in the requested state: no write, no audit, no error.
  if (v_row.archived_at is not null) = p_archived then
    return false;
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;
  v_username := coalesce(v_username, 'Unknown user');
  v_audit_id := public.project_audit_id(p_project_id);

  update public.project_targets
  set archived_at = case when p_archived then now() else null end,
      archived_by = case when p_archived then v_uid else null end,
      updated_by  = v_uid,
      updated_at  = now()
  where id = p_target_id;

  -- Archiving changes no field, so it records one event and no field rows.
  insert into public.project_manual_update_audit (
    project_id, target_id, target_scope, column_name, field_key,
    old_value, new_value, action, source, batch_id, changed_by, changed_by_username
  ) values (
    v_audit_id, p_target_id, v_row.scope, 'Target', 'target',
    case when p_archived then coalesce(v_row.scope, '(no scope)') else null end,
    case when p_archived then null else coalesce(v_row.scope, '(no scope)') end,
    case when p_archived then 'archive' else 'restore' end,
    'target_modal', v_batch, v_uid, v_username
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and anon inherits from
-- PUBLIC, so the revoke is what actually keeps these off the anonymous role.
--
-- SECURITY INVOKER throughout, deliberately. Every statement these functions
-- run is one the calling user is already permitted to run, so there is nothing
-- to escalate: RLS stays enforced on project_targets, on the audit table and on
-- profiles exactly as it would be for a direct request. SECURITY DEFINER would
-- buy nothing here and would turn each function into a privileged surface that
-- has to be audited on its own terms. search_path is pinned to '' regardless,
-- and every reference is schema-qualified, so resolution cannot be redirected.
revoke all on function public.project_audit_id(text) from public, anon;
revoke all on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid) from public, anon;
revoke all on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid) from public, anon;
revoke all on function public.set_project_target_archived(uuid, text, boolean, uuid) from public, anon;

grant execute on function public.project_audit_id(text) to authenticated;
grant execute on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid) to authenticated;
grant execute on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid) to authenticated;
grant execute on function public.set_project_target_archived(uuid, text, boolean, uuid) to authenticated;

comment on function public.create_project_target(text, text, numeric, text, date, date, date, numeric, uuid) is
  'Creates a target and its audit rows in one transaction. Actor is read from auth.uid(); no user id is accepted from the caller.';
comment on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid) is
  'Updates a target and writes one audit row per changed field in one transaction. Returns the number of fields changed. The database computes the diff; a caller-supplied change list is not trusted.';
comment on function public.set_project_target_archived(uuid, text, boolean, uuid) is
  'Archives or restores a target and writes one audit event in one transaction. Returns false when the target is already in the requested state. Never deletes.';
