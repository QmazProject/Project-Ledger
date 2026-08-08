-- Server-side password recovery rate limit.
-- The lookup function is callable only by the Edge Function's service role;
-- the browser never receives username existence or email information.
create table if not exists public.password_recovery_attempts (
  username text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until timestamptz
);

alter table public.password_recovery_attempts enable row level security;

create or replace function public.consume_password_recovery(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_username text := lower(trim(coalesce(p_username, '')));
  v_attempts integer := 0;
  v_window_started timestamptz := now();
  v_locked_until timestamptz;
  v_email text;
begin
  if v_username = '' or not exists (
    select 1 from public.profiles where username = v_username
  ) then
    return jsonb_build_object('allowed', false);
  end if;

  select attempts, window_started_at, locked_until
    into v_attempts, v_window_started, v_locked_until
  from public.password_recovery_attempts
  where username = v_username
  for update;

  if not found then
    insert into public.password_recovery_attempts (username)
    values (v_username)
    on conflict (username) do nothing;
    select attempts, window_started_at, locked_until
      into v_attempts, v_window_started, v_locked_until
    from public.password_recovery_attempts
    where username = v_username
    for update;
  end if;

  if v_locked_until is not null and v_locked_until > now() then
    return jsonb_build_object('allowed', false);
  end if;

  if v_window_started + interval '15 minutes' <= now() then
    v_attempts := 0;
    v_window_started := now();
  end if;

  if v_attempts >= 2 then
    update public.password_recovery_attempts
      set locked_until = now() + interval '15 minutes'
      where username = v_username;
    return jsonb_build_object('allowed', false);
  end if;

  select u.email into v_email
  from auth.users as u
  join public.profiles as p on p.id = u.id
  where p.username = v_username
  limit 1;

  update public.password_recovery_attempts
    set attempts = v_attempts + 1,
        window_started_at = v_window_started,
        locked_until = null
    where username = v_username;

  return jsonb_build_object('allowed', true, 'email', v_email);
end;
$$;

revoke all on function public.consume_password_recovery(text) from public;
grant execute on function public.consume_password_recovery(text) to service_role;
