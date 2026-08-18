-- NTP date and Completion date — panel-only project dates.
--
-- Unlike Status, Contract, Senior engineer and SWA beside them, these two are
-- not overrides of anything. No workbook column feeds them and none ever will:
-- they exist only in the panel, are entered with a date picker, and are the
-- sole source of truth for themselves.
--
-- That is deliberate and it is the whole point of the request. A workbook may
-- well carry a column called "NTP" or "NOTICE TO PROCEED", but what it holds
-- there is descriptive text, not a date this ledger can trust. An import must
-- therefore never read it, never write these columns, and never record a change
-- against them.
--
-- Three things keep that true, and all three are needed:
--
--   1. The importers read an explicit allowlist of headings (findColumn in
--      src/lib/projectImport.js). A heading nobody asked for is not read at all,
--      so an "NTP" column in a new workbook is ignored rather than mapped.
--   2. IMPORT_AUDIT_FIELDS — the list the Excel diff walks — does not contain
--      these keys, so an import cannot produce an audit row for them.
--   3. assembleProjects never emits them, so the merged row takes its value
--      from the manual layer alone. There is no imported value underneath for a
--      later workbook to reveal.
--
-- Stored as `date`, which is what the picker produces and what the audit trail
-- records as an ISO string.

alter table public.project_manual_updates
  add column if not exists ntp_date date,
  add column if not exists completion_date date;

comment on column public.project_manual_updates.ntp_date is
  'Notice to Proceed date, entered in the Project Panel with a date picker. Panel-only: no import reads, writes or audits it. Null means not set.';

comment on column public.project_manual_updates.completion_date is
  'Completion date, entered in the Project Panel with a date picker. Panel-only: no import reads, writes or audits it. Null means not set.';
