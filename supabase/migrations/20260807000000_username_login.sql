-- Usernames are aliases for Supabase Auth email accounts.
-- Password verification remains handled by Supabase Auth.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now(),
  constraint profiles_username_format
    check (username = lower(username) and username ~ '^[a-z0-9][a-z0-9._-]{2,31}$')
);

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "Users can update their own username" on public.profiles;
create policy "Users can update their own username"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- This function is intentionally the only anonymous lookup path. The profiles
-- table itself remains protected by RLS; the client receives the Auth email
-- only long enough to call signInWithPassword.
create or replace function public.get_login_email(p_username text)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.email
  from auth.users as u
  join public.profiles as p on p.id = u.id
  where p.username = lower(trim(p_username))
  limit 1;
$$;

revoke all on function public.get_login_email(text) from public;
grant execute on function public.get_login_email(text) to anon, authenticated;

-- Give accounts created later a usable temporary username. The administrator
-- can replace it from the Supabase dashboard with the intended username.
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    'user-' || substr(replace(new.id::text, '-', ''), 1, 8)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.create_profile_for_new_user();

-- Create initial usernames for accounts that already exist. The email's local
-- part is used when possible; duplicate/invalid values receive a unique alias.
insert into public.profiles (id, username)
select u.id,
       case
         when b.clean_name is not null and row_number() over (
           partition by b.clean_name order by u.created_at, u.id
         ) = 1 then b.clean_name
         when b.clean_name is not null then
           left(b.clean_name, 23) || '-' ||
           substr(replace(u.id::text, '-', ''), 1, 8)
         else 'user-' || substr(replace(u.id::text, '-', ''), 1, 8)
       end
from auth.users as u
cross join lateral (
  select nullif(
    left(trim(both '-' from regexp_replace(
      lower(split_part(coalesce(u.email, ''), '@', 1)),
      '[^a-z0-9._-]+', '-', 'g'
    )), 32), ''
  ) as clean_name
) as b
on conflict (id) do nothing;

