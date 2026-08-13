-- ===========================================================================
-- Runbook: destroying test targets and their audit trail
--   migration 20260823000000_project_target_purge.sql
--
-- Run as service_role (Supabase dashboard > SQL editor) or as the database
-- owner via psql. `authenticated` cannot execute either function, by design.
--
-- Sections 0-2 are read-only. Section 3 rehearses the purge inside a
-- transaction it rolls back. Section 4 is the only part that destroys
-- anything. Section 6 is how to undo a mistake.
--
-- Work one target at a time. There is no bulk form on purpose: a wrong UUID in
-- a loop is a wrong UUID applied N times before anybody reads the output.
-- ===========================================================================


-- ---- 0. WHICH DATABASE AM I ON ------------------------------------------
-- Answer this before anything else. The whole point of the section order is
-- lost if section 4 runs on production because the tab was left open.

select current_database()                    as database,
       current_user                          as role,
       (select count(*) from public.project_targets)               as targets_total,
       (select count(*) from public.project_manual_update_audit)   as audit_rows_total;


-- ---- 1. FIND THE TEST TARGETS -------------------------------------------
-- Test input is normally a draft: a Balance Work name typed to see what the
-- panel does, with no quantity and no completion date. Those are exactly the
-- rows that used to be miscounted by the Targets filter, and exactly the rows
-- archiving only hides.

select t.id                       as target_id,
       t.project_id,
       t.scope,
       t.target_qty,
       t.target_completion,
       t.actual_output,
       t.archived_at,
       t.created_at,
       p.username                 as created_by,
       (select count(*) from public.project_manual_update_audit a
         where a.target_id = t.id) as audit_rows
from public.project_targets t
left join public.profiles p on p.id = t.created_by
where t.target_qty is null
  and t.target_completion is null      -- drafts: nothing measurable was entered
  and t.migrated_from_project_id is null  -- never touch a backfilled target
order by t.created_at desc;

-- Narrow further if the test rows are recognisable by name or by when they
-- were typed. Adjust and re-run; do not guess a UUID.
--
--   and t.scope ilike '%test%'
--   and t.created_at >= '2026-08-01'
--   and t.project_id = 'QMB-001'


-- ---- 2. PREVIEW ONE TARGET ----------------------------------------------
-- A UUID carries nothing that tells you it is the wrong UUID. This is the step
-- that does. Read `scope` and `project_id` back and confirm they are what you
-- meant before going any further.

select * from public.preview_project_target_purge('00000000-0000-0000-0000-000000000000'::uuid);

-- has_recorded_delivery = true means somebody entered an actual output or a
-- completion date against it. That is not test input. Stop and re-check the
-- UUID; purge_project_target() will refuse it unless forced.


-- ---- 3. REHEARSE (destroys nothing) -------------------------------------
-- Runs the real function and then throws the result away. Use this on
-- production too: it proves the target resolves, the reason is accepted and
-- the row counts are what you expect, without keeping any of it.

begin;

select * from public.purge_project_target(
  '00000000-0000-0000-0000-000000000000'::uuid,
  'rehearsal'
);

-- Should return zero rows: both the target and its audit rows are gone
-- inside this transaction.
select count(*) as target_still_there
  from public.project_targets
 where id = '00000000-0000-0000-0000-000000000000'::uuid;

rollback;   -- <= everything above is undone. Confirm this actually ran.

-- Prove the rollback worked before continuing:
select count(*) as target_restored
  from public.project_targets
 where id = '00000000-0000-0000-0000-000000000000'::uuid;   -- expect 1


-- ---- 4. PURGE (permanent) -----------------------------------------------
-- Deletes the audit rows belonging to this target, then the target. Both are
-- copied into project_target_purge_log first. The reason is stored and is not
-- optional - it is the only explanation that survives.

select * from public.purge_project_target(
  '00000000-0000-0000-0000-000000000000'::uuid,
  'test input entered while checking the Manage Targets modal on 2026-08-13'
);

-- Only if the target legitimately carries an actual output and you are certain
-- it is still test data:
--
-- select * from public.purge_project_target(
--   '00000000-0000-0000-0000-000000000000'::uuid,
--   'test input, had an actual output typed into it',
--   p_force => true
-- );


-- ---- 5. VERIFY -----------------------------------------------------------

-- The target and its audit rows are gone.
select (select count(*) from public.project_targets
         where id = '00000000-0000-0000-0000-000000000000'::uuid)      as target_rows,      -- expect 0
       (select count(*) from public.project_manual_update_audit
         where target_id = '00000000-0000-0000-0000-000000000000'::uuid) as audit_rows;     -- expect 0

-- Project-level history for the SAME project is untouched. This is the check
-- that matters: Status, Contract, Remarks and every Excel-updated row carry a
-- null target_id and were never in scope.
select a.project_id,
       a.column_name,
       count(*) as rows_remaining
from public.project_manual_update_audit a
where a.project_id = 'QMB-001'    -- the purged target's project
  and a.target_id is null
group by a.project_id, a.column_name
order by a.column_name;

-- What was destroyed, and why.
select id, purged_at, purged_by, project_id, target_scope, audit_rows_deleted, reason
from public.project_target_purge_log
order by purged_at desc
limit 20;


-- ---- 6. UNDO A MISTAKE ---------------------------------------------------
-- The purge log holds both deleted rows verbatim. Restoring the target first
-- is mandatory: the audit rows reference it.
--
-- Read it before restoring anything:
--
--   select payload -> 'target'  as target,
--          payload -> 'audit'   as audit_rows
--   from public.project_target_purge_log where id = <log id>;
--
-- Then, inside a transaction you can still roll back:
--
-- begin;
--
-- insert into public.project_targets
-- select * from jsonb_populate_record(
--   null::public.project_targets,
--   (select payload -> 'target' from public.project_target_purge_log where id = <log id>)
-- );
--
-- insert into public.project_manual_update_audit
-- select * from jsonb_populate_recordset(
--   null::public.project_manual_update_audit,
--   (select payload -> 'audit' from public.project_target_purge_log where id = <log id>)
-- );
--
-- -- check it looks right, THEN commit
-- select * from public.preview_project_target_purge('<target uuid>'::uuid);
-- commit;
--
-- The audit id column is `generated by default as identity`, not `always`, so
-- the original ids are reinserted as they were rather than renumbered.


-- ===========================================================================
-- 7. ADMIN DELETION PATH  --  migration 20260824000000
--
-- Administrators can now delete targets and manual audit entries from inside
-- the panel. The controls are hidden from non-admins in the browser, but a
-- hidden button is not access control: what actually stops a non-admin is the
-- check inside each function. These queries prove that check is in place.
-- ===========================================================================

-- ---- 7a. WHO CAN DO THIS ------------------------------------------------
-- Every account that can now destroy audit history. Read this list before
-- assuming the capability is narrow.

select p.username, p.role, u.email, u.last_sign_in_at
from public.profiles p
join auth.users u on u.id = p.id
where p.role = 'admin'
order by p.username;


-- ---- 7b. THE GRANTS ARE WHAT THEY SHOULD BE ------------------------------
-- Expect: EXECUTE granted to `authenticated` on both admin functions (the role
-- a signed-in admin holds; the admin test happens inside), and NO direct DELETE
-- on either table for anon or authenticated.

select p.proname                                    as function,
       pg_get_userbyid(p.proowner)                  as owner,
       p.prosecdef                                  as security_definer,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_call,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_can_call
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('admin_delete_project_target', 'admin_delete_audit_entries',
                    'purge_project_target', 'is_project_admin')
order by p.proname;
-- anon_can_call must be false on every row.

select t.relname                                              as table_name,
       has_table_privilege('authenticated', t.oid, 'DELETE')  as authenticated_delete,
       has_table_privilege('anon', t.oid, 'DELETE')           as anon_delete
from pg_class t
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and t.relname in ('project_targets', 'project_manual_update_audit');
-- Both columns must be false on both rows. If authenticated_delete is true,
-- the API accepts a direct DELETE and the function checks can be bypassed.


-- ---- 7c. A NON-ADMIN IS REFUSED -----------------------------------------
-- Run in the SQL editor, which is service_role, so the role has to be
-- impersonated. Rolls itself back either way.

begin;

set local role authenticated;
set local request.jwt.claims = '{"sub":"<uuid of a NON-admin user>","role":"authenticated"}';

select public.is_project_admin();   -- expect false

-- Expect: ERROR "Only an administrator can permanently delete a target."
select * from public.admin_delete_project_target(
  '00000000-0000-0000-0000-000000000000'::uuid,
  'should never succeed'
);

rollback;

-- A direct DELETE must be refused too, independently of the functions:
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<uuid of any user>","role":"authenticated"}';
delete from public.project_manual_update_audit where id = -1;  -- expect permission denied
rollback;


-- ---- 7d. WHAT ADMINS HAVE DELETED ---------------------------------------
-- Review periodically. This is the record that replaces the rows themselves.

select purged_at, purged_by_username, project_id, target_scope,
       audit_rows_deleted, reason
from public.project_target_purge_log
order by purged_at desc
limit 50;

select purged_at, purged_by_username, project_id, column_name, reason
from public.project_audit_purge_log
order by purged_at desc
limit 50;

-- Recovering a deleted audit entry (the row is held verbatim in payload):
--
--   insert into public.project_manual_update_audit
--   select * from jsonb_populate_record(
--     null::public.project_manual_update_audit,
--     (select payload from public.project_audit_purge_log where id = <log id>)
--   );
