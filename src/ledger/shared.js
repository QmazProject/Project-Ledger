/* Module scope shared between the Project Ledger and the dialogs that are now
   downloaded on demand.

   These definitions used to live in ProjectLedger.jsx. Nothing about them has
   changed; they moved because a lazily-imported dialog cannot reach back into
   the module that imports it without creating a cycle that would pull the
   dialog straight back into the startup chunk — which is the whole thing the
   split exists to avoid.

   Everything here is imported eagerly by the ledger itself, so it stays in the
   main chunk. The point is not to make this code lazy, it is to let the heavy
   dialogs stop depending on a 5,000-line module. */

import { numberOrNull as toNum, IMPORT_AUDIT_FIELDS } from "../lib/projectImport";
import { TARGET_FIELDS, SCOPE_LABEL } from "../lib/targets";

/* ---------------- one request per mount ----------------
   React StrictMode (see main.jsx) mounts, unmounts and remounts every component
   in development, so each of the mount effects below runs twice. Each one used
   to call its loader twice and disarm the first call's `alive` flag in between,
   which meant the response that actually arrived was the one the effect had
   already agreed to ignore — and the panel's readiness depended entirely on a
   *second* request. When that second request did not complete, the panel sat on
   "Loading the ledger…" for as long as it was left open, with a successful 200
   for the first one visible in the network log the whole time.

   Sharing one promise removes the second request altogether: both invocations
   await the same response, and whichever instance is still mounted applies it.
   The `alive` guards stay exactly where they are — they still do their real job
   of not calling setState on an unmounted component. They simply no longer
   throw away the only answer the page is going to get.

   The entry is cleared once it settles, so a later mount — signing out and back
   in — fetches again rather than replaying a stale snapshot. The identity check
   in the cleanup matters: without it a settling promise would delete a newer
   request that had already claimed the same key.
------------------------------------------------- */

export const inFlight = new Map();

export function once(key, start) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  let promise;
  /* Promise.resolve, not the value itself: a supabase query builder is a
     *thenable* and not a promise — it implements `then` so it can be awaited,
     and nothing else. Calling `.finally` straight on one throws. */
  promise = Promise.resolve(start()).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export const blankToNull = (v) => (v === "" || v === null || v === undefined ? null : v);

/* Shared by both deletion paths so the wording of the warning cannot drift
   between them. Returns the typed reason, or null if the user backed out at
   either step. */
export function confirmPermanentDelete(what, detail) {
  if (!window.confirm(`Permanently delete ${what}?\n\n${detail}\n\nThis cannot be undone from the panel.`)) return null;
  const reason = window.prompt(`Reason for deleting ${what}. This is stored in the purge log and is required.`, "");
  if (reason === null) return null;
  if (!reason.trim()) {
    window.alert("A reason is required. Nothing was deleted.");
    return null;
  }
  return reason.trim();
}

/* ---------------- access ----------------
   The named permissions an administrator can grant one at a time. An admin holds
   all of them implicitly, so this list is only consulted for everybody else.
   Kept in step with the check constraint in
   20260831000000_ledger_access_permissions.sql — a key here the database rejects
   would look like a permission nobody can hold. */
export const LEDGER_PERMISSIONS = [
  { k: "add_project", label: "Add project",
    detail: "Create a project by hand in the Projects panel.",
    enforced: false,
    note: "Hides the form only. Writing to the shared dataset is something every signed-in user can already do in order to import a workbook, so this is not a security boundary." },
  { k: "delete_project", label: "Delete project",
    detail: "Permanently delete a project, its targets, audit history and hand-typed values. Also covers deleting a single target.",
    enforced: true },
  { k: "delete_audit", label: "Delete audit trail",
    detail: "Delete individual audit entries, or a whole cell's history.",
    enforced: true },
  { k: "view_presence", label: "See who is signed in",
    detail: "Show the list of users with the panel open, in the header.",
    enforced: true },
  { k: "view_duplicates", label: "View duplicate Project IDs",
    detail: "Right-click the ID column or header to list Project IDs appearing more than once.",
    enforced: false,
    note: "Arithmetic over rows the user can already see, done in the browser. There is nothing to enforce server-side." },
  { k: "previous_data", label: "Previous data",
    detail: "Restore the shared ledger to an earlier saved state.",
    enforced: true },
];

/* The date arithmetic behind a target's standing now lives in ./lib/targets so
   it can be exercised with an injected "today". Only formatting is left here. */
export const fmtDate = (s) => {
  if (!s) return "";
  const t = Date.parse(s + "T00:00:00");
  if (isNaN(t)) return s;
  const d = new Date(t);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/* Lifecycle order, not alphabetical: a project is unspecified before it is
   bid, awarded before it runs, and suspended only after it has started. The
   dropdown reads top to bottom the way the work actually moves. */
export const PROJECT_STATUS_OPTIONS = ["UNSPECIFIED", "NOT YET AWARDED", "ONGOING", "COMPLETED", "SUSPENDED"];

export const T = {
  paper: "#E9EDE7", paper2: "#F4F7F2", panel: "#FFFFFF",
  ink: "#16211C", inkSoft: "#4C5B53", inkFaint: "#7F8D84",
  rule: "#C6CEC4", ruleSoft: "#DEE4DA",
  collected: "#0E5B57", works: "#9A4B12", retention: "#6E6014", cash: "#3C6E9E", bad: "#8C2F26",
};
export const DISPLAY = '"Archivo","Helvetica Neue",system-ui,sans-serif';
export const BODY = '"IBM Plex Sans",system-ui,-apple-system,sans-serif';
export const MONO = '"IBM Plex Mono",ui-monospace,Menlo,monospace';

export const P = "\u20B1";
export const money = (n) => n === null || n === undefined || !isFinite(n) ? "—"
  : (n < 0 ? "-" : "") + P + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
export const compact = (n) => {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return s + P + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + P + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + P + (a / 1e3).toFixed(0) + "K";
  return money(n);
};
export const qty = (n) => (n === null || n === undefined || n === "" || isNaN(Number(n)))
  ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const pct = (n) => (n === null || n === undefined || !isFinite(n) ? "—" : (n * 100).toFixed(1) + "%");

/* The name each field is stored under in the audit trail. This is what the
   history query matches on, so it follows the database and not the column
   heading — see SCOPE_LABEL. */
export const AUDIT_FIELD_LABELS = Object.fromEntries([
  ...IMPORT_AUDIT_FIELDS,
  ...TARGET_FIELDS,
  /* Panel-only fields. Deliberately listed here and NOT in IMPORT_AUDIT_FIELDS:
     that list is what the Excel diff walks, so a key added there would let an
     import record a change against a column no import is allowed to touch. */
  ["note", "Remarks"],
  ["ntpDate", "NTP date"],
  ["completionDate", "Completion date"],
]);

/* ...and the name to show above that history, which is the one on the column. */
export const AUDIT_DISPLAY_LABELS = { ...AUDIT_FIELD_LABELS, scope: SCOPE_LABEL };

/* The trail stores what was stored. SWA is a fraction there — from Excel and
   from the panel alike — so it has to be rendered the way the column renders
   it, or every row reads as a hundredfold error. Formatting on the way out
   rather than on the way in also covers the history written before the column
   was editable. */
export const AUDIT_VALUE_FORMATTERS = {
  swa: (raw) => { const n = toNum(raw); return n === null ? raw : pct(n); },
};
export const auditValue = (field, raw) => raw === null || raw === undefined || raw === ""
  ? "—"
  : (AUDIT_VALUE_FORMATTERS[field] ? AUDIT_VALUE_FORMATTERS[field](raw) : raw);

/* "Behind target" used to sit here too. No branch ever assigned it — the
   scoring was simplified at some point and the bucket was left behind, so it
   silently contributed nothing to the standings bar and a constant zero to the
   "behind" figure in the KPI beneath it. It has been removed. */
export const BUCKET_COLOR = {
  "Overdue": T.bad, "Critical": "#D2A21C",
  "On track": T.collected, "Delivered on time": T.collected, "Delivered": T.inkSoft,
};
export const DRAFT_COLOR = T.inkFaint;

/* the two standings that demand action are filled rather than outlined, so they
   carry across a room; everything else stays a quiet outline */
export const BUCKET_PILL = {
  "Overdue":  { bg: T.bad,     fg: "#FFFFFF", bd: T.bad,     weight: 700 },
  "Critical": { bg: "#F0CB45", fg: T.ink,     bd: "#C79E1E", weight: 700 },
};
/* every standing renders at the same size so the column reads as one control,
   sized to the longest label ("Delivered on time") */
export const PILL_BASE = {
  display: "inline-block", width: 112, textAlign: "center", padding: "2px 6px",
  borderRadius: 999, fontSize: 10, lineHeight: "13px", whiteSpace: "nowrap",
};
export const pillStyle = (b) => {
  const s = BUCKET_PILL[b];
  return s
    ? { ...PILL_BASE, background: s.bg, color: s.fg, border: `1px solid ${s.bd}`, fontWeight: s.weight }
    : { ...PILL_BASE, background: "transparent", color: BUCKET_COLOR[b], border: `1px solid ${BUCKET_COLOR[b]}`, fontWeight: 500 };
};

export const formatUploadDateTime = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

/* A blank row in Manage targets. Lives here rather than beside that dialog
   because the ledger itself also needs it, to seed the inline target editor. */
export const emptyTarget = () => ({
  scope: "", target_qty: "", unit: "", start_date: "",
  target_completion: "", actual_completion: "", actual_output: "",
});
