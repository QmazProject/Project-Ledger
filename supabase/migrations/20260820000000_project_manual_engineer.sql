-- Project-panel override for the imported Senior engineer.
--
-- The workbook stays the source of this field for every project nobody has
-- typed one against: the column is null until somebody edits the cell, and the
-- panel falls back to the imported name whenever it is null. That is what makes
-- an import safe. Imported values live in project_ledger_dataset, which an
-- import replaces wholesale, and this row is never touched by it — so a new
-- workbook changing the Senior engineer records an audit row against the
-- project and leaves the hand-typed name standing.
alter table public.project_manual_updates
  add column if not exists engineer text;

comment on column public.project_manual_updates.engineer is
  'Hand-typed Senior engineer. Overrides the imported value at render; null means no override, so the workbook value shows. Never written by an import.';
