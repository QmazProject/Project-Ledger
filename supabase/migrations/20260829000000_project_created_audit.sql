-- One audit event for a project created by hand.
--
-- Deliberately one row, not one per field. save_project_ledger_import() writes a
-- row per changed column, which is right for an import — the question there is
-- always "what changed about this project" — but wrong for a creation: before
-- it there was no project, so every field is trivially "new" and eleven rows
-- would say nothing eleven times. Worse, they would bury the field-level
-- history of the edits that follow, which is the part anybody actually reads.
--
-- So creation records that the project was created, by whom and when, and the
-- ordinary per-field trail starts from the next edit.
--
-- It cannot go through save_project_ledger_import(): that function hardcodes
-- action 'update' and source 'excel', and only accepts a fixed list of column
-- keys. A hand-created project is neither an update nor an Excel change, and
-- labelling it as one would make the panel show "Excel updated" for something no
-- workbook ever touched.

create or replace function public.record_project_created(
  p_project_id text,
  p_summary    text default null
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_username text;
  v_id       bigint;
begin
  if v_uid is null then
    raise exception 'You must be signed in to create a project.';
  end if;
  if p_project_id is null or btrim(p_project_id) = '' then
    raise exception 'A project ID is required.';
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;

  insert into public.project_manual_update_audit (
    project_id, column_name, field_key,
    old_value, new_value,
    action, source, batch_id, changed_by, changed_by_username
  ) values (
    btrim(p_project_id),
    -- Not one of the editable column labels on purpose: this event belongs to
    -- the project, not to a cell, so it must not appear in the history of a
    -- column whose value it never set.
    'Project', 'project',
    -- old_value null is the fact being recorded: nothing preceded it.
    null, coalesce(nullif(btrim(coalesce(p_summary, '')), ''), btrim(p_project_id)),
    'create', 'panel', gen_random_uuid(), v_uid, coalesce(v_username, 'Unknown user')
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.record_project_created(text, text) is
  'Records a single "created" event for a hand-entered project. One row, not one per field: before creation there was no project, so per-field rows would say nothing repeatedly and bury the edits that follow. Actor is read from auth.uid().';

-- SECURITY INVOKER: the caller already holds INSERT on project_manual_update_audit
-- under a policy requiring changed_by = auth.uid(), which is exactly the row this
-- writes. There is nothing here the caller could not do directly, so there is
-- nothing to escalate.
revoke all on function public.record_project_created(text, text) from public, anon;
grant execute on function public.record_project_created(text, text) to authenticated;
