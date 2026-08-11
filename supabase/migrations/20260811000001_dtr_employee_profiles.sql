-- Normalized identity records for the login-free DTR employee roster.
-- The larger roster JSON remains the source for signatures, passcodes, photos, and DTR settings.
create table if not exists public.dtr_employee_profiles (
  employee_id text primary key,
  name text not null default '',
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.dtr_employee_profiles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists dtr_employee_profiles_touch_updated_at on public.dtr_employee_profiles;
create trigger dtr_employee_profiles_touch_updated_at
before update on public.dtr_employee_profiles
for each row execute function public.dtr_employee_profiles_touch_updated_at();

alter table public.dtr_employee_profiles enable row level security;

drop policy if exists "DTR profiles can be read publicly" on public.dtr_employee_profiles;
create policy "DTR profiles can be read publicly"
  on public.dtr_employee_profiles for select
  to anon, authenticated
  using (true);

drop policy if exists "DTR profiles can be created publicly" on public.dtr_employee_profiles;
create policy "DTR profiles can be created publicly"
  on public.dtr_employee_profiles for insert
  to anon, authenticated
  with check (employee_id <> '' and role in ('admin', 'viewer'));

drop policy if exists "DTR profiles can be updated publicly" on public.dtr_employee_profiles;
create policy "DTR profiles can be updated publicly"
  on public.dtr_employee_profiles for update
  to anon, authenticated
  using (true)
  with check (employee_id <> '' and role in ('admin', 'viewer'));

drop policy if exists "DTR profiles can be removed publicly" on public.dtr_employee_profiles;
create policy "DTR profiles can be removed publicly"
  on public.dtr_employee_profiles for delete
  to anon, authenticated
  using (true);

grant select, insert, update, delete on public.dtr_employee_profiles to anon, authenticated;
