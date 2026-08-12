-- Multiple targets remain available, but are an administrator-controlled
-- per-user feature. Existing and newly created accounts use the legacy single
-- target table by default.
alter table public.profiles
  add column if not exists multiple_targets_enabled boolean not null default false;

comment on column public.profiles.multiple_targets_enabled is
  'When true, this user can manage several targets per project through the Project Ledger modal. False uses the nearest active target in the inline table.';

-- The UI hides the modal when the option is off. Enforce the same boundary in
-- the database so a disabled account cannot bypass the interface and create or
-- restore a second active target. Existing extra targets are deliberately left
-- untouched; editing any already-active row remains allowed.
create or replace function public.enforce_multiple_targets_feature()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_enabled boolean := false;
begin
  -- Trusted backend and migration operations have no end-user JWT. RLS still
  -- blocks anonymous table writes, while the service role remains usable.
  if v_uid is null then
    return new;
  end if;

  select coalesce(p.multiple_targets_enabled, false)
  into v_enabled
  from public.profiles p
  where p.id = v_uid;

  if v_enabled or new.archived_at is not null then
    return new;
  end if;

  -- A normal field edit to an already-active target does not add a target,
  -- even when older data contains several active rows.
  if tg_op = 'UPDATE'
     and old.archived_at is null
     and old.project_key = new.project_key then
    return new;
  end if;

  if exists (
    select 1
    from public.project_targets t
    where t.project_key = new.project_key
      and t.archived_at is null
      and t.id is distinct from new.id
  ) then
    raise exception 'Multiple targets are disabled for your account. Ask an administrator to enable the feature.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_multiple_targets_feature() from public, anon, authenticated;

drop trigger if exists enforce_multiple_targets_feature on public.project_targets;
create trigger enforce_multiple_targets_feature
before insert or update of archived_at, project_key
on public.project_targets
for each row execute function public.enforce_multiple_targets_feature();

comment on function public.enforce_multiple_targets_feature() is
  'Prevents a user whose profile flag is false from adding or restoring a second active project target. Never deletes or archives existing data.';
