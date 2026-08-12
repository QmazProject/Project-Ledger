-- Replace the shared parsed workbook and record its real field changes in the
-- same transaction. A failed audit insert must not leave a new dataset with no
-- history, and a failed dataset write must not leave history for values nobody
-- can see.
create or replace function public.save_project_ledger_import(
  p_payload       jsonb,
  p_source_label  text,
  p_project_count integer,
  p_changes       jsonb default '[]'::jsonb
)
returns timestamptz
language plpgsql
security invoker
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

revoke all on function public.save_project_ledger_import(jsonb, text, integer, jsonb) from public, anon;
grant execute on function public.save_project_ledger_import(jsonb, text, integer, jsonb) to authenticated;

comment on function public.save_project_ledger_import(jsonb, text, integer, jsonb) is
  'Atomically replaces the shared parsed ledger and records only changed imported fields as Excel audit rows. Actor and timestamp are determined by the database.';
