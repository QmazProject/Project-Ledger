-- Actual completion follows the evidence in both directions.
--
-- It was write-once: the first save whose Actual output reached Target qty
-- stamped a completion date, and nothing could ever clear it. A typo therefore
-- marked a target delivered permanently — type 1000 into a 1000 target, save,
-- notice the mistake, correct it to 100, and the target still reads Delivered
-- with 100 of 1000 done. isTargetDone() checks the stamp before it compares the
-- numbers, so that target stayed out of the at-risk figures and out of the
-- project row's Earliest Start date and Earliest target completion for good.
-- The only remedy was to delete the target and lose its audit history with it.
--
-- Completion is now cleared when the current Actual output no longer reaches
-- the current Target qty. It remains automatic and audit-backed; it is simply
-- no longer irreversible.
--
-- The trade the business accepted: a target genuinely delivered and later
-- reopened for rework loses the date of its first delivery. The audit trail
-- still holds it — every stamp and every clearing is now recorded as an
-- 'Actual completion' entry, which is new. Previously the completion had no
-- audit field of its own and relied on the Actual output row as its evidence;
-- that is enough to explain a stamp appearing but not a stamp disappearing.
--
-- What has NOT changed: raising or lowering Target qty on its own still cannot
-- manufacture a completion. Creating one still requires a changed, non-null
-- Actual output that reaches the target. Only the clearing side is new, and it
-- deliberately does look at Target qty — a target whose quantity is raised
-- above what has been produced is no longer met, however it got that way.

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
  v_meets_target   boolean;
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

  -- Does what has been produced still reach what was asked for?
  v_meets_target := p_actual_output is not null
                and p_target_qty is not null
                and p_actual_output >= p_target_qty;

  -- Create. Still requires a changed, non-null Actual output, so editing
  -- Target qty alone cannot manufacture a delivery timestamp.
  if v_completion is null and v_output_changed and v_meets_target then
    v_completion := timezone('Asia/Manila', v_now)::date;
  end if;

  -- Clear. The stamp is evidence that the target was met; once that is no
  -- longer true the evidence has to go with it, or a corrected typo would leave
  -- the target reading Delivered forever.
  if v_completion is not null and not v_meets_target then
    v_completion := null;
  end if;

  if v_completion is not null
     and p_start_date is not null
     and v_completion < p_start_date then
    raise exception 'Start date cannot be after the automatic completion date.';
  end if;

  -- p_actual_completion is deliberately absent from this comparison. A caller
  -- cannot turn a no-op into an edit by sending a manual completion date.
  --
  -- The completion is compared, though. A row left inconsistent by the old
  -- write-once rule — delivered stamp, output since reduced — is corrected by
  -- the next save of that target even when no other field changes.
  if not (
       v_row.scope             is distinct from v_scope
    or v_row.target_qty        is distinct from p_target_qty
    or v_row.unit              is distinct from v_unit
    or v_row.start_date        is distinct from p_start_date
    or v_row.target_completion is distinct from p_target_completion
    or v_row.remarks           is distinct from v_remarks
    or v_row.actual_completion is distinct from v_completion
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
       v_row.remarks is distinct from v_remarks),
    -- New. A stamp appearing is explained by the Actual output row beside it; a
    -- stamp disappearing is not, so the completion now records its own history
    -- in both directions.
    ('actual_completion', 'Actual completion', v_row.actual_completion::text,  v_completion::text,
       v_row.actual_completion is distinct from v_completion)
  ) as f(field_key, label, old_value, new_value, changed)
  where f.changed;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

comment on function public.update_project_target(uuid, text, text, numeric, text, date, date, date, numeric, uuid, text) is
  'Updates editable target fields and audits their database-computed diff atomically. Actual completion is generated from a changed Actual output that reaches Target qty, and cleared again when the current output no longer reaches the current Target qty; both directions are audited. p_actual_completion is ignored. p_remarks is the per-target remark, audited as ''Target remarks''.';
