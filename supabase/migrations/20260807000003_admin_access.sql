-- Roles and temporary-password state for the admin user-management workflow.
alter table public.profiles
  add column if not exists role text not null default 'user',
  add column if not exists force_password_change boolean not null default false;

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check check (role in ('user', 'admin'));

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
  on public.profiles for select
  to authenticated
  using ((select auth.uid()) = id or role = 'admin');

-- Set the initial administrator after the intended account exists:
-- update public.profiles set role = 'admin' where username = 'admin';

revoke update on public.profiles from authenticated;
grant update (username) on public.profiles to authenticated;

create or replace function public.complete_password_change()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set force_password_change = false
  where id = (select auth.uid());
$$;

revoke all on function public.complete_password_change() from public;
grant execute on function public.complete_password_change() to authenticated;
