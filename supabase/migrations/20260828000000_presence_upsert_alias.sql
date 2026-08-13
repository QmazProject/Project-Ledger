-- Hardening: name the conflict target through an explicit alias.
--
-- Not a reported failure. It is the same class of mistake as the one fixed in
-- 20260827000000 — SQL that parses and is only exercised at call time — found by
-- re-reading the functions written alongside it, and it is fixed rather than
-- left because of how it would fail if it were wrong.
--
-- record_ledger_presence() referred to the pre-existing row in its ON CONFLICT
-- DO UPDATE as `public.project_ledger_presence.last_seen_at`. PostgreSQL exposes
-- that row under the table's name, and a three-part schema.table.column
-- reference is normally fine, but this function also runs with `search_path`
-- pinned to '' and the qualified form is the arrangement least covered by the
-- documented behaviour. The documented, unambiguous form is an alias on the
-- INSERT target, so that is what it now uses:
--
--     insert into public.project_ledger_presence as presence ...
--     on conflict (user_id) do update set ... presence.last_seen_at ...
--
-- Why this is worth a migration rather than a note: the heartbeat's caller
-- deliberately ignores errors, because a failed heartbeat is not something the
-- user can act on and should not put a message on their screen. That is the
-- right behaviour for a heartbeat and the wrong behaviour for discovering it
-- never worked — presence would simply stay empty, and an administrator would
-- read "nobody is signed in" as an answer. Silent is the one failure mode worth
-- pre-empting.
--
-- Behaviour is unchanged: same upsert, same visit-restart rule, same identity
-- taken from auth.uid().

create or replace function public.record_ledger_presence()
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
    return;   -- not signed in: no presence, and not an error worth raising
  end if;

  select p.username into v_username from public.profiles p where p.id = v_uid;

  insert into public.project_ledger_presence as presence
    (user_id, username, first_seen_at, last_seen_at)
  values (v_uid, coalesce(v_username, 'Unknown user'), now(), now())
  on conflict (user_id) do update
    set last_seen_at = now(),
        -- Re-arriving after an absence starts a new visit, so "open since"
        -- means this visit rather than the first time they ever opened it.
        first_seen_at = case
          when presence.last_seen_at < now() - interval '5 minutes'
          then now()
          else presence.first_seen_at
        end,
        username = coalesce(v_username, presence.username);
end;
$$;

comment on function public.record_ledger_presence() is
  'Records that the calling user has the panel open. Identity is read from auth.uid() and the display name from profiles, so neither can be supplied by the browser. Safe to call repeatedly; it is an upsert of one row.';

revoke all on function public.record_ledger_presence() from public, anon;
grant execute on function public.record_ledger_presence() to authenticated;
