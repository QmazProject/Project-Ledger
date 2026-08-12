-- Keep immutable restore points for the shared parsed Project Ledger dataset.
-- Manual project edits, targets and their audit history live in separate tables
-- and are deliberately outside both snapshot and restore operations.
create table if not exists public.project_ledger_dataset_versions (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  source_label text not null default '',
  project_count integer not null default 0,
  uploaded_by uuid references auth.users(id) on delete set null,
  uploaded_by_username text,
  uploaded_at timestamptz,
  saved_reason text not null,
  saved_by uuid references auth.users(id) on delete set null,
  saved_by_username text not null,
  saved_at timestamptz not null default now(),
  constraint project_ledger_dataset_versions_payload_object
    check (jsonb_typeof(payload) = 'object'),
  constraint project_ledger_dataset_versions_reason
    check (saved_reason in ('before_import', 'before_restore'))
);

create index if not exists project_ledger_dataset_versions_saved_at_idx
  on public.project_ledger_dataset_versions (saved_at desc);

alter table public.project_ledger_dataset_versions enable row level security;

drop policy if exists "Authenticated users can read ledger restore points"
  on public.project_ledger_dataset_versions;
create policy "Authenticated users can read ledger restore points"
  on public.project_ledger_dataset_versions for select
  to authenticated
  using (true);

revoke all on public.project_ledger_dataset_versions from anon, authenticated;
grant select on public.project_ledger_dataset_versions to authenticated;

-- A durable audit of restore actions. The selected version remains immutable,
-- while this row records who applied it and when.
create table if not exists public.project_ledger_dataset_restore_audit (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.project_ledger_dataset_versions(id),
  restored_by uuid references auth.users(id) on delete set null,
  restored_by_username text not null,
  restored_at timestamptz not null default now(),
  previous_source_label text not null default '',
  restored_source_label text not null default '',
  project_count integer not null default 0
);

create index if not exists project_ledger_dataset_restore_audit_time_idx
  on public.project_ledger_dataset_restore_audit (restored_at desc);

alter table public.project_ledger_dataset_restore_audit enable row level security;

drop policy if exists "Authenticated users can read ledger restore audit"
  on public.project_ledger_dataset_restore_audit;
create policy "Authenticated users can read ledger restore audit"
  on public.project_ledger_dataset_restore_audit for select
  to authenticated
  using (true);

revoke all on public.project_ledger_dataset_restore_audit from anon, authenticated;
grant select on public.project_ledger_dataset_restore_audit to authenticated;

-- Replace the existing import RPC so snapshot creation, dataset replacement and
-- imported-field audit remain one transaction. Concurrent imports serialize on
-- the single current-dataset row before either takes its restore point.
create or replace function public.save_project_ledger_import(
  p_payload       jsonb,
  p_source_label  text,
  p_project_count integer,
  p_changes       jsonb default '[]'::jsonb
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := auth.uid();
  v_username text;
  v_now      timestamptz := now();
  v_batch    uuid := gen_random_uuid();
begin
  if v_uid is null then
    raise exception 'You must be signed in to import Project Ledger data.';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'The parsed Project Ledger payload must be an object.';
  end if;
  if jsonb_typeof(coalesce(p_changes, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Project import changes must be an array.';
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
    'before_import', v_uid, v_username, v_now
  from public.project_ledger_dataset d
  where d.id = 'current';

  insert into public.project_ledger_dataset (
    id, payload, source_label, project_count,
    uploaded_by, uploaded_by_username, uploaded_at
  ) values (
    'current', p_payload, coalesce(p_source_label, ''), greatest(coalesce(p_project_count, 0), 0),
    v_uid, v_username, v_now
  )
  on conflict (id) do update
  set payload = excluded.payload,
      source_label = excluded.source_label,
      project_count = excluded.project_count,
      uploaded_by = excluded.uploaded_by,
      uploaded_by_username = excluded.uploaded_by_username,
      uploaded_at = excluded.uploaded_at;

  insert into public.project_manual_update_audit (
    project_id, column_name, field_key, old_value, new_value,
    action, source, batch_id, changed_by, changed_by_username, changed_at
  )
  select
    c.item->>'project_id', fields.column_name, fields.field_key,
    c.item->>'old_value', c.item->>'new_value',
    'update', 'excel', v_batch, v_uid, v_username, v_now
  from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) as c(item)
  join (values
    ('district', 'District'),
    ('license', 'License'),
    ('engineer', 'Senior engineer'),
    ('category', 'Category'),
    ('location', 'Location'),
    ('status', 'Status'),
    ('contract', 'Contract'),
    ('swa', 'SWA %'),
    ('office', 'Implementing office'),
    ('billpct', 'Billed %'),
    ('net', 'Collected (net)'),
    ('cg', 'Balance works'),
    ('cr', 'Retention'),
    ('bal', 'Balance for collection'),
    ('netbal', 'Net balance')
  ) as fields(field_key, column_name)
    on fields.field_key = c.item->>'field_key'
  where nullif(btrim(c.item->>'project_id'), '') is not null
    and (c.item->>'old_value') is distinct from (c.item->>'new_value');

  return v_now;
end;
$$;

revoke all on function public.save_project_ledger_import(jsonb, text, integer, jsonb)
  from public, anon;
grant execute on function public.save_project_ledger_import(jsonb, text, integer, jsonb)
  to authenticated;

comment on function public.save_project_ledger_import(jsonb, text, integer, jsonb) is
  'Atomically saves the current ledger as a restore point, replaces it with an import, and records changed Excel fields.';

-- Restore only the shared imported dataset. Before replacing it, save the
-- current state as another restore point so a mistaken restore is recoverable.
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

revoke all on function public.restore_project_ledger_version(uuid) from public, anon;
grant execute on function public.restore_project_ledger_version(uuid) to authenticated;

comment on function public.restore_project_ledger_version(uuid) is
  'Restores one immutable imported-dataset version, backs up the replaced dataset, and records the restore actor and time without changing manual project data.';
