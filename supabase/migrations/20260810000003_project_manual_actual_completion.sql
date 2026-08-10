-- "Delivered on time" was previously asserted for any project whose actual output
-- reached its target qty, with nothing to back the "on time" half of the claim.
--
-- Deciding it from the current date does not work: a project delivered a week
-- early would flip to late as soon as its deadline rolled by, because that test
-- measures from today rather than from the day the work landed. So the day it
-- landed is recorded here, hand-typed like the other target columns.
--
-- Nullable on purpose. A row whose target is met but whose completion date is
-- blank is reported as "Delivered" — not "Delivered on time", which the data
-- cannot support until somebody fills this in.
alter table public.project_manual_updates
  add column if not exists actual_completion date;

comment on column public.project_manual_updates.actual_completion is
  'Day the target was actually met. Compared against target_completion to separate "Delivered on time" from "Delivered". Null means unknown, not on time.';
