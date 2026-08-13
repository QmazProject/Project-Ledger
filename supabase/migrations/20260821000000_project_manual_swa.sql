-- Project-panel override for the imported SWA %.
--
-- Same contract as the Senior engineer column beside it: null means no
-- override, so the workbook's value shows; a value here wins at render and no
-- import can reach it. A new workbook that moves the SWA still records the
-- change against the project, it just no longer decides what is displayed.
--
-- Stored as the fraction, not the percentage — 10.1% is 0.101 — because that is
-- what the workbook supplies, what the contract-weighted SWA total divides by,
-- and what the audit rows written by save_project_ledger_import already hold.
-- The panel converts on both sides of the keyboard so nobody has to know that.
alter table public.project_manual_updates
  add column if not exists swa numeric;

comment on column public.project_manual_updates.swa is
  'Hand-typed SWA as a fraction (0.101 = 10.1%). Overrides the imported value at render; null means no override. Never written by an import.';
