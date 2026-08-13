-- Per-user access to the administrator features.
--
-- Until now every one of these was gated on role = 'admin', which forces a
-- choice between giving somebody nothing and giving them everything — including
-- permanent deletion of audit history. This adds named permissions that an
-- administrator can grant one at a time.
--
-- An administrator implicitly holds all of them; a grant is only ever needed for
-- somebody who is not one. That keeps the existing behaviour exactly as it is
-- for existing admins and means this migration changes nobody's access on the
-- day it is applied.
--
-- Where the check really lives, per permission:
--
--   delete_project    enforced in the database (admin_delete_project,
--                     admin_delete_project_target)
--   delete_audit      enforced in the database (admin_delete_audit_entries)
--   view_presence     enforced in the database (list_ledger_presence)
--   previous_data     enforced in the database (restore_project_ledger_version)
--                     -- newly, see below
--   add_project       NOT enforceable here. Adding a project is a write to the
--                     shared dataset through save_project_ledger_import, which
--                     every signed-in user must be able to call in order to
--                     import a workbook at all. The permission hides the form;
--                     it is not a security boundary, and is documented as such.
--   view_duplicates   nothing to enforce. It is arithmetic over rows the user
--                     can already see, done entirely in the browser.
--
-- The four rebuilt functions below have one line changed each. Their bodies were
-- extracted from the current definitions rather than retyped:
--   admin_delete_project         rebuilt from 20260827000000_fix_admin_delete_project_lock.sql
--   admin_delete_project_target  rebuilt from 20260824000000_admin_delete_targets_audit.sql
--   admin_delete_audit_entries   rebuilt from 20260824000000_admin_delete_targets_audit.sql
--   list_ledger_presence         rebuilt from 20260826000000_project_ledger_presence.sql
--   restore_project_ledger_version rebuilt from 20260817000000_project_dataset_restore.sql (check ADDED)

create table if not exists public.project_ledger_permissions (
  user_id    uuid not null references auth.users(id) on delete cascade,
  permission text not null,
  granted_by uuid references auth.users(id) on delete set null,
  granted_by_username text,
  granted_at timestamptz not null default now(),
  primary key (user_id, permission),
  -- Spelling mistakes must fail loudly here rather than silently granting
  -- nothing: a permission nobody can hold looks identical to one nobody needs.
  constraint project_ledger_permissions_known check (permission in (
    'add_project', 'delete_project', 'delete_audit',
    'view_presence', 'view_duplicates', 'previous_data'
  ))
);

comment on table public.project_ledger_permissions is
  'Named Project Ledger permissions granted to individual users. Administrators hold every permission implicitly and need no row here. Written only through set_ledger_permission().';

alter table public.project_ledger_permissions enable row level security;

-- A user may read their own grants, because the panel has to know which
-- controls to draw. Administrators may read everyone's, to manage them.
drop policy if exists "Read own or all permissions" on public.project_ledger_permissions;
create policy "Read own or all permissions"
  on public.project_ledger_permissions for select
  to authenticated
  using ((select auth.uid()) = user_id or public.is_project_admin());

-- No insert, update or delete policy: granting goes through the function below,
-- so a user cannot grant themselves anything.
revoke all on public.project_ledger_permissions from anon, authenticated;
grant select on public.project_ledger_permissions to authenticated;

-- ---------------------------------------------------------------------------
-- The check every gated function calls
-- ---------------------------------------------------------------------------
create or replace function public.has_ledger_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_project_admin()
      or exists (
        select 1 from public.project_ledger_permissions p
        where p.user_id = (select auth.uid())
          and p.permission = p_permission
      );
$$;

comment on function public.has_ledger_permission(text) is
  'True when the calling user is an administrator, or has been granted this named permission. Read server-side from auth.uid().';

revoke all on function public.has_ledger_permission(text) from public, anon;
grant execute on function public.has_ledger_permission(text) to authenticated;

-- What the panel asks for itself, so it knows which controls to draw.
create or replace function public.my_ledger_permissions()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.is_project_admin() then array[
      'add_project', 'delete_project', 'delete_audit',
      'view_presence', 'view_duplicates', 'previous_data']
    else coalesce((
      select array_agg(p.permission order by p.permission)
      from public.project_ledger_permissions p
      where p.user_id = (select auth.uid())
    ), array[]::text[])
  end;
$$;

revoke all on function public.my_ledger_permissions() from public, anon;
grant execute on function public.my_ledger_permissions() to authenticated;

-- ---------------------------------------------------------------------------
-- Granting
-- ---------------------------------------------------------------------------
create or replace function public.set_ledger_permission(
  p_user_id    uuid,
  p_permission text,
  p_granted    boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_username text;
begin
  if v_uid is null then
    raise exception 'You must be signed in.';
  end if;
  -- Only an administrator grants access, never somebody holding the permission
  -- itself: otherwise the first grant of any permission would let its holder
  -- hand it on, and the administrator would no longer decide who has it.
  if not public.is_project_admin() then
    raise exception 'Only an administrator can change access.';
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;

  if p_granted then
    insert into public.project_ledger_permissions (user_id, permission, granted_by, granted_by_username)
    values (p_user_id, p_permission, v_uid, coalesce(v_username, 'Unknown user'))
    on conflict (user_id, permission) do update
      set granted_by = excluded.granted_by,
          granted_by_username = excluded.granted_by_username,
          granted_at = now();
  else
    delete from public.project_ledger_permissions
    where user_id = p_user_id and permission = p_permission;
  end if;
end;
$$;

revoke all on function public.set_ledger_permission(uuid, text, boolean) from public, anon;
grant execute on function public.set_ledger_permission(uuid, text, boolean) to authenticated;

-- Every grant, for the admin screen.
create or replace function public.list_ledger_permissions()
returns table (user_id uuid, permission text, granted_by_username text, granted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_project_admin() then
    raise exception 'Only an administrator can read access settings.';
  end if;
  return query
    select p.user_id, p.permission, p.granted_by_username, p.granted_at
    from public.project_ledger_permissions p;
end;
$$;

revoke all on function public.list_ledger_permissions() from public, anon;
grant execute on function public.list_ledger_permissions() to authenticated;

-- ---------------------------------------------------------------------------
-- The gated functions, rebuilt with one line changed each
-- ---------------------------------------------------------------------------

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
  if not public.has_ledger_permission('delete_project') then
    raise exception 'You do not have access to delete a project. Ask an administrator to grant Delete project.';
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

create or replace function public.admin_delete_project_target(
  p_target_id uuid,
  p_reason    text
)
returns table (
  deleted_target_id  uuid,
  deleted_project_id text,
  deleted_scope      text,
  audit_rows_deleted integer,
  purge_log_id       bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := (select auth.uid());
  v_username    text;
  v_target      public.project_targets%rowtype;
  v_audit       jsonb;
  v_audit_count integer;
  v_log_id      bigint;
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete a target.';
  end if;
  if not public.has_ledger_permission('delete_project') then
    raise exception 'You do not have access to delete a target. Ask an administrator to grant Delete project.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required. It is the only thing left explaining why this data no longer exists.';
  end if;

  select * into v_target
  from public.project_targets
  where id = p_target_id
  for update;

  if not found then
    raise exception 'That target no longer exists. Reload and try again.';
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;
  v_username := coalesce(v_username, 'Unknown user');

  -- Captured before anything is destroyed.
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb), count(*)
  into v_audit, v_audit_count
  from public.project_manual_update_audit a
  where a.target_id = p_target_id;

  insert into public.project_target_purge_log (
    target_id, project_id, project_key, target_scope,
    reason, purged_by, purged_by_uid, purged_by_username,
    audit_rows_deleted, payload
  ) values (
    v_target.id, v_target.project_id, v_target.project_key, v_target.scope,
    btrim(p_reason), current_user, v_uid, v_username,
    v_audit_count,
    jsonb_build_object('target', to_jsonb(v_target), 'audit', v_audit)
  )
  returning id into v_log_id;

  -- Audit rows first: the foreign key forbids the other order.
  delete from public.project_manual_update_audit a
  where a.target_id = p_target_id;

  delete from public.project_targets t
  where t.id = p_target_id;

  return query
    select v_target.id, v_target.project_id, v_target.scope, v_audit_count, v_log_id;
end;
$$;

create or replace function public.admin_delete_audit_entries(
  p_audit_ids bigint[],
  p_reason    text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_username text;
  v_deleted  integer;
begin
  if v_uid is null then
    raise exception 'You must be signed in to delete audit history.';
  end if;
  if not public.has_ledger_permission('delete_audit') then
    raise exception 'You do not have access to delete audit history. Ask an administrator to grant Delete audit trail.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required for deleting audit history.';
  end if;
  if p_audit_ids is null or cardinality(p_audit_ids) = 0 then
    return 0;
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;
  v_username := coalesce(v_username, 'Unknown user');

  -- Logged before deletion, and only for rows that actually exist, so the log
  -- never claims something was destroyed that was already gone.
  insert into public.project_audit_purge_log (
    audit_id, project_id, column_name, target_id,
    reason, purged_by_uid, purged_by_username, payload
  )
  select a.id, a.project_id, a.column_name, a.target_id,
         btrim(p_reason), v_uid, v_username, to_jsonb(a)
  from public.project_manual_update_audit a
  where a.id = any(p_audit_ids);

  delete from public.project_manual_update_audit a
  where a.id = any(p_audit_ids);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.list_ledger_presence(p_within_seconds integer default 150)
returns table (
  user_id       uuid,
  username      text,
  first_seen_at timestamptz,
  last_seen_at  timestamptz,
  seconds_ago   integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_ledger_permission('view_presence') then
    raise exception 'You do not have access to see who is signed in.';
  end if;

  return query
  select p.user_id, p.username, p.first_seen_at, p.last_seen_at,
         extract(epoch from (now() - p.last_seen_at))::integer
  from public.project_ledger_presence p
  where p.last_seen_at > now() - make_interval(secs => greatest(p_within_seconds, 30))
  order by p.username;
end;
$$;

create or replace function public.restore_project_ledger_version(p_version_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid                   uuid := auth.uid();
  v_username              text;
  v_now                   timestamptz := now();
  v_version               public.project_ledger_dataset_versions%rowtype;
  v_previous_source_label text := '';
  v_restored_source_label text;
begin
  if v_uid is null then
    raise exception 'You must be signed in to restore Project Ledger data.';
  end if;
  -- Previously absent. EXECUTE is granted to `authenticated`, so until now
  -- the only thing standing between any signed-in user and replacing the
  -- shared ledger was the panel choosing not to draw the button.
  if not public.has_ledger_permission('previous_data') then
    raise exception 'You do not have access to restore previous data.';
  end if;

  select v.* into v_version
  from public.project_ledger_dataset_versions v
  where v.id = p_version_id;
  if not found then
    raise exception 'That Project Ledger restore point no longer exists.';
  end if;

  select p.username into v_username
  from public.profiles p
  where p.id = v_uid;
  v_username := coalesce(v_username, 'Unknown user');

  perform 1
  from public.project_ledger_dataset d
  where d.id = 'current'
  for update;

  insert into public.project_ledger_dataset_versions (
    payload, source_label, project_count,
    uploaded_by, uploaded_by_username, uploaded_at,
    saved_reason, saved_by, saved_by_username, saved_at
  )
  select
    d.payload, d.source_label, d.project_count,
    d.uploaded_by, d.uploaded_by_username, d.uploaded_at,
    'before_restore', v_uid, v_username, v_now
  from public.project_ledger_dataset d
  where d.id = 'current';

  select coalesce(d.source_label, '') into v_previous_source_label
  from public.project_ledger_dataset d
  where d.id = 'current';

  v_restored_source_label := case
    when nullif(btrim(v_version.source_label), '') is null then 'Restored previous data'
    else 'Restored previous data · ' || v_version.source_label
  end;

  update public.project_ledger_dataset
  set payload = v_version.payload,
      source_label = v_restored_source_label,
      project_count = v_version.project_count,
      uploaded_by = v_uid,
      uploaded_by_username = v_username,
      uploaded_at = v_now
  where id = 'current';

  if not found then
    raise exception 'The shared Project Ledger dataset no longer exists.';
  end if;

  insert into public.project_ledger_dataset_restore_audit (
    version_id, restored_by, restored_by_username, restored_at,
    previous_source_label, restored_source_label, project_count
  ) values (
    v_version.id, v_uid, v_username, v_now,
    v_previous_source_label, v_version.source_label, v_version.project_count
  );

  return v_now;
end;
$$;
