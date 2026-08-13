-- Let an import record a changed Project name.
--
-- save_project_ledger_import() only writes an audit row for a field key it
-- recognises — the join below is the whitelist, and anything not named there is
-- dropped without complaint. `name` was never in it, so a workbook renaming a
-- project changed the ledger and recorded nothing.
--
-- That was tolerable while the displayed name always came from the workbook: the
-- new name was on screen, so its history was at least inferable. It stops being
-- tolerable now that a project can be created by hand with a typed name, because
-- the typed name stays on screen and the workbook's name is not shown anywhere.
-- Without this row there would be no trace at all that the workbook ever said
-- something different, which is precisely the trace that was asked for.
--
-- The body below is copied verbatim from 20260817000000, which is the current
-- definition, with only the whitelist row added. That matters: 20260817 replaced
-- the original function to save a restore point into
-- project_ledger_dataset_versions before every write. Rebuilding this function
-- from the older 20260816 body would have dropped that block and silently
-- stopped "Previous data" from recording anything new — a loss that would not
-- surface until somebody needed to go back.

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
    -- The one addition in this migration. Must stay in step with
    -- IMPORT_AUDIT_FIELDS in src/lib/projectImport.js: a key the client sends
    -- and this list omits is discarded silently, which is how Project name
    -- went unaudited until now.
    ('name', 'Project name'),
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
  'Atomically saves the current ledger as a restore point, replaces it with an import, and records changed Excel fields, including Project name.';
