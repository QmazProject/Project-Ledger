-- ===========================================================================
-- Staging verification for the multiple-target migrations
--   20260813000000_project_targets.sql
--   20260813000001_project_audit_target_scope.sql
--
-- Run on a BRANCH or STAGING database, never on production.
--
-- Sections 1-3 are read-only and are meant to be run BEFORE the migrations
-- where noted. Section 7 is the only part that writes, and it wraps itself in
-- a transaction it rolls back. Nothing here deletes or rewrites a row.
--
-- Every check prints a `verdict` column. Anything other than PASS needs
-- reading before Phase 4 starts.
-- ===========================================================================

-- ---- 0. WHICH DATABASE AM I ON -----------------------------------

select current_database()          as database,
       current_user               as role,
       version()                  as server,
       current_setting('server_version_num')::int >= 130000
         as gen_random_uuid_builtin;

-- gen_random_uuid() is built in from PostgreSQL 13. If the column above is
-- false, the pgcrypto extension must be present instead:
select exists (select 1 from pg_extension where extname = 'pgcrypto') as pgcrypto_installed;


-- ===========================================================================
-- 2. ORPHAN CHECK  --  RUN THIS BEFORE APPLYING THE MIGRATIONS
-- ===========================================================================
-- Manual rows are matched to imported projects on the raw ID today, so a
-- project whose ID changed case or apostrophe form between workbook versions
-- has hand-typed data that no longer appears anywhere in the panel. Those rows
-- are about to be migrated into targets, so they need looking at first.
--
-- Nothing here modifies anything. Classification only.

-- ---- 2a. ORPHAN SUMMARY ------------------------------------------

with imported as (
  select distinct r->>'id' as project_id
  from public.project_ledger_dataset d,
       lateral jsonb_array_elements(d.payload->'coll') as r
  where d.id = 'current'
),
classified as (
  select m.project_id,
         exists (select 1 from imported i where i.project_id = m.project_id) as exact_match,
         (select count(*) from imported i
           where public.project_key(i.project_id) = public.project_key(m.project_id)) as canonical_matches
  from public.project_manual_updates m
)
select
  count(*)                                                              as total_manual_rows,
  count(*) filter (where exact_match)                                   as matched,
  count(*) filter (where not exact_match)                               as orphaned,
  count(*) filter (where not exact_match and canonical_matches = 1)     as safe_to_rekey,
  count(*) filter (where not exact_match and canonical_matches > 1)     as ambiguous,
  count(*) filter (where not exact_match and canonical_matches = 0)     as no_match,
  case when count(*) filter (where not exact_match and canonical_matches > 1) = 0
       then 'PASS' else 'REVIEW - ambiguous orphans present' end        as verdict
from classified;

-- ---- 2b. ORPHANED ROWS, ONE LINE EACH ----------------------------

with imported as (
  select distinct r->>'id' as project_id
  from public.project_ledger_dataset d,
       lateral jsonb_array_elements(d.payload->'coll') as r
  where d.id = 'current'
)
select
  m.project_id                                              as stored_id,
  public.project_key(m.project_id)                          as canonical_key,
  (select string_agg(i.project_id, ' | ')
     from imported i
    where public.project_key(i.project_id) = public.project_key(m.project_id))
                                                            as candidate_imported_ids,
  case
    when (select count(*) from imported i
           where public.project_key(i.project_id) = public.project_key(m.project_id)) = 1
      then 'SAFE TO REKEY'
    when (select count(*) from imported i
           where public.project_key(i.project_id) = public.project_key(m.project_id)) > 1
      then 'AMBIGUOUS'
    else 'NO MATCH'
  end                                                       as classification,
  -- what is actually at stake on this row
  (m.target_qty is not null or m.unit is not null or m.start_date is not null
   or m.target_completion is not null or m.actual_completion is not null
   or m.actual_output is not null)                          as has_target_data,
  m.status is not null                                      as has_status,
  m.contract_amount is not null                             as has_contract,
  nullif(btrim(coalesce(m.remarks, '')), '') is not null    as has_remarks,
  m.updated_at
from public.project_manual_updates m
where not exists (select 1 from imported i where i.project_id = m.project_id)
order by classification, m.project_id;

-- NO MATCH means the project is not in the current workbook at all - it may
-- simply have been dropped from the import, which is not a defect. AMBIGUOUS
-- means two imported IDs normalise to the same key; do not rekey those
-- automatically, and do not migrate them without deciding which project owns
-- the data.


-- ===========================================================================
-- 3. CANONICAL KEY PARITY  --  project_key() vs the JavaScript normaliser
-- ===========================================================================
-- These cases mirror KEY_PARITY_CASES in src/lib/targets.test.js exactly. If
-- either side is edited, edit both. A divergence here is what would make a
-- migrated target invisible to the application that has to find it.
--
-- The whitespace cases are the ones that matter: PostgreSQL's \s resolves to
-- [[:space:]] against the database locale and under glibc excludes U+00A0,
-- while JavaScript's \s includes it. The migration spells the class out for
-- exactly this reason.

-- ---- 3. PROJECT_KEY PARITY ---------------------------------------

with cases (n, input, expected, note) as (
  values
    ( 1, 'abc-001',                     'ABC-001',  'lower case'),
    ( 2, 'ABC-001',                     'ABC-001',  'already canonical'),
    ( 3, 'abc ''001',                   'ABC 001',  'straight apostrophe'),
    ( 4, U&'ABC \2019001',              'ABC 001',  'curly apostrophe'),
    ( 5, 'O''BRIEN-2',                  'OBRIEN-2', 'straight, mid-token'),
    ( 6, U&'O\2019BRIEN-2',             'OBRIEN-2', 'curly, mid-token'),
    ( 7, '  abc-001  ',                 'ABC-001',  'leading / trailing'),
    ( 8, 'abc    001',                  'ABC 001',  'repeated spaces'),
    ( 9, U&'abc\0009001',               'ABC 001',  'tab'),
    (10, U&'abc\00a0001',               'ABC 001',  'non-breaking space'),
    (11, U&'abc\202f001',               'ABC 001',  'narrow no-break space'),
    (12, U&'abc\3000001',               'ABC 001',  'ideographic space'),
    (13, U&'abc-001\feff',              'ABC-001',  'zero-width no-break space'),
    (14, U&'  abc\00a0\00a0\0027  001 ','ABC 001',  'several kinds at once')
)
select n, note,
       input,
       public.project_key(input) as actual,
       expected,
       case when public.project_key(input) = expected then 'PASS' else 'FAIL' end as verdict
from cases
order by n;

-- ---- 3b. PARITY ROLL-UP (expect failures = 0) --------------------

with cases (input, expected) as (
  values
    ('abc-001','ABC-001'), ('ABC-001','ABC-001'), ('abc ''001','ABC 001'),
    (U&'ABC \2019001','ABC 001'), ('O''BRIEN-2','OBRIEN-2'), (U&'O\2019BRIEN-2','OBRIEN-2'),
    ('  abc-001  ','ABC-001'), ('abc    001','ABC 001'), (U&'abc\0009001','ABC 001'),
    (U&'abc\00a0001','ABC 001'), (U&'abc\202f001','ABC 001'), (U&'abc\3000001','ABC 001'),
    (U&'abc-001\feff','ABC-001'), (U&'  abc\00a0\00a0\0027  001 ','ABC 001')
)
select count(*) filter (where public.project_key(input) <> expected) as failures,
       case when count(*) filter (where public.project_key(input) <> expected) = 0
            then 'PASS' else 'FAIL - fix project_key() before migrating' end as verdict
from cases;

-- Known and accepted limitation: upper() folds non-ASCII letters per the
-- database locale, so an ID containing a German sharp s or a Turkish dotted i
-- would not match JavaScript's toUpperCase(). Project IDs here are ASCII.
-- This check surfaces any that are not:
select project_id
from public.project_manual_updates
where project_id ~ '[^\x20-\x7e]'
union
select distinct r->>'id'
from public.project_ledger_dataset d, lateral jsonb_array_elements(d.payload->'coll') as r
where d.id = 'current' and (r->>'id') ~ '[^\x20-\x7e]';


-- ===========================================================================
-- 4. SCHEMA  --  RUN AFTER APPLYING THE MIGRATIONS
-- ===========================================================================

-- ---- 4a. COLUMNS -------------------------------------------------

select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'project_targets'
order by ordinal_position;

-- Expect: id uuid NOT NULL default gen_random_uuid(); project_id text NOT NULL;
-- project_key text NOT NULL; scope text NULLABLE; target_qty numeric;
-- unit text; start_date/target_completion/actual_completion date;
-- actual_output numeric; archived_at timestamptz; archived_by uuid;
-- created_by/updated_by uuid NOT NULL; created_at/updated_at timestamptz NOT NULL.

-- ---- 4b. SCOPE MUST BE NULLABLE (migrated targets have none) -----

select is_nullable,
       case when is_nullable = 'YES' then 'PASS'
            else 'FAIL - backfill cannot complete with NOT NULL scope' end as verdict
from information_schema.columns
where table_schema = 'public' and table_name = 'project_targets' and column_name = 'scope';

-- ---- 4c. INDEXES -------------------------------------------------

select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'project_targets'
order by indexname;

-- Expect the primary key plus project_targets_project_key_idx,
-- project_targets_lookup_idx and the unique partial
-- project_targets_migration_once_idx.

-- ---- 4d. THE AUDIT FOREIGN KEY MUST BE GONE ----------------------

select count(*) as remaining_fks,
       case when count(*) = 0 then 'PASS'
            else 'BLOCKER - target creation will fail for projects with no manual row' end as verdict
from pg_constraint con
join pg_class child on child.oid = con.conrelid
join pg_class parent on parent.oid = con.confrelid
join pg_namespace ns on ns.oid = child.relnamespace
where con.contype = 'f' and ns.nspname = 'public'
  and child.relname = 'project_manual_update_audit'
  and parent.relname = 'project_manual_updates';

-- ---- 4e. AUDIT COLUMNS ADDED -------------------------------------

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'project_manual_update_audit'
  and column_name in ('target_id','target_scope','action','source','batch_id','field_key')
order by column_name;
-- Expect all six present.


-- ===========================================================================
-- 5 & 6. BACKFILL
-- ===========================================================================

-- ---- 5a. BACKFILL COUNTS -----------------------------------------

with eligible as (
  select project_id from public.project_manual_updates
  where target_qty is not null or unit is not null or start_date is not null
     or target_completion is not null or actual_completion is not null
     or actual_output is not null
),
empty_rows as (
  select project_id from public.project_manual_updates
  where target_qty is null and unit is null and start_date is null
    and target_completion is null and actual_completion is null
    and actual_output is null
)
select
  (select count(*) from eligible)                                          as eligible_projects,
  (select count(*) from public.project_targets
     where migrated_from_project_id is not null)                           as migrated_targets,
  (select count(*) from empty_rows)                                        as all_empty_projects,
  (select count(*) from public.project_targets t
     join empty_rows e on e.project_id = t.migrated_from_project_id)       as unexpected_empty_targets,
  case
    when (select count(*) from eligible)
       = (select count(*) from public.project_targets where migrated_from_project_id is not null)
     and (select count(*) from public.project_targets t
            join empty_rows e on e.project_id = t.migrated_from_project_id) = 0
    then 'PASS' else 'FAIL' end                                            as verdict;

-- ---- 5b. EXACTLY ONE MIGRATED TARGET PER ELIGIBLE PROJECT --------

select migrated_from_project_id, count(*) as targets
from public.project_targets
where migrated_from_project_id is not null
group by migrated_from_project_id
having count(*) > 1;
-- Expect zero rows.

-- ---- 5c. FIELD-BY-FIELD COMPARISON (expect zero rows) ------------

select m.project_id,
       m.target_qty          as old_qty,          t.target_qty          as new_qty,
       m.unit                as old_unit,         t.unit                as new_unit,
       m.start_date          as old_start,        t.start_date          as new_start,
       m.target_completion   as old_due,          t.target_completion   as new_due,
       m.actual_completion   as old_finish,       t.actual_completion   as new_finish,
       m.actual_output       as old_output,       t.actual_output       as new_output,
       t.scope               as new_scope
from public.project_manual_updates m
join public.project_targets t on t.migrated_from_project_id = m.project_id
where not (
      t.target_qty        is not distinct from m.target_qty
  and t.unit              is not distinct from m.unit
  and t.start_date        is not distinct from m.start_date
  and t.target_completion is not distinct from m.target_completion
  and t.actual_completion is not distinct from m.actual_completion
  and t.actual_output     is not distinct from m.actual_output
);

-- ---- 5d. MIGRATED SCOPE MUST BE NULL (never derived from Remarks) 

select count(*) as migrated_with_scope,
       case when count(*) = 0 then 'PASS'
            else 'FAIL - scope was populated during migration' end as verdict
from public.project_targets
where migrated_from_project_id is not null and scope is not null;

-- ---- 5e. CANONICAL KEY WAS COMPUTED CORRECTLY ON EVERY ROW -------

select count(*) as mismatched,
       case when count(*) = 0 then 'PASS' else 'FAIL' end as verdict
from public.project_targets
where project_key is distinct from public.project_key(project_id);


-- ===========================================================================
-- 7. IDEMPOTENCY  --  the only section that writes, and it rolls back
-- ===========================================================================

-- ---- 7a. RE-RUNNING THE BACKFILL INSERTS NOTHING -------------------------
-- Writes, then rolls back. Raises if the guard does not hold.
do $$
declare
  v_before integer;
  v_after  integer;
begin
  select count(*) into v_before from public.project_targets;

  insert into public.project_targets (
    project_id, project_key,
    target_qty, unit, start_date, target_completion, actual_completion, actual_output,
    created_by, created_at, updated_by, updated_at, migrated_from_project_id
  )
  select m.project_id, public.project_key(m.project_id),
         m.target_qty, m.unit, m.start_date, m.target_completion, m.actual_completion, m.actual_output,
         m.updated_by, m.updated_at, m.updated_by, m.updated_at, m.project_id
  from public.project_manual_updates m
  where ( m.target_qty is not null or m.unit is not null or m.start_date is not null
       or m.target_completion is not null or m.actual_completion is not null
       or m.actual_output is not null )
    and not exists (select 1 from public.project_targets t
                    where t.migrated_from_project_id = m.project_id);

  select count(*) into v_after from public.project_targets;

  if v_after <> v_before then
    raise exception '7a FAIL - re-running the backfill inserted % row(s)', v_after - v_before;
  end if;
  raise notice '7a PASS - re-running the backfill inserted nothing (% targets)', v_after;

  raise exception 'rollback_marker_7a';   -- undo the (empty) write
exception
  when others then
    if sqlerrm = 'rollback_marker_7a' then
      raise notice '7a rolled back cleanly';
    else
      raise;
    end if;
end
$$;

-- ---- 7b. THE UNIQUE PARTIAL INDEX ALSO HOLDS ---------------------

do $$
declare
  sample text;
begin
  select migrated_from_project_id into sample
  from public.project_targets
  where migrated_from_project_id is not null
  limit 1;

  if sample is null then
    raise notice '7b SKIPPED - no migrated targets to duplicate';
    return;
  end if;

  begin
    insert into public.project_targets
      (project_id, project_key, created_by, updated_by, migrated_from_project_id)
    select project_id, project_key, created_by, updated_by, migrated_from_project_id
    from public.project_targets where migrated_from_project_id = sample;
    raise warning '7b FAIL - a duplicate migration marker was accepted for %', sample;
    raise exception 'rolling back the duplicate just inserted';
  exception
    when unique_violation then
      raise notice '7b PASS - unique partial index rejected the duplicate for %', sample;
    when others then
      raise notice '7b - rolled back (%)', sqlerrm;
  end;
end
$$;


-- ===========================================================================
-- 8. WORKBOOK REFRESH  --  targets must survive a re-import
-- ===========================================================================
-- The import replaces project_ledger_dataset only. Run this before and after a
-- workbook refresh in the application; both numbers must be identical.

-- ---- 8. TARGET COUNT AND DATASET STAMP ---------------------------

select (select count(*) from public.project_targets)                        as total_targets,
       (select count(*) from public.project_targets where archived_at is null) as live_targets,
       (select count(*) from public.project_manual_updates)                  as manual_rows,
       (select uploaded_at from public.project_ledger_dataset where id = 'current') as dataset_uploaded_at;


-- ===========================================================================
-- 14 & 15. AUDIT
-- ===========================================================================
-- Run after exercising create / multi-field edit / archive / restore in the UI.

-- ---- 14a. RECENT AUDIT ROWS --------------------------------------

select changed_at, project_id, target_id, target_scope,
       action, source, batch_id, column_name, field_key, old_value, new_value, changed_by_username
from public.project_manual_update_audit
order by changed_at desc
limit 40;

-- ---- 14b. ONE SAVE = ONE BATCH, MANY FIELD ROWS ------------------

select batch_id, action, source,
       count(*) as rows_in_batch,
       count(distinct target_id) as targets_touched,
       string_agg(distinct column_name, ', ' order by column_name) as fields
from public.project_manual_update_audit
where batch_id is not null
group by batch_id, action, source
order by max(changed_at) desc
limit 20;

-- ---- 14c. ARCHIVE AND RESTORE ARE SINGLE EVENTS ------------------

select action, batch_id, count(*) as rows_written,
       case when count(*) = 1 then 'PASS'
            else 'REVIEW - expected exactly one row per archive/restore' end as verdict
from public.project_manual_update_audit
where action in ('archive','restore')
group by action, batch_id
order by action;

-- ---- 14d. PROJECT-LEVEL EDITS MUST NOT FAN OUT ACROSS TARGETS ----

select count(*) as project_rows_with_a_target_id,
       case when count(*) = 0 then 'PASS'
            else 'FAIL - a project field was audited against a target' end as verdict
from public.project_manual_update_audit
where field_key in ('status','contract','note') and target_id is not null;

-- ---- 15. AUDIT IS REACHABLE UNDER ONE CANONICAL KEY PER PROJECT --

-- More than one distinct spelling for the same canonical key means a project's
-- history is split across two identities and the panel will only find one half.
select public.project_key(project_id) as canonical_key,
       count(distinct project_id)     as distinct_spellings,
       string_agg(distinct project_id, ' | ') as spellings
from public.project_manual_update_audit
group by public.project_key(project_id)
having count(distinct project_id) > 1;
-- Expect zero rows.


-- ===========================================================================
-- 17. RLS AND GRANTS
-- ===========================================================================

-- ---- 17a. RLS ENABLED --------------------------------------------

select relname, relrowsecurity, relforcerowsecurity,
       case when relrowsecurity then 'PASS' else 'BLOCKER - table is readable by anyone' end as verdict
from pg_class
where oid = 'public.project_targets'::regclass;

-- ---- 17b. POLICIES -----------------------------------------------

select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'project_targets'
order by cmd, policyname;

-- Expect three policies, all `to authenticated`: SELECT using true;
-- INSERT with check auth.uid() = created_by; UPDATE using true with check
-- auth.uid() = updated_by. No policy should name anon or public.

-- ---- 17c. GRANTS  --  anon must have none, authenticated must not have DELETE 

select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'project_targets'
group by grantee
order by grantee;

select
  coalesce(bool_or(grantee = 'anon'), false)                                as anon_has_grants,
  coalesce(bool_or(grantee = 'authenticated' and privilege_type = 'DELETE'), false)
                                                                            as authenticated_can_delete,
  case
    when coalesce(bool_or(grantee = 'anon'), false) then 'FAIL - anon holds a grant'
    when coalesce(bool_or(grantee = 'authenticated' and privilege_type = 'DELETE'), false)
      then 'FAIL - DELETE is granted; archive is the intended behaviour'
    else 'PASS'
  end                                                                       as verdict
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'project_targets';

-- ---- 17d. ARCHIVED TARGETS ARE STILL PRESENT, NOT DELETED --------

select count(*) filter (where archived_at is null)     as live,
       count(*) filter (where archived_at is not null) as archived,
       count(*) filter (where archived_at is not null and archived_by is null)
                                                       as archived_without_a_user
from public.project_targets;


-- ===========================================================================
-- 12. TRANSACTION ROLLBACK  --  the atomic save functions
--     Requires 20260814000000_project_target_rpc.sql
-- ===========================================================================
-- These tests write. Every one of them raises a sentinel at the end so the
-- surrounding block unwinds and nothing is left behind. Run them on a branch
-- or staging database.
--
-- The functions are SECURITY INVOKER and read the actor from auth.uid(), so a
-- plain SQL session is not signed in and every call would be refused. Each
-- test therefore impersonates a real user the way PostgREST does, by setting
-- request.jwt.claims for the duration of the transaction.
--
-- Each block reports PASS via a notice, or raises with what went wrong.

-- ---- 12 PREFLIGHT: is there a user and a project to test with? ----

select
  (select count(*) from auth.users)                as users_available,
  (select count(*) from public.project_targets)    as targets_available,
  case
    when (select count(*) from auth.users) = 0
      then 'CANNOT RUN - no auth user to impersonate'
    else 'READY'
  end                                              as verdict;


-- ---- 12a. SUCCESSFUL CREATE, then rolled back --------------------
do $$
declare
  v_uid     uuid;
  v_project text := 'VERIFY-TARGET-RPC-12A';
  v_id      uuid;
  v_events  integer;
  v_fields  integer;
begin
  select id into v_uid from auth.users limit 1;
  if v_uid is null then raise notice '12a SKIPPED - no auth user'; return; end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_id := public.create_project_target(
    v_project, 'Verification scope', 100, 'meters',
    '2026-01-01'::date, '2026-06-01'::date, null, 10, null);

  if v_id is null then raise exception '12a FAIL - no target id returned'; end if;

  select count(*) filter (where action = 'create' and field_key = 'target'),
         count(*) filter (where action = 'create' and field_key <> 'target')
    into v_events, v_fields
  from public.project_manual_update_audit where target_id = v_id;

  if v_events <> 1 then
    raise exception '12a FAIL - expected 1 creation event, found %', v_events;
  end if;
  if v_fields <> 6 then
    raise exception '12a FAIL - expected 6 field rows (scope, qty, unit, start, due, output), found %', v_fields;
  end if;
  if (select count(distinct batch_id) from public.project_manual_update_audit where target_id = v_id) <> 1 then
    raise exception '12a FAIL - creation rows do not share one batch_id';
  end if;

  raise notice '12a PASS - target and % audit rows created in one transaction', v_events + v_fields;
  raise exception 'rollback_12a';
exception
  when others then
    if sqlerrm = 'rollback_12a' then raise notice '12a rolled back'; else raise; end if;
end
$$;


-- ---- 12b. FORCED AUDIT FAILURE ON CREATE  ->  nothing created ----
-- A trigger makes the audit insert fail after the target row has been written.
-- If the function were not transactional, the target would survive.
do $$
declare
  v_uid     uuid;
  v_project text := 'VERIFY-TARGET-RPC-12B';
  v_left    integer;
  v_audit   integer;
begin
  select id into v_uid from auth.users limit 1;
  if v_uid is null then raise notice '12b SKIPPED - no auth user'; return; end if;

  create or replace function pg_temp.break_audit() returns trigger
    language plpgsql as $t$ begin raise exception 'forced audit failure'; end $t$;
  create trigger zzz_break_audit before insert on public.project_manual_update_audit
    for each row execute function pg_temp.break_audit();

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    perform public.create_project_target(v_project, 'Should not survive', 5, 'm', null, null, null, null, null);
    raise exception '12b FAIL - the create succeeded despite a failing audit insert';
  exception
    when others then
      if sqlerrm = 'forced audit failure' then
        raise notice '12b - audit insert failed as intended';
      elsif sqlerrm like '12b FAIL%' then
        raise;
      else
        raise notice '12b - call aborted (%)', sqlerrm;
      end if;
  end;

  perform set_config('role', 'none', true);
  reset role;

  select count(*) into v_left from public.project_targets where project_id = v_project;
  select count(*) into v_audit from public.project_manual_update_audit where project_id = v_project;

  if v_left <> 0 then
    raise exception '12b FAIL - % orphaned target row(s) survived the failed audit', v_left;
  end if;
  if v_audit <> 0 then
    raise exception '12b FAIL - % audit row(s) survived', v_audit;
  end if;

  raise notice '12b PASS - target and audit both rolled back; nothing partially created';
  raise exception 'rollback_12b';
exception
  when others then
    if sqlerrm = 'rollback_12b' then raise notice '12b rolled back'; else raise; end if;
end
$$;


-- ---- 12c. MULTI-FIELD UPDATE  ->  one row per field, one batch ----
do $$
declare
  v_uid     uuid;
  v_project text;
  v_target  uuid;
  v_changed integer;
  v_rows    integer;
  v_batches integer;
begin
  select id into v_uid from auth.users limit 1;
  select id, project_id into v_target, v_project
  from public.project_targets where archived_at is null limit 1;

  if v_uid is null or v_target is null then
    raise notice '12c SKIPPED - needs an auth user and at least one live target';
    return;
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- four fields changed at once
  v_changed := public.update_project_target(
    v_target, v_project,
    'Verification scope 12c', 4321, 'verify-unit',
    '2026-02-02'::date, '2026-11-11'::date, null, 99, null);

  perform set_config('role', 'none', true);
  reset role;

  if v_changed < 1 then
    raise exception '12c FAIL - update reported no changed fields';
  end if;

  select count(*), count(distinct batch_id) into v_rows, v_batches
  from public.project_manual_update_audit
  where target_id = v_target and action = 'update'
    and changed_at >= now() - interval '1 minute';

  if v_rows <> v_changed then
    raise exception '12c FAIL - % fields changed but % audit rows written', v_changed, v_rows;
  end if;
  if v_batches <> 1 then
    raise exception '12c FAIL - audit rows span % batches, expected 1', v_batches;
  end if;

  raise notice '12c PASS - % changed fields, % audit rows, 1 batch_id', v_changed, v_rows;
  raise exception 'rollback_12c';
exception
  when others then
    if sqlerrm = 'rollback_12c' then raise notice '12c rolled back'; else raise; end if;
end
$$;


-- ---- 12d. FORCED AUDIT FAILURE ON UPDATE  ->  target unchanged ----
do $$
declare
  v_uid     uuid;
  v_project text;
  v_target  uuid;
  v_before  numeric;
  v_after   numeric;
begin
  select id into v_uid from auth.users limit 1;
  select id, project_id, target_qty into v_target, v_project, v_before
  from public.project_targets where archived_at is null limit 1;

  if v_uid is null or v_target is null then
    raise notice '12d SKIPPED - needs an auth user and at least one live target';
    return;
  end if;

  create or replace function pg_temp.break_audit2() returns trigger
    language plpgsql as $t$ begin raise exception 'forced audit failure'; end $t$;
  create trigger zzz_break_audit2 before insert on public.project_manual_update_audit
    for each row execute function pg_temp.break_audit2();

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    perform public.update_project_target(v_target, v_project, 'Should not persist', 77777, null,
                                         null, null, null, null, null);
    raise exception '12d FAIL - the update succeeded despite a failing audit insert';
  exception
    when others then
      if sqlerrm like '12d FAIL%' then raise; end if;
      raise notice '12d - call aborted as intended (%)', sqlerrm;
  end;

  perform set_config('role', 'none', true);
  reset role;

  select target_qty into v_after from public.project_targets where id = v_target;
  if v_after is distinct from v_before then
    raise exception '12d FAIL - target_qty changed from % to % despite the failed audit', v_before, v_after;
  end if;

  raise notice '12d PASS - target update rolled back with its audit';
  raise exception 'rollback_12d';
exception
  when others then
    if sqlerrm = 'rollback_12d' then raise notice '12d rolled back'; else raise; end if;
end
$$;


-- ---- 12e. ARCHIVE AND RESTORE  ->  state and event commit together ----
do $$
declare
  v_uid     uuid;
  v_project text;
  v_target  uuid;
  v_ok      boolean;
  v_events  integer;
begin
  select id into v_uid from auth.users limit 1;
  select id, project_id into v_target, v_project
  from public.project_targets where archived_at is null limit 1;

  if v_uid is null or v_target is null then
    raise notice '12e SKIPPED - needs an auth user and at least one live target';
    return;
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  v_ok := public.set_project_target_archived(v_target, v_project, true, null);
  if not v_ok then raise exception '12e FAIL - archive reported no change'; end if;

  if (select archived_at from public.project_targets where id = v_target) is null then
    raise exception '12e FAIL - archived_at was not set';
  end if;
  if (select archived_by from public.project_targets where id = v_target) is null then
    raise exception '12e FAIL - archived_by was not set';
  end if;

  select count(*) into v_events from public.project_manual_update_audit
  where target_id = v_target and action = 'archive' and changed_at >= now() - interval '1 minute';
  if v_events <> 1 then
    raise exception '12e FAIL - expected exactly 1 archive event, found %', v_events;
  end if;

  -- archiving again is a no-op, not an error and not a second event
  if public.set_project_target_archived(v_target, v_project, true, null) then
    raise exception '12e FAIL - archiving an archived target reported a change';
  end if;

  v_ok := public.set_project_target_archived(v_target, v_project, false, null);
  if not v_ok then raise exception '12e FAIL - restore reported no change'; end if;
  if (select archived_at from public.project_targets where id = v_target) is not null then
    raise exception '12e FAIL - archived_at was not cleared on restore';
  end if;

  select count(*) into v_events from public.project_manual_update_audit
  where target_id = v_target and action = 'restore' and changed_at >= now() - interval '1 minute';
  if v_events <> 1 then
    raise exception '12e FAIL - expected exactly 1 restore event, found %', v_events;
  end if;

  perform set_config('role', 'none', true);
  reset role;

  raise notice '12e PASS - archive and restore each commit one event, and are idempotent';
  raise exception 'rollback_12e';
exception
  when others then
    if sqlerrm = 'rollback_12e' then raise notice '12e rolled back'; else raise; end if;
end
$$;


-- ---- 12f. GUARDS: wrong project, missing target, archived edit ----
do $$
declare
  v_uid    uuid;
  v_target uuid;
  v_caught integer := 0;
begin
  select id into v_uid from auth.users limit 1;
  select id into v_target from public.project_targets where archived_at is null limit 1;
  if v_uid is null or v_target is null then
    raise notice '12f SKIPPED - needs an auth user and at least one live target';
    return;
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    perform public.update_project_target(v_target, 'DEFINITELY-NOT-THIS-PROJECT', 'x',
                                         null, null, null, null, null, null, null);
    raise notice '12f FAIL - an update against the wrong project was accepted';
  exception when others then
    if sqlerrm like '%different project%' then v_caught := v_caught + 1; else raise; end if;
  end;

  begin
    perform public.update_project_target(gen_random_uuid(), 'ANY', 'x',
                                         null, null, null, null, null, null, null);
    raise notice '12f FAIL - an update against a missing target was accepted';
  exception when others then
    if sqlerrm like '%no longer exists%' then v_caught := v_caught + 1; else raise; end if;
  end;

  begin
    perform public.create_project_target('ANY-PROJECT', '   ', null, null, null, null, null, null, null);
    raise notice '12f FAIL - a target with a blank scope was created';
  exception when others then
    if sqlerrm like '%Scope is required%' then v_caught := v_caught + 1; else raise; end if;
  end;

  perform set_config('role', 'none', true);
  reset role;

  if v_caught <> 3 then
    raise exception '12f FAIL - only % of 3 guards fired', v_caught;
  end if;
  raise notice '12f PASS - wrong project, missing target and blank scope all refused';
  raise exception 'rollback_12f';
exception
  when others then
    if sqlerrm = 'rollback_12f' then raise notice '12f rolled back'; else raise; end if;
end
$$;


-- ---- 12g. FUNCTION PRIVILEGES  --  anon must not execute ----------

select p.proname,
       p.prosecdef                              as security_definer,
       pg_get_function_identity_arguments(p.oid) as arguments,
       coalesce(array_to_string(p.proacl, ' | '), 'default (PUBLIC)') as acl,
       case
         when has_function_privilege('anon', p.oid, 'execute')
           then 'FAIL - anon can execute'
         when p.prosecdef
           then 'REVIEW - SECURITY DEFINER'
         when not has_function_privilege('authenticated', p.oid, 'execute')
           then 'FAIL - authenticated cannot execute'
         else 'PASS'
       end                                      as verdict
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_project_target','update_project_target',
                    'set_project_target_archived','project_audit_id','project_key')
order by p.proname;


-- ---- 12h. LEGACY ROWS THAT WOULD FAIL THE NEW CHECK CONSTRAINTS ----
-- The constraints were added NOT VALID so they apply going forward without
-- failing the migration on old data. These are the rows to correct before
-- running VALIDATE CONSTRAINT.

select id, project_id, scope, target_qty, actual_output,
       start_date, target_completion, actual_completion,
       case
         when target_qty < 0 then 'negative target_qty'
         when actual_output < 0 then 'negative actual_output'
         when target_completion < start_date then 'target completion before start'
         when actual_completion < start_date then 'actual completion before start'
       end as violation
from public.project_targets
where target_qty < 0
   or actual_output < 0
   or (start_date is not null and target_completion is not null and target_completion < start_date)
   or (start_date is not null and actual_completion is not null and actual_completion < start_date);
-- Expect zero rows. If any appear, correct them and then:
--   alter table public.project_targets validate constraint project_targets_qty_non_negative;
--   ... and the other three.


-- ---- VERIFICATION SCRIPT COMPLETE --------------------------------
