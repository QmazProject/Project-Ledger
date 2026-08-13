-- Fix: admin_delete_project() could never run.
--
--   ERROR: FOR UPDATE is not allowed with aggregate functions
--
-- 20260825000000 locked the project's targets and collected their ids in one
-- statement:
--
--   select array_agg(t.id) into v_target_ids
--   from public.project_targets t
--   where t.project_key = any(v_keys)
--   for update;                       -- <- rejected by PostgreSQL
--
-- A row lock is taken per row, and an aggregate has already collapsed the rows
-- by the time there is a result to lock, so PostgreSQL refuses the combination
-- outright. It is a planning error, not a data one: the function was created
-- successfully and failed on its first call, which is why the migration applied
-- cleanly and the failure only appeared when an administrator pressed Delete.
--
-- The lock is still wanted, for the reason the original comment gave: a target
-- created between reading the list and deleting it would otherwise survive a
-- delete that was supposed to include it. So the two jobs are separated into a
-- CTE that locks the rows and an aggregate over its output. The locking is
-- unchanged in effect; only the shape of the statement is.
--
-- Also corrected here: `from unnest(p_project_ids) as id` gave the alias and its
-- column the same name, leaving `public.project_key(id)` to be read as either.
-- PostgreSQL resolves it to the column, so the behaviour was right, but nothing
-- about the line said so. It is now spelled out.
--
-- Nothing else changes. Deletion order, the purge log, the admin check and the
-- returned counts are all exactly as they were.

create or replace function public.admin_delete_project(
  p_project_ids text[],
  p_reason      text
)
returns table (
  targets_deleted     integer,
  audit_rows_deleted  integer,
  manual_rows_deleted integer,
  purge_log_id        bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_username   text;
  v_keys       text[];
  v_target_ids uuid[];
  v_payload    jsonb;
  v_targets    integer := 0;
  v_audit      integer := 0;
  v_manual     integer := 0;
  v_log_id     bigint;
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete a project.';
  end if;
  if not public.is_project_admin() then
    raise exception 'Only an administrator can delete a project.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required. It is the only thing left explaining why this project no longer exists.';
  end if;
  if p_project_ids is null or cardinality(p_project_ids) = 0 then
    raise exception 'No project was named. Nothing was deleted.';
  end if;

  select array_agg(distinct public.project_key(supplied.project_id))
  into v_keys
  from unnest(p_project_ids) as supplied(project_id);

  select p.username into v_username from public.profiles p where p.id = v_uid;
  v_username := coalesce(v_username, 'Unknown user');

  -- Locked before anything is read, so a target created while this runs cannot
  -- survive the delete that was supposed to include it. The lock lives in the
  -- CTE, where there are still rows to lock; the aggregate runs over what it
  -- returns. Combining the two in one statement is what PostgreSQL rejects.
  with locked as (
    select t.id
    from public.project_targets t
    where t.project_key = any(v_keys)
    for update
  )
  select coalesce(array_agg(locked.id), array[]::uuid[])
  into v_target_ids
  from locked;

  -- Captured whole before any of it is destroyed.
  select jsonb_build_object(
    'targets', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.created_at)
      from public.project_targets t where t.project_key = any(v_keys)), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.id)
      from public.project_manual_update_audit a
      where a.project_id = any(p_project_ids) or a.target_id = any(v_target_ids)), '[]'::jsonb),
    'manual', coalesce((
      select jsonb_agg(to_jsonb(m))
      from public.project_manual_updates m where m.project_id = any(p_project_ids)), '[]'::jsonb)
  )
  into v_payload;

  -- Audit first: the foreign key on target_id forbids the other order. Matched
  -- on the project's own ids AND on the targets being removed, because a target
  -- audit row is filed under whatever project_audit_id() resolved to when it
  -- was written, which is not always one of the ids passed in.
  delete from public.project_manual_update_audit a
  where a.project_id = any(p_project_ids)
     or a.target_id = any(v_target_ids);
  get diagnostics v_audit = row_count;

  delete from public.project_targets t
  where t.project_key = any(v_keys);
  get diagnostics v_targets = row_count;

  delete from public.project_manual_updates m
  where m.project_id = any(p_project_ids);
  get diagnostics v_manual = row_count;

  insert into public.project_purge_log (
    project_ids, project_keys, reason, purged_by_uid, purged_by_username,
    targets_deleted, audit_rows_deleted, manual_rows_deleted, payload
  ) values (
    p_project_ids, v_keys, btrim(p_reason), v_uid, v_username,
    v_targets, v_audit, v_manual, v_payload
  )
  returning id into v_log_id;

  return query select v_targets, v_audit, v_manual, v_log_id;
end;
$$;

comment on function public.admin_delete_project(text[], text) is
  'Permanently deletes every target, audit entry and manual-override row filed under the given project ID spellings, after copying all of them into project_purge_log. Administrators only, checked server-side. Does NOT remove the imported project row: that lives in the project_ledger_dataset JSONB payload and is rewritten by the panel in the same action.';

-- CREATE OR REPLACE does not carry privileges forward on its own in every
-- deployment path, so they are restated rather than assumed.
revoke all on function public.admin_delete_project(text[], text) from public, anon;
grant execute on function public.admin_delete_project(text[], text) to authenticated;
