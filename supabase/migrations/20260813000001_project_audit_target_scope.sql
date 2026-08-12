-- Audit trail: tell a target change apart from a project change.
--
-- The existing table records one row per changed field, keyed on
-- (project_id, column_name), and the panel's right-click history reads it that
-- way through a matching index. That granularity is kept exactly as it is - a
-- single grouped record per save would break both the query and the feature.
-- What is added is enough identity to say *which* target a field belonged to,
-- and a batch id so one save can still be read back as one event.
alter table public.project_manual_update_audit
  -- Null for a project-level change, set for a target-level one. This single
  -- column produces both record shapes.
  add column if not exists target_id uuid references public.project_targets(id),
  -- The target's scope at the time of the change, denormalised the same way
  -- changed_by_username already is, so history stays readable after a rename.
  add column if not exists target_scope text,
  -- create | update | archive | restore. Null on historical rows, which were
  -- all field updates.
  add column if not exists action text,
  -- panel | target_modal | import
  add column if not exists source text,
  -- Groups every field row written by one save or one import.
  add column if not exists batch_id uuid,
  -- Stable internal key beside the display label, so renaming a column stops
  -- orphaning its history.
  add column if not exists field_key text;

-- No ON DELETE clause on the target reference, deliberately: deleting a target
-- must be blocked rather than quietly taking its history with it. Nothing is
-- granted DELETE on project_targets anyway.

-- The project reference used to point at project_manual_updates(project_id),
-- which is wrong now for two separate reasons.
--
-- It breaks target auditing outright: that row only exists once somebody has
-- typed a status, contract or remark, but a target can be created against any
-- project, so recording the creation would fail the constraint on every project
-- nobody had edited yet.
--
-- And it cascaded on delete, which meant removing a project's manual overrides
-- silently destroyed the history of every change ever made to it. An audit row
-- is a historical fact about a project ID; it does not depend on a row of
-- editable overrides continuing to exist.
-- Dropped by lookup rather than by name. `drop constraint if exists <guess>`
-- would succeed silently if the constraint were ever named anything else, and
-- the failure that follows is not silent at all: every attempt to create a
-- target against a project with no manual-overrides row would error. Finding it
-- in the catalogue means the migration either removes the right constraint or
-- says nothing was there to remove.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_namespace ns on ns.oid = child.relnamespace
    where con.contype = 'f'
      and ns.nspname = 'public'
      and child.relname = 'project_manual_update_audit'
      and parent.relname = 'project_manual_updates'
  loop
    execute format('alter table public.project_manual_update_audit drop constraint %I', constraint_name);
    raise notice 'Dropped audit -> project_manual_updates foreign key: %', constraint_name;
  end loop;
end
$$;

create index if not exists project_manual_update_audit_target_idx
  on public.project_manual_update_audit (target_id, changed_at desc)
  where target_id is not null;

create index if not exists project_manual_update_audit_batch_idx
  on public.project_manual_update_audit (batch_id)
  where batch_id is not null;

-- Point the existing target-field history at the target the backfill created.
-- Safe because every project had at most one target before this change, so
-- there is exactly one candidate per row. Status, Contract and Remarks history
-- keeps a null target_id - those are project-level and always were.
update public.project_manual_update_audit a
set target_id = t.id,
    field_key = case a.column_name
                  when 'Target qty' then 'target_qty'
                  when 'Unit' then 'unit'
                  when 'Start date' then 'start_date'
                  when 'Target completion' then 'target_completion'
                  when 'Actual completion' then 'actual_completion'
                  when 'Actual output' then 'actual_output'
                end,
    action = coalesce(a.action, 'update'),
    source = coalesce(a.source, 'panel')
from public.project_targets t
where t.migrated_from_project_id = a.project_id
  and a.target_id is null
  and a.column_name in (
    'Target qty', 'Unit', 'Start date',
    'Target completion', 'Actual completion', 'Actual output'
  );

-- Project-level history keeps its shape; only the new descriptive columns are
-- filled in so nothing reads as unknown.
update public.project_manual_update_audit a
set field_key = case a.column_name
                  when 'Status' then 'status'
                  when 'Contract' then 'contract'
                  when 'Remarks' then 'note'
                end,
    action = coalesce(a.action, 'update'),
    source = coalesce(a.source, 'panel')
where a.target_id is null
  and a.field_key is null
  and a.column_name in ('Status', 'Contract', 'Remarks');
