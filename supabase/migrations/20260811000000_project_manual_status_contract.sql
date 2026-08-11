-- Project-panel overrides for imported status and contract amount.
alter table public.project_manual_updates
  add column if not exists status text,
  add column if not exists contract_amount numeric;
