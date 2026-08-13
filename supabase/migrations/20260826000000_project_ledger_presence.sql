-- Who currently has the Project Ledger open.
--
-- Deliberately a heartbeat table rather than Supabase Realtime presence. Realtime
-- would be less code, but it has to be enabled on the project, and if it is not,
-- this feature fails by showing an empty list - which an administrator reads as
-- "nobody is in the system" rather than as "this is broken". A table uses only
-- what the rest of the panel already uses (PostgREST, RLS, security-invoker
-- RPCs), and when something is wrong the query errors and the header can say so.
--
-- One row per user, not per tab: the question is which people are in the system,
-- so three tabs open by one person is one presence.
--
-- Nobody is ever deleted from here by the browser closing. A tab that crashes,
-- a laptop that sleeps and a network that drops all look identical from the
-- server, and a "goodbye" message sent during unload is unreliable in every
-- browser. So presence expires instead: a row counts as present only while its
-- heartbeat is recent, and a stale row is simply not returned.

create table if not exists public.project_ledger_presence (
  -- The user, not the session. A second tab updates this same row.
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- Denormalised the same way project_manual_update_audit.changed_by_username
  -- is, so the header does not need a join to profiles on every poll.
  username text not null,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists project_ledger_presence_last_seen_idx
  on public.project_ledger_presence (last_seen_at desc);

comment on table public.project_ledger_presence is
  'Heartbeat, one row per signed-in user with the panel open. Rows are never deleted on sign-out being missed: presence expires by age instead. Written only through record_ledger_presence(), which reads the actor from auth.uid(); readable only by administrators.';

alter table public.project_ledger_presence enable row level security;

-- Readable by administrators only. This says where every colleague is and when,
-- which is not something the whole company needs; the people who act on it are
-- the ones who already hold user management.
drop policy if exists "Admins can read presence" on public.project_ledger_presence;
create policy "Admins can read presence"
  on public.project_ledger_presence for select
  to authenticated
  using (public.is_project_admin());

-- No insert or update policy on purpose. Writing goes through the function
-- below, so a user cannot appear under somebody else's name, cannot backdate
-- another user's heartbeat, and cannot write a row at all except their own.
revoke all on public.project_ledger_presence from anon, authenticated;
grant select on public.project_ledger_presence to authenticated;

-- ---------------------------------------------------------------------------
-- Heartbeat
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because `authenticated` deliberately holds no INSERT or
-- UPDATE on the table: the only way to write a presence row is through here,
-- and here the identity comes from auth.uid() and the name from profiles. The
-- browser supplies nothing, so there is nothing for it to falsify.
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

  insert into public.project_ledger_presence (user_id, username, first_seen_at, last_seen_at)
  values (v_uid, coalesce(v_username, 'Unknown user'), now(), now())
  on conflict (user_id) do update
    set last_seen_at = now(),
        -- Re-arriving after an absence starts a new visit, so "open since"
        -- means this visit rather than the first time they ever opened it.
        first_seen_at = case
          when public.project_ledger_presence.last_seen_at < now() - interval '5 minutes'
          then now()
          else public.project_ledger_presence.first_seen_at
        end,
        username = coalesce(v_username, public.project_ledger_presence.username);
end;
$$;

comment on function public.record_ledger_presence() is
  'Records that the calling user has the panel open. Identity is read from auth.uid() and the display name from profiles, so neither can be supplied by the browser. Safe to call repeatedly; it is an upsert of one row.';

-- ---------------------------------------------------------------------------
-- Sign-out
-- ---------------------------------------------------------------------------
-- Best effort only. An explicit sign-out can say so, but a closed tab cannot,
-- which is why the read below never trusts a row's continued existence.
create or replace function public.clear_ledger_presence()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.project_ledger_presence where user_id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Read
-- ---------------------------------------------------------------------------
-- Filtered with the database's now(), not the browser's. A client-side cutoff
-- would be wrong by whatever the reader's clock is wrong by, and a laptop an
-- hour fast would report the whole company as offline.
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
  if not public.is_project_admin() then
    raise exception 'Only an administrator can see who is signed in.';
  end if;

  return query
  select p.user_id, p.username, p.first_seen_at, p.last_seen_at,
         extract(epoch from (now() - p.last_seen_at))::integer
  from public.project_ledger_presence p
  where p.last_seen_at > now() - make_interval(secs => greatest(p_within_seconds, 30))
  order by p.username;
end;
$$;

comment on function public.list_ledger_presence(integer) is
  'Users whose heartbeat is newer than p_within_seconds. Administrators only. The cutoff uses the database clock, so a reader with a wrong system clock cannot change the answer.';

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.record_ledger_presence() from public, anon;
revoke all on function public.clear_ledger_presence() from public, anon;
revoke all on function public.list_ledger_presence(integer) from public, anon;

grant execute on function public.record_ledger_presence() to authenticated;
grant execute on function public.clear_ledger_presence() to authenticated;
grant execute on function public.list_ledger_presence(integer) to authenticated;
