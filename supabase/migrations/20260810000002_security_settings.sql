-- Global application security settings controlled by administrators.
create table if not exists public.security_settings (
  id integer primary key check (id = 1),
  captcha_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

insert into public.security_settings (id, captcha_enabled)
values (1, true)
on conflict (id) do nothing;

alter table public.security_settings enable row level security;

drop policy if exists "Security settings can be read publicly" on public.security_settings;
create policy "Security settings can be read publicly"
  on public.security_settings for select
  to anon, authenticated
  using (true);

revoke insert, update, delete on public.security_settings from anon, authenticated;
grant select on public.security_settings to anon, authenticated;
