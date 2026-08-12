import { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase, isConfigured } from "./lib/supabase";
import {
  projectKey, todayMs, assessTargets, assessProjectTargets, assessTarget,
  atRiskExposure, distinctProjectCount, isTrackable, isArchived,
  validateTarget, targetWarnings, selectPrimaryTarget, TARGET_FIELDS,
} from "./lib/targets";
import { groupTargetHistory, actionLabel, isEventOnly, isBlankValue } from "./lib/targetHistory";
import {
  settleLoad, loadingState, isReady, hasFailed, projectTargets, targetsLabel,
  buildManualSave,
} from "./lib/panelData";
import {
  normalizeText, cleanText, numberOrNull, readMasterWorkbook, readCollectiblesWorkbook,
  assembleProjects, extendLegacyAssignments, resolvedEntry, importedChanges,
  IMPORT_AUDIT_FIELDS,
} from "./lib/projectImport";

/* ==================================================================
   Project Ledger — QM Builders
   Attributes : PROJECT_MASTER_DATA.xlsx › "QMB PROJECTS" + "QM LICENSES"
   Money      : UPDATED COLLECTIBLES.xlsx › "COLLECTIBLES"

   Nothing is built in. Both workbooks are parsed in the browser and the parsed
   result is kept in one shared Supabase row, so the page opens with whatever was
   imported last and a re-import replaces it for everyone.
================================================================== */

const EMPTY_STORE = { coll: [], dim: new Map(), legacy: new Map() };
const NO_DATA_LABEL = "No data yet \u00b7 upload the workbooks to begin";

/* ---------------- parsing helpers ---------------- */

const NORM = normalizeText;
const CLEAN = cleanText;
const toNum = numberOrNull;
const readMaster = readMasterWorkbook;
const readCollectibles = readCollectiblesWorkbook;
const assemble = assembleProjects;

/* ---------------- shared dataset ----------------
   There is no built-in data. Whatever the last person imported is parsed here in
   the browser and the result is kept in one shared row, so everybody else opens
   the same figures without re-uploading. The stored payload is the {coll, dim}
   store itself — dim is carried as entries because a Map is not JSON — which is
   why importing one workbook on its own still joins against the other.
------------------------------------------------- */

const DATASET_TABLE = "project_ledger_dataset";
const DATASET_VERSION_TABLE = "project_ledger_dataset_versions";
const DATASET_ID = "current";
const DATASET_VERSION = 2;
const LEDGER_UPLOAD_TABLE = "project_ledger_uploads";
const LEDGER_UPLOAD_BUCKET = "project-ledger-uploads";

const serialiseStore = (store) => ({
  version: DATASET_VERSION,
  coll: store.coll,
  dim: [...store.dim.entries()],
  legacy: [...(store.legacy instanceof Map ? store.legacy : new Map()).entries()],
});
const deserialiseStore = (payload) => ({
  coll: Array.isArray(payload?.coll) ? payload.coll : [],
  dim: new Map(Array.isArray(payload?.dim) ? payload.dim : []),
  legacy: new Map(Array.isArray(payload?.legacy) ? payload.legacy : []),
});

/** null when nothing has been uploaded yet, or when Supabase is not configured */
async function loadDataset() {
  if (!isConfigured || !supabase) return null;
  const { data, error } = await supabase.from(DATASET_TABLE)
    .select("payload, source_label, uploaded_by_username, uploaded_at")
    .eq("id", DATASET_ID).maybeSingle();
  if (error) throw error;
  if (!data?.payload) return null;
  return {
    store: deserialiseStore(data.payload),
    label: data.source_label || "",
    username: data.uploaded_by_username || "",
    at: data.uploaded_at || "",
  };
}

async function saveDataset(store, label, changes = []) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("save_project_ledger_import", {
    p_payload: serialiseStore(store),
    p_source_label: label,
    p_project_count: assemble(store.coll, store.dim).length,
    p_changes: changes,
  });
  if (error) throw error;
  return data || new Date().toISOString();
}

async function loadDatasetVersions() {
  if (!isConfigured || !supabase) return [];
  const { data, error } = await supabase.from(DATASET_VERSION_TABLE)
    .select("id, source_label, project_count, uploaded_by_username, uploaded_at, saved_reason, saved_by_username, saved_at")
    .order("saved_at", { ascending: false })
    .limit(25);
  if (error) throw error;
  return data || [];
}

async function restoreDatasetVersion(versionId) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("restore_project_ledger_version", {
    p_version_id: versionId,
  });
  if (error) throw error;
  return data || new Date().toISOString();
}

const storageSafeFilename = (name) => {
  const safe = String(name || "workbook.xlsx")
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return char === "/" || char === "\\" || code < 32 || code === 127 ? "_" : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || "workbook.xlsx").slice(-160);
};

/** Archive the original workbook separately from the parsed shared dataset.
 *  The original filename stays in metadata; only the private storage path is
 *  sanitised. */
async function archiveLedgerUpload(file, userId) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  if (!userId) throw new Error("The uploader could not be identified.");
  const key = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const storagePath = `${userId}/${key}/${storageSafeFilename(file.name)}`;
  const { error: storageError } = await supabase.storage.from(LEDGER_UPLOAD_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      cacheControl: "3600",
      upsert: false,
    });
  if (storageError) throw storageError;
  const { error: metadataError } = await supabase.from(LEDGER_UPLOAD_TABLE).insert({
    uploaded_by: userId,
    original_filename: file.name,
    storage_path: storagePath,
  });
  if (metadataError) throw metadataError;
}

/* ---------------- manual entries ----------------
   Status, contract and remarks are typed in by hand, so they must survive a
   re-import. They live in their own store keyed by project ID and are never
   touched by the Excel readers — importing replaces only the imported columns
   and leaves everything below untouched.

   Targets used to live here too, as six columns on this one project-keyed row,
   which is why a project could only ever have one. They now have their own
   table; the old columns are still present but are no longer read, so a revert
   restores the previous behaviour without restoring data.

   Lookups are keyed on the canonical project key rather than the raw ID.
   The workbook readers join master attributes to collectibles rows on that
   normalised key already, but hand-typed rows were matched on the raw string,
   so a project whose ID changed case or lost an apostrophe between workbook
   versions silently orphaned everything anyone had typed against it. Matching
   on the canonical key here recovers those rows; `storedId` remembers the
   spelling the row was actually written under so an update still finds it.
------------------------------------------------- */

const AUDIT_TABLE = "project_manual_update_audit";
const TARGET_TABLE = "project_targets";

const blankToNull = (v) => (v === "" || v === null || v === undefined ? null : v);
const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : toNum(v));
const newBatchId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

/** One audit row. Field-level granularity is deliberate: the panel's
 *  right-click history reads (project_id, column_name) against a matching
 *  index, so collapsing a save into one record would break that feature.
 *  `batch_id` is what lets several field rows still be read back as one
 *  event. */
function auditRow({ projectId, targetId = null, targetScope = null, label, fieldKey,
                    oldValue = null, newValue = null, action = "update", source, batchId,
                    userId, username }) {
  return {
    project_id: projectId,
    target_id: targetId,
    target_scope: targetScope,
    column_name: label,
    field_key: fieldKey,
    old_value: oldValue === "" || oldValue === undefined ? null : oldValue === null ? null : String(oldValue),
    new_value: newValue === "" || newValue === undefined ? null : newValue === null ? null : String(newValue),
    action,
    source,
    batch_id: batchId,
    changed_by: userId,
    changed_by_username: username || "Unknown user",
  };
}

async function insertAudit(rows) {
  if (!rows.length) return;
  const { error } = await supabase.from(AUDIT_TABLE).insert(rows);
  if (error) throw error;
}

/** Map of canonical project key → { storedId, values }. */
async function loadManual() {
  if (!isConfigured || !supabase) return new Map();
  const { data, error } = await supabase.from("project_manual_updates")
    .select("project_id, status, contract_amount, remarks");
  if (error) throw error;
  const byKey = new Map();
  for (const row of data || []) {
    const values = { note: row.remarks };
    if (row.status !== null && row.status !== undefined) values.status = row.status;
    if (row.contract_amount !== null && row.contract_amount !== undefined) values.contract = row.contract_amount;
    byKey.set(projectKey(row.project_id), { storedId: row.project_id, values });
  }
  return byKey;
}

/** Map of canonical project key → target rows, soonest deadline first. */
async function loadTargets() {
  if (!isConfigured || !supabase) return new Map();
  const { data, error } = await supabase.from(TARGET_TABLE)
    .select("id, project_id, project_key, scope, target_qty, unit, start_date, target_completion, actual_completion, actual_output, archived_at, created_at, updated_at");
  if (error) throw error;
  const byKey = new Map();
  for (const row of data || []) {
    const key = row.project_key || projectKey(row.project_id);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  for (const list of byKey.values())
    list.sort((a, b) => String(a.target_completion || "9999").localeCompare(String(b.target_completion || "9999"))
                        || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return byKey;
}

/** Every audit row belonging to a set of targets, newest first.
 *
 *  Filtered on target_id and never on project_id. The audit table stores the
 *  project ID as text, and the spelling a row was written under depends on how
 *  the workbook spelled it that day — which is the same weakness project_key()
 *  exists to work around. A target's UUID has no such problem, so a target's
 *  history stays attached to it whatever happens to the project's display ID. */
async function loadTargetHistory(targetIds) {
  if (!isConfigured || !supabase) return [];
  const ids = (targetIds || []).filter(Boolean);
  if (!ids.length) return [];
  const { data, error } = await supabase.from(AUDIT_TABLE)
    .select("id, target_id, target_scope, column_name, field_key, old_value, new_value, action, source, batch_id, changed_by, changed_by_username, changed_at")
    .in("target_id", ids)
    .order("changed_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

/** Project-level save. Targets are never written here — a target edit must not
 *  rewrite status and contract as a side effect, which is what the single
 *  nine-column upsert used to do. */
async function saveManualRow(id, values, oldValues, userId, username, changedFields) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const hasContract = values.contract !== "" && values.contract !== null && values.contract !== undefined;
  if (hasContract && toNum(values.contract) === null)
    throw new Error("Contract must be a numeric amount.");
  const { error } = await supabase.from("project_manual_updates").upsert({
    project_id: id,
    status: CLEAN(values.status) || null,
    contract_amount: numOrNull(values.contract),
    remarks: values.note || null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "project_id" });
  if (error) throw error;

  const batchId = newBatchId();
  const auditFields = [["status", "Status"], ["contract", "Contract"], ["note", "Remarks"]];
  const changes = auditFields
    .filter(([field]) => !changedFields || changedFields.has(field))
    .filter(([field]) => String(oldValues?.[field] ?? "") !== String(values?.[field] ?? ""))
    .map(([field, label]) => auditRow({
      projectId: id, label, fieldKey: field,
      oldValue: oldValues?.[field], newValue: values?.[field],
      action: "update", source: "panel", batchId, userId, username,
    }));
  await insertAudit(changes);
}

/* ---------------- target writes ----------------
   Each operation goes through a database function rather than through a table
   write followed by an audit write. Two PostgREST requests are two
   transactions, so an audit insert that failed used to leave the target changed
   with no record of it - and the user saw an error for a save that had actually
   happened. A function body is one transaction: the target row and its audit
   rows either both land or neither does.

   No user id is sent. The functions read the actor from auth.uid() and the
   display name from profiles, so neither can be supplied by the browser.

   Scope of the guarantee: one call is one transaction. A save touching several
   targets is several calls, so a failure part-way through leaves the targets
   already saved committed - each of them internally consistent, never data
   without audit. The modal reloads from the server afterwards, so what is on
   screen is what is stored either way.
------------------------------------------------- */

const targetColumns = (v) => ({
  scope: blankToNull(v.scope),
  target_qty: numOrNull(v.target_qty),
  unit: blankToNull(v.unit),
  start_date: blankToNull(v.start_date),
  target_completion: blankToNull(v.target_completion),
  actual_completion: blankToNull(v.actual_completion),
  actual_output: numOrNull(v.actual_output),
});

/* PostgREST surfaces a RAISE EXCEPTION as an error with the raised message,
   which is what the modal shows. Anything without one falls back to the code so
   a failure is never reported as a blank string. */
async function callTargetRpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message || error.details || error.code || `${fn} failed`);
  return data;
}

async function saveTargets({ projectId, creates = [], updates = [], archives = [], restores = [] }) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  /* One batch id for the whole save, passed into every call, so the field rows
     written across several targets still read back as a single event. */
  const batchId = newBatchId();
  const created = [];

  for (const target of creates) {
    const c = targetColumns(target);
    created.push(await callTargetRpc("create_project_target", {
      p_project_id: projectId,
      p_scope: c.scope,
      p_target_qty: c.target_qty,
      p_unit: c.unit,
      p_start_date: c.start_date,
      p_target_completion: c.target_completion,
      p_actual_completion: c.actual_completion,
      p_actual_output: c.actual_output,
      p_batch_id: batchId,
    }));
  }

  /* Only which targets to send is decided here. Which *fields* changed is
     decided in the database against the current row, so a stale copy in this
     browser cannot cause a change to go unaudited. */
  for (const { id, after } of updates) {
    const c = targetColumns(after);
    await callTargetRpc("update_project_target", {
      p_target_id: id,
      /* A target migrated from the old Project-ID-only model keeps that stored
         identity. New targets use Project ID - Year. Sending each existing
         target's own identity lets both live together on the latest-year row. */
      p_project_id: after.project_id || projectId,
      p_scope: c.scope,
      p_target_qty: c.target_qty,
      p_unit: c.unit,
      p_start_date: c.start_date,
      p_target_completion: c.target_completion,
      p_actual_completion: c.actual_completion,
      p_actual_output: c.actual_output,
      p_batch_id: batchId,
    });
  }

  for (const target of archives)
    await callTargetRpc("set_project_target_archived", {
      p_target_id: target.id, p_project_id: target.project_id || projectId, p_archived: true, p_batch_id: batchId,
    });

  for (const target of restores)
    await callTargetRpc("set_project_target_archived", {
      p_target_id: target.id, p_project_id: target.project_id || projectId, p_archived: false, p_batch_id: batchId,
    });

  return { batchId, created };
}

/* The date arithmetic behind a target's standing now lives in ./lib/targets so
   it can be exercised with an injected "today". Only formatting is left here. */
const fmtDate = (s) => {
  if (!s) return "";
  const t = Date.parse(s + "T00:00:00");
  if (isNaN(t)) return s;
  const d = new Date(t);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/* ---------------- presentation ---------------- */

const DIMS = [
  { k: "district", label: "District", w: 190 },
  { k: "category", label: "Project category", w: 190 },
  { k: "license", label: "License", w: 260 },
  { k: "yearStr", label: "Project year", w: 140 },
  { k: "engineer", label: "Senior engineer", w: 210 },
  { k: "office", label: "Implementing office", w: 250 },
  { k: "location", label: "Location", w: 220 },
  { k: "status", label: "Status", w: 160 },
  { k: "hasTarget", label: "Targets", w: 150 },
];

const T = {
  paper: "#E9EDE7", paper2: "#F4F7F2", panel: "#FFFFFF",
  ink: "#16211C", inkSoft: "#4C5B53", inkFaint: "#7F8D84",
  rule: "#C6CEC4", ruleSoft: "#DEE4DA",
  collected: "#0E5B57", works: "#9A4B12", retention: "#6E6014", cash: "#3C6E9E", bad: "#8C2F26",
};
const DISPLAY = '"Archivo","Helvetica Neue",system-ui,sans-serif';
const BODY = '"IBM Plex Sans",system-ui,-apple-system,sans-serif';
const MONO = '"IBM Plex Mono",ui-monospace,Menlo,monospace';

const P = "\u20B1";
const money = (n) => n === null || n === undefined || !isFinite(n) ? "—"
  : (n < 0 ? "-" : "") + P + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const compact = (n) => {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return s + P + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + P + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + P + (a / 1e3).toFixed(0) + "K";
  return money(n);
};
const qty = (n) => (n === null || n === undefined || n === "" || isNaN(Number(n)))
  ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (n) => (n === null || n === undefined || !isFinite(n) ? "—" : (n * 100).toFixed(1) + "%");
const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);

const COLS = [
  { k: "id", label: "ID", stick: true, w: 92 },
  { k: "district", label: "District" },
  { k: "license", label: "License" },
  { k: "engineer", label: "Senior engineer" },
  { k: "category", label: "Category" },
  { k: "location", label: "Location" },
  { k: "status", label: "Status", edit: "status", w: 160 },
  { k: "contract", label: "Contract", edit: "amount", money: true, w: 101 },
  { k: "swa", label: "SWA %", pct: true },
  { k: "billpct", label: "Billed %", pct: true },
  { k: "net", label: "Collected (net)", money: true, group: "collection" },
  { k: "cg", label: "Balance works", money: true, group: "collection" },
  { k: "cr", label: "Retention", money: true, group: "collection" },
  { k: "bal", label: "Balance for collection", money: true, w: 119, group: "collection" },
  { k: "netbal", label: "Net balance", money: true, group: "collection" },
  /* A project can hold several targets, so the six target columns are no longer
     single-valued and have moved into Manage Targets. What is left on the row
     is a summary that opens it — which makes the table one column narrower than
     it was, not wider. */
  { k: "targetSummary", label: "Targets", targets: true, w: 178 },
  { k: "note", label: "Remarks", edit: "text", w: 190 },
];

const INLINE_TARGET_COLS = [
  { k: "target_qty", label: "Target qty", edit: "qty", targetField: true, w: 92 },
  { k: "unit", label: "Unit", edit: "text", targetField: true, w: 80 },
  { k: "start_date", label: "Start date", edit: "date", targetField: true, w: 132 },
  { k: "target_completion", label: "Target completion", edit: "date", targetField: true, w: 132 },
  { k: "actual_completion", label: "Actual completion", edit: "date", targetField: true, w: 132 },
  { k: "actual_output", label: "Actual output", edit: "qty", targetField: true, w: 96 },
];
const INLINE_TARGET_FIELD_KEYS = new Set(INLINE_TARGET_COLS.map((column) => column.k));

const AUDIT_FIELD_LABELS = Object.fromEntries([
  ...IMPORT_AUDIT_FIELDS,
  ...TARGET_FIELDS,
  ["note", "Remarks"],
]);

/* ---------------- export ----------------
   The export keeps one row per project, because everything downstream of it
   expects that. The six target columns are kept too, and are filled only when
   a project has exactly one live target — which is every project immediately
   after the migration, so existing consumers see no change at all. A project
   with several targets leaves them blank rather than picking one arbitrarily
   and presenting it as the whole project; the Targets count says why. A
   row-per-target export is deferred with the rest of the Excel work.
------------------------------------------------- */

const EXPORT_TARGET_COLS = [
  { k: "scope", label: "Scope" },
  { k: "target_qty", label: "Target qty" },
  { k: "unit", label: "Unit" },
  { k: "start_date", label: "Start date" },
  { k: "target_completion", label: "Target completion" },
  { k: "actual_completion", label: "Actual completion" },
  { k: "actual_output", label: "Actual output" },
];

/* the table hides the long project name; the export still carries it */
const EXPORT_COLS = [
  COLS[0],
  { k: "name", label: "Project name" },
  ...COLS.slice(1).filter((c) => !c.targets && c.k !== "note"),
  { k: "targetCount", label: "Targets" },
  ...EXPORT_TARGET_COLS,
  { k: "note", label: "Remarks" },
];

function Panel({ title, right, children }) {
  return (
    <section className="mb-3 rounded-sm"
             style={{ background: T.panel, border: `1px solid ${T.rule}`, boxShadow: "0 10px 26px -20px rgba(22,33,28,.6)",
                      height: "100%", display: "flex", flexDirection: "column" }}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <h3 className="text-[11px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 700 }}>{title}</h3>
          {right}
        </div>
      )}
      <div className="p-3" style={{ flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, meta, color }) {
  return (
    <div className="rounded-sm px-3 pb-3 pt-2.5"
         style={{ background: T.panel, border: `1px solid ${T.rule}`, borderTop: `3px solid ${color || T.ink}` }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>{label}</div>
      <div className="mt-1 text-xl leading-tight" style={{ fontFamily: MONO, fontWeight: 600, color: color || T.ink }}>{value}</div>
      <div className="mt-0.5 text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>{meta}</div>
    </div>
  );
}

function Meter({ label, segments, legend }) {
  const total = segments.reduce((t, s) => t + Math.max(0, s.value || 0), 0) || 1;
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>{label}</div>
      <div className="flex h-7 overflow-hidden" style={{ border: `1px solid ${T.ink}`, background: T.paper2 }}>
        {segments.map((s, i) => (
          <div key={i} title={`${s.label} — ${money(s.value)}`}
               style={{ width: (Math.max(0, s.value || 0) / total) * 100 + "%", background: s.color, transition: "width .35s ease" }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: T.inkSoft }}>
        {legend.map((l, i) => (
          <span key={i}>
            {l.color && <span className="mr-1.5 inline-block h-2.5 w-2.5 align-[-1px]" style={{ background: l.color }} />}
            {l.label} <b style={{ fontFamily: MONO, color: T.ink }}>{l.value}</b>
            {l.extra ? <span style={{ color: T.inkFaint }}> · {l.extra}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- import panel ---------------- */

function ImportPanel({ onLoad, sourceLabel, uploadedBy, log, busy, onReload, onPrevious, reloading, forceOpen }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const shown = open || forceOpen;

  const take = (files) => { if (files && files.length) onLoad([...files]); };

  return (
    <div className="mb-4 rounded-sm" style={{ background: T.panel, border: `1px solid ${T.rule}` }}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="text-[11.5px]" style={{ fontFamily: MONO, color: T.inkSoft }}>
          Data source: <b style={{ color: T.ink }}>{sourceLabel}</b>
          {uploadedBy && <span style={{ color: T.inkFaint }}> · {uploadedBy}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onPrevious} disabled={busy || reloading || !isConfigured}
                  className="rounded-sm px-2.5 py-1 text-xs"
                  title="Restore the shared ledger as it was before an earlier Excel update"
                  style={{ border: `1px solid ${T.rule}`, color: T.inkSoft,
                           opacity: busy || reloading || !isConfigured ? 0.6 : 1 }}>
            Previous data
          </button>
          <button type="button" onClick={onReload} disabled={reloading} className="rounded-sm px-2.5 py-1 text-xs"
                  style={{ border: `1px solid ${T.rule}`, color: T.inkSoft, opacity: reloading ? 0.6 : 1 }}>
            {reloading ? "Reloading…" : "Reload saved data"}
          </button>
          {/* with no ledger loaded there is nothing to close back to, so the drop
              zone stays open and the toggle is left out */}
          {!forceOpen && (
            <button type="button" onClick={() => setOpen(!open)} className="rounded-sm px-2.5 py-1 text-xs"
                    style={{ border: `1px solid ${T.ink}`, background: open ? T.ink : T.panel,
                             color: open ? T.paper2 : T.ink }}>
              {open ? "Close" : "Update from Excel"}
            </button>
          )}
        </div>
      </div>

      {shown && (
        <div className="px-3 pb-3" style={{ borderTop: `1px solid ${T.ruleSoft}` }}>
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
            className="mt-3 rounded-sm px-4 py-7 text-center"
            style={{ border: `2px dashed ${over ? T.collected : T.rule}`, background: over ? "#F0F6F4" : T.paper2 }}
          >
            <div className="text-sm" style={{ fontFamily: DISPLAY, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" }}>
              Drop the two workbooks here
            </div>
            <p className="mx-auto mt-1.5 max-w-xl text-xs" style={{ color: T.inkSoft }}>
              The project master workbook (read from <b>QMB Projects</b> and <b>QM Licenses</b>) and the
              updated collectibles workbook (read from <b>Collectibles</b>). Drop either one on its own or both
              together — the filename does not matter because each file is identified by its sheet names. Master
              projects from 2022 onward are consolidated by Project ID and Year, with QM Licenses preferred and
              master-only projects kept visible. Hand-typed status, contract, remarks and targets are retained;
              only Excel fields that really changed receive an <b>Excel updated</b> audit entry.
            </p>
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.xlsm" multiple hidden
                   onChange={(e) => take(e.target.files)} />
            <button type="button" onClick={() => inputRef.current && inputRef.current.click()} disabled={busy}
                    className="mt-3 rounded-sm px-3 py-1.5 text-xs"
                    style={{ border: `1px solid ${T.ink}`, background: T.ink, color: T.paper2, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Reading…" : "Choose files"}
            </button>
          </div>

          {log.length > 0 && (
            <div className="mt-3 rounded-sm px-3 py-2" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
              {log.map((l, i) => (
                <div key={i} className="text-[11.5px]" style={{ fontFamily: MONO, color: l.warn ? T.bad : T.inkSoft }}>
                  {l.warn ? "! " : "· "}{l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyLedger({ loading, configured }) {
  return (
    <div className="rounded-sm px-6 py-12 text-center"
         style={{ background: T.panel, border: `1px solid ${T.rule}` }}>
      <div className="text-base uppercase"
           style={{ fontFamily: DISPLAY, fontWeight: 800, letterSpacing: ".05em" }}>
        {loading ? "Loading the ledger…" : "No project data yet"}
      </div>
      {!loading && (
        <p className="mx-auto mt-2 max-w-lg text-xs" style={{ color: T.inkSoft }}>
          {configured
            ? "Use the drop zone above to import the project master and collectibles workbooks. The figures are saved once and everybody signed in sees them."
            : "Supabase is not configured for this build, so nothing can be loaded or saved. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then import the workbooks."}
        </p>
      )}
    </div>
  );
}

/* ---------------- filter bar ---------------- */

function FilterDropdown({ dim, counts, selected, onToggle, onClearOne, open, onOpen }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => [...counts.entries()]
    .filter(([v]) => !q || v.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), [counts, q]);

  const on = selected.size > 0;
  const summary = selected.size === 0 ? "All"
    : selected.size === 1 ? [...selected][0]
    : selected.size + " selected";

  return (
    <div className="project-filter-dropdown relative" style={{ width: dim.w, minWidth: 130, flex: "1 1 auto", maxWidth: 320 }}>
      <div className="mb-1 text-[9.5px] uppercase"
           style={{ fontFamily: DISPLAY, fontWeight: 600, letterSpacing: ".09em", color: T.inkSoft }}>
        {dim.label}
      </div>
      <button
        onClick={() => onOpen(open ? null : dim.k)}
        className="project-filter-trigger flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs"
        style={{
          border: `1px solid ${on || open ? T.ink : T.rule}`,
          background: on ? T.ink : T.panel,
          color: on ? T.paper2 : T.ink,
          boxShadow: open ? `0 0 0 2px ${T.collected}33` : "none",
        }}
      >
        <span className="truncate" title={summary}>{summary}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {on && (
            <span className="rounded-full px-1.5 text-[9.5px]"
                  style={{ fontFamily: MONO, background: T.paper2, color: T.ink }}>{selected.size}</span>
          )}
          <span style={{ fontFamily: MONO, fontSize: 10, opacity: 0.7 }}>{open ? "\u25B2" : "\u25BC"}</span>
        </span>
      </button>

      {open && (
        <div className="project-filter-menu absolute left-0 z-30 mt-1 rounded-sm p-2"
             style={{ top: "100%", width: Math.max(dim.w, 230), background: T.panel,
                      border: `1px solid ${T.ink}`, boxShadow: "0 18px 40px -20px rgba(22,33,28,.55)" }}>
          {counts.size > 8 && (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="find\u2026"
                   className="mb-1.5 w-full rounded-sm px-2 py-1 text-xs" style={{ border: `1px solid ${T.rule}` }} />
          )}
          <div className="max-h-64 overflow-auto">
            {list.length === 0 && <div className="px-1 py-2 text-[11px]" style={{ color: T.inkFaint }}>No match.</div>}
            {list.map(([v, n]) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs"
                     style={{ opacity: n ? 1 : 0.4 }}>
                <input type="checkbox" checked={selected.has(v)} onChange={() => onToggle(dim.k, v)}
                       style={{ accentColor: T.collected }} />
                <span className="flex-1 truncate" title={v}>{v}</span>
                <span className="text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>{n}</span>
              </label>
            ))}
          </div>
          {on && (
            <button onClick={() => onClearOne(dim.k)}
                    className="mt-1.5 w-full rounded-sm py-1 text-[11px]"
                    style={{ border: `1px solid ${T.rule}`, color: T.inkSoft }}>
              Clear {dim.label.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterBar({ q, setQ, filters, countsFor, onToggle, onClearOne, onClearAll, anyActive }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(null); };
    const esc = (e) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={ref} className="project-filter-bar sticky top-0 z-20 mb-3 rounded-sm px-3 pb-3 pt-2.5"
         style={{ background: T.panel, border: `1px solid ${T.rule}`, boxShadow: "0 10px 26px -22px rgba(22,33,28,.7)" }}>
      <div className="project-filter-controls flex flex-wrap items-end gap-2">
        <div className="project-filter-search relative" style={{ width: 220, minWidth: 160, flex: "1 1 auto", maxWidth: 320 }}>
          <div className="mb-1 text-[9.5px] uppercase"
               style={{ fontFamily: DISPLAY, fontWeight: 600, letterSpacing: ".09em", color: T.inkSoft }}>Search</div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID, project name, remarks\u2026"
                 className="project-filter-search-input w-full rounded-sm px-2.5 py-1.5 text-xs"
                 style={{ border: `1px solid ${q ? T.ink : T.rule}` }} />
        </div>

        {DIMS.map((d) => (
          <FilterDropdown key={d.k} dim={d} counts={countsFor(d.k)} selected={filters[d.k]}
                          onToggle={onToggle} onClearOne={onClearOne}
                          open={open === d.k} onOpen={setOpen} />
        ))}

        <button className="project-filter-clear rounded-sm px-2.5 py-1.5 text-[11px]" onClick={onClearAll} disabled={!anyActive}
                style={{ border: `1px solid ${T.rule}`, color: anyActive ? T.ink : T.inkFaint,
                         background: T.panel, opacity: anyActive ? 1 : 0.5, alignSelf: "flex-end" }}>
          Clear all
        </button>
      </div>
    </div>
  );
}

/* ---------------- charts ---------------- */

function GroupChart({ rows, groupBy, onGroupBy }) {
  const PLOT = 172;
  const HEAD = 15;          // headroom so a data label never overruns the panel
  const BAR = PLOT - HEAD;  // usable bar height
  const COLW = 66;
  const arr = useMemo(() => {
    const g = new Map();
    rows.forEach((r) => {
      const k = r[groupBy];
      if (!g.has(k)) g.set(k, { k, n: 0, net: 0, cg: 0, cr: 0, bal: 0 });
      const o = g.get(k);
      o.n++; o.net += r.net || 0; o.cg += r.cg || 0; o.cr += r.cr || 0; o.bal += r.bal || 0;
    });
    return [...g.values()].sort((a, b) => b.bal - a.bal);
  }, [rows, groupBy]);

  const show = arr.slice(0, 12);
  const max = Math.max(1, ...show.map((a) => Math.max(a.bal, a.net)));
  const h = (v) => Math.max(v > 0 ? 1 : 0, (v / max) * BAR);

  return (
    <Panel title="By group" right={
      <label className="text-[11px]" style={{ fontFamily: MONO, color: T.inkSoft }}>
        Group by{" "}
        <select value={groupBy} onChange={(e) => onGroupBy(e.target.value)} className="ml-1 rounded-sm px-1.5 py-1 text-[12px]"
                style={{ border: `1px solid ${T.rule}`, background: T.panel }}>
          {DIMS.map((d) => <option key={d.k} value={d.k}>{d.label}</option>)}
        </select>
      </label>
    }>
      {show.length === 0 ? (
        <div className="py-8 text-center text-xs" style={{ color: T.inkFaint }}>Nothing to chart.</div>
      ) : (
        <div className="project-group-chart flex gap-2">
          {/* y axis */}
          <div className="relative shrink-0" style={{ width: 46, height: PLOT }}>
            {[1, 0.5, 0].map((f) => (
              <div key={f} className="absolute right-0 text-[9.5px]"
                   style={{ top: HEAD + (1 - f) * BAR - 6, fontFamily: MONO, color: T.inkFaint }}>
                {f === 0 ? "0" : compact(max * f)}
              </div>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto">
            {/* plot */}
            <div className="relative flex items-end" style={{ height: PLOT, borderBottom: `1px solid ${T.ink}` }}>
              {[1, 0.5].map((f) => (
                <div key={f} className="pointer-events-none absolute left-0 right-0"
                     style={{ top: HEAD + (1 - f) * BAR, borderTop: `1px dashed ${T.ruleSoft}` }} />
              ))}
              {show.map((a) => (
                <div key={a.k} className="flex items-end justify-center gap-1"
                     style={{ flex: "1 1 0", minWidth: COLW, padding: "0 3px" }}>
                  {/* balance for collection, stacked */}
                  <div className="flex flex-col items-center"
                       title={`${a.k} — balance for collection ${money(a.bal)} (works ${money(a.cg)}, retention ${money(a.cr)})`}>
                    <span style={{ fontFamily: MONO, fontSize: 8, lineHeight: "13px", whiteSpace: "nowrap",
                                   color: T.works, letterSpacing: "-.02em" }}>
                      {a.bal > 0 ? compact(a.bal) : ""}
                    </span>
                    <div className="flex flex-col justify-end" style={{ width: 24, height: h(a.bal) }}>
                      <div style={{ height: h(a.cr), background: T.retention }} />
                      <div style={{ height: h(a.cg), background: T.works }} />
                    </div>
                  </div>
                  {/* collected */}
                  <div className="flex flex-col items-center" title={`${a.k} — collected ${money(a.net)}`}>
                    <span style={{ fontFamily: MONO, fontSize: 8, lineHeight: "13px", whiteSpace: "nowrap",
                                   color: T.collected, letterSpacing: "-.02em" }}>
                      {a.net > 0 ? compact(a.net) : ""}
                    </span>
                    <div style={{ width: 24, height: h(a.net), background: T.collected }} />
                  </div>
                </div>
              ))}
            </div>

            {/* labels */}
            <div className="flex items-start">
              {show.map((a) => (
                <div key={a.k} title={`${a.k} · ${a.n} project${a.n === 1 ? "" : "s"}`}
                     className="text-center" style={{ flex: "1 1 0", minWidth: COLW, padding: "5px 2px 0" }}>
                  <div style={{
                    fontFamily: MONO, fontSize: 9, lineHeight: 1.2, color: T.inkSoft,
                    overflow: "hidden", overflowWrap: "anywhere", wordBreak: "break-word",
                    display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", maxHeight: 33,
                  }}>
                    {a.k}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: T.inkSoft, marginTop: 7, lineHeight: 1.2 }}>
                    {a.n} Project{a.n === 1 ? "" : "s"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {show.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.works }} />unbilled works</span>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.retention }} />retention</span>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.collected }} />collected</span>
          <span>left column = balance for collection{arr.length > 12 ? ` · top 12 of ${arr.length}` : ""}</span>
        </div>
      )}
    </Panel>
  );
}

function StatusChart({ rows }) {
  const arr = useMemo(() => {
    const g = new Map();
    rows.forEach((r) => {
      if (!g.has(r.status)) g.set(r.status, { k: r.status, n: 0, bal: 0 });
      const o = g.get(r.status); o.n++; o.bal += r.bal || 0;
    });
    return [...g.values()].sort((a, b) => b.bal - a.bal);
  }, [rows]);
  const max = Math.max(1, ...arr.map((a) => a.bal));
  return (
    <Panel title="Balance for collection by project status">
      {arr.length === 0 && <div className="py-8 text-center text-xs" style={{ color: T.inkFaint }}>Nothing to chart.</div>}
      <div className="project-status-chart-body" style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-around", gap: 6 }}>
      {arr.map((a) => (
        <div key={a.k} className="project-status-chart-row">
          <div className="project-status-chart-line flex items-center gap-2 text-xs">
            <span className="project-status-chart-label w-20 shrink-0 truncate font-semibold" title={a.k}>{a.k}</span>
            <span className="project-status-chart-bar h-3.5 flex-1" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
              <span className="block h-full" style={{ width: (a.bal / max) * 100 + "%", background: T.collected }} />
            </span>
            <span className="project-status-chart-value w-24 shrink-0 text-right text-[11px]" style={{ fontFamily: MONO, color: T.inkSoft }}>{compact(a.bal)}</span>
          </div>
          <div className="project-status-chart-count mt-0.5 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint, marginLeft: 88 }}>
            {a.n} project{a.n === 1 ? "" : "s"}
          </div>
        </div>
      ))}
      </div>
    </Panel>
  );
}

/* ---------------- table ---------------- */

function EditCell({ value, type, onChange }) {
  const [focus, setFocus] = useState(false);
  const v = value ?? "";
  const numericValue = type === "amount" ? toNum(v) : null;
  const displayValue = type === "amount" && !focus && v !== ""
    ? (numericValue === null ? v : money(numericValue))
    : v;

  return (
    <input
      value={displayValue}
      type={type === "date" ? "date" : "text"}
      inputMode={type === "qty" || type === "amount" ? "decimal" : undefined}
      list={type === "status" ? "project-status-suggestions" : undefined}
      onChange={(e) => onChange(type === "amount"
        ? e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1")
        : e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
      style={{
        width: "100%", border: `1px solid ${focus ? T.collected : "transparent"}`,
        background: focus ? T.panel : "transparent", borderRadius: 2, padding: "1px 4px",
        fontFamily: type === "text" ? BODY : MONO, fontSize: 11.5, color: T.ink,
        textAlign: type === "qty" || type === "amount" ? "right" : "left", outline: "none",
      }}
    />
  );
}

function AuditModal({ target, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    let query = supabase.from("project_manual_update_audit")
      .select("id, column_name, old_value, new_value, source, action, changed_by_username, changed_at")
      .in("project_id", target.projectIds?.length ? target.projectIds : [target.projectId])
      .eq("column_name", AUDIT_FIELD_LABELS[target.field])
      .order("changed_at", { ascending: false });
    if (target.targetId) query = query.eq("target_id", target.targetId);
    query
      .then(({ data, error: queryError }) => {
        if (!alive) return;
        if (queryError) setError(queryError.message);
        else setLogs(data || []);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [target]);

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
         style={{ position: "fixed", inset: 0, zIndex: 20, background: "rgba(22,33,28,.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="audit-title"
           style={{ width: "min(680px, 100%)", maxHeight: "80vh", overflow: "auto", background: T.panel,
                    border: `1px solid ${T.ink}`, borderRadius: 2, boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <div>
            <h2 id="audit-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 700, textTransform: "uppercase" }}>
              Audit trail · {AUDIT_FIELD_LABELS[target.field]}
            </h2>
            <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 11, color: T.inkSoft }}>Project ID: {target.projectId}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close audit trail"
                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink, padding: "3px 8px", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: 16 }}>
          {loading && <div style={{ color: T.inkFaint, fontSize: 12 }}>Loading audit history…</div>}
          {error && <div style={{ color: T.bad, fontSize: 12 }}>Could not load audit history: {error}</div>}
          {!loading && !error && !logs.length && <div style={{ color: T.inkFaint, fontSize: 12 }}>No saved changes for this cell yet.</div>}
          {!loading && !error && logs.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                {[["When", "left"], ["Activity", "left"], ["User", "left"], ["Previous value", "left"], ["New value", "left"]].map(([label, align]) => (
                  <th key={label} style={{ padding: "6px 7px", textAlign: align, borderBottom: `2px solid ${T.ink}`,
                                            fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{label}</th>
                ))}
              </tr></thead>
              <tbody>{logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap", fontFamily: MONO, fontSize: 10.5 }}>
                    {new Date(log.changed_at).toLocaleString()}
                  </td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap",
                               color: log.source === "excel" ? T.works : T.inkSoft, fontWeight: 600 }}>
                    {log.source === "excel" ? "Excel updated" : "Manual edit"}
                  </td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}` }}>{log.changed_by_username}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, color: T.inkSoft }}>{log.old_value ?? "—"}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, fontWeight: 600 }}>{log.new_value ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}


/* The one cell that stands in for the six target columns. It has to read at a
   glance, so it leads with the count and names only the worst standing — that
   is the part that decides whether somebody needs to open it. */
function TargetSummaryCell({ record, onOpen }) {
  /* Not a button when the list could not be loaded. Manage targets would open
     on an empty list, and adding a target there would duplicate whatever this
     project already has. Saying nothing is known is the only honest state. */
  if (record.targetsUnavailable) {
    return (
      <span title="This project's targets could not be loaded, so none can be shown or added. Reload the page."
            style={{ display: "block", padding: "3px 7px", borderRadius: 2,
                     border: `1px dashed ${T.rule}`, background: T.paper2,
                     fontFamily: MONO, fontSize: 11, color: T.inkFaint, lineHeight: 1.35 }}>
        Unavailable
      </span>
    );
  }

  const s = record.targetSummary;
  const label = s.active === 0 ? "Add target"
    : `${s.active} target${s.active === 1 ? "" : "s"}`;
  const worst = s.worst && s.worst.rank <= 1 ? s.worst.bucket : null;
  const detail = [
    worst ? worst.toLowerCase() : null,
    s.drafts.length ? `${s.drafts.length} draft${s.drafts.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const tone = worst ? BUCKET_COLOR[worst] : s.active === 0 ? T.inkFaint : T.inkSoft;

  return (
    <button type="button" onClick={onOpen}
            title={`Manage targets for ${record.id}`}
            aria-label={`Manage targets for ${record.id} — ${label}${detail ? ", " + detail : ""}`}
            style={{ width: "100%", textAlign: "left", cursor: "pointer", borderRadius: 2,
                     border: `1px solid ${worst ? tone : T.ruleSoft}`,
                     background: worst ? BUCKET_COLOR[worst] + "14" : T.panel,
                     padding: "3px 7px", font: "inherit", lineHeight: 1.35 }}>
      <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 600,
                     color: s.active === 0 ? T.inkFaint : T.ink }}>
        {s.active === 0 ? "+ " : ""}{label}
      </span>
      <span style={{ fontFamily: MONO, fontSize: 10, color: T.inkFaint }}> ›</span>
      {detail && (
        <span style={{ display: "block", fontFamily: MONO, fontSize: 10, color: tone }}>{detail}</span>
      )}
    </button>
  );
}

function LedgerTable({ rows, sort, onSort, onExport, onEdit, onSaveRow, onSaveAll, onAuditCell,
                      onManageTargets, multipleTargetsEnabled, dirtyIds, dirtyCount, savingIds, statusOptions = [] }) {
  const [showCollection, setShowCollection] = useState(false);
  /* the four collection-detail columns fold away by default; the export always
     carries every column regardless of what is on screen */
  const cols = useMemo(() => COLS
    .flatMap((column) => (!multipleTargetsEnabled && column.targets ? INLINE_TARGET_COLS : [column]))
    .filter((column) => !column.group || showCollection), [showCollection, multipleTargetsEnabled]);
  const groupCount = COLS.filter((c) => c.group === "collection").length;
  const data = useMemo(() => {
    const d = rows.slice();
    const { dir } = sort;
    /* the summary cell holds an object, so sorting that column sorts on how
       many targets a project has */
    const key = sort.key === "targetSummary" ? "targetCount" : sort.key;
    d.sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
      return String(x ?? "").localeCompare(String(y ?? "")) * dir;
    });
    return d;
  }, [rows, sort]);

  const th = { position: "sticky", top: 0, background: T.paper2, zIndex: 3, textAlign: "left", padding: "7px 9px",
    borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase",
    letterSpacing: ".06em", cursor: "pointer", whiteSpace: "nowrap" };
  const stick = { position: "sticky", left: 0, background: T.panel, zIndex: 2, borderRight: `1px solid ${T.rule}` };
  const pillColor = (s) => (s === "ONGOING" ? T.collected : s === "SUSPENDED" ? T.bad : T.inkFaint);

  return (
    <Panel title="Projects" right={
      <div className="project-ledger-actions flex items-center gap-2">
        <span className="text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>({data.length})</span>
        <button onClick={() => setShowCollection(!showCollection)}
                className="rounded-sm px-3 py-1 text-xs"
                title="Collected (net), balance works, retention, balance for collection, net balance"
                style={{ border: `1px solid ${T.collected}`,
                         background: showCollection ? T.collected : "#E4EFEC",
                         color: showCollection ? T.paper2 : T.collected,
                         fontFamily: DISPLAY, fontWeight: 700, letterSpacing: ".04em",
                         textTransform: "uppercase", fontSize: 10.5, whiteSpace: "nowrap",
                         boxShadow: showCollection ? "none" : `0 0 0 2px ${T.collected}22` }}>
          {showCollection ? "▾ Hide" : "▸ Show"} collection detail ({groupCount})
        </button>
        <button onClick={onSaveAll} disabled={!dirtyCount || savingIds.size > 0}
                className="project-save-action rounded-sm px-2.5 py-1 text-xs"
                aria-label="Save changes" title="Save changes"
                style={{ border: `1px solid ${dirtyCount ? T.collected : T.rule}`,
                         background: dirtyCount ? T.collected : T.paper2,
                         color: dirtyCount ? T.paper2 : T.inkFaint,
                         fontFamily: DISPLAY, fontWeight: 700, cursor: dirtyCount ? "pointer" : "default" }}>
          <svg className="project-action-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8V3M8 21v-6h8v6"/></svg>
          <span className="project-action-label">{savingIds.size ? "Saving…" : `Save changes${dirtyCount ? ` (${dirtyCount})` : ""}`}</span>
        </button>
        <button onClick={() => onExport(data)} className="project-export-action rounded-sm px-2.5 py-1 text-xs"
                aria-label="Export filtered CSV" title="Export filtered CSV"
                style={{ border: `1px solid ${T.rule}`, background: T.panel, color: T.inkSoft }}>
          <svg className="project-action-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v3h14v-3"/></svg>
          <span className="project-action-label">Export filtered CSV</span>
        </button>
      </div>
    }>
      <datalist id="project-status-suggestions">
        {statusOptions.map((status) => <option key={status} value={status} />)}
      </datalist>
      {data.length === 0 ? (
        <div className="py-10 text-center text-xs" style={{ color: T.inkFaint }}>No projects match these filters.</div>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: 620 }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.k} onClick={() => onSort(c.k)}
                      style={{ ...th, ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w,
                                                 whiteSpace: c.stick ? "nowrap" : "normal" } : {}),
                               color: c.edit ? "#C28A00" : T.ink,
                               ...(c.stick ? { ...stick, background: T.paper2, zIndex: 4 } : {}) }}>
                    {c.label}{c.edit && <span aria-hidden="true" style={{ color: T.bad, marginLeft: 3, fontWeight: 800 }}>*</span>} <span style={{ fontFamily: MONO, color: T.inkFaint }}>{sort.key === c.k ? (sort.dir > 0 ? "▲" : "▼") : "↕"}</span>
                  </th>
                ))}
                <th style={{ ...th, cursor: "default", width: 68, minWidth: 68 }}>Save</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r, ri) => (
                <tr key={r.id + "|" + ri}>
                  {cols.map((c) => {
                    const v = r[c.k];
                    const base = { padding: "6px 9px", borderBottom: `1px solid ${T.ruleSoft}`, verticalAlign: "top" };
                    const wStyle = c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden" } : {};
                    const auditProps = AUDIT_FIELD_LABELS[c.k] ? { onContextMenu: (e) => {
                      e.preventDefault();
                      onAuditCell({ projectId: r.auditId || r.id, projectIds: r.auditIds, field: c.k, value: v });
                    } } : {};
                    if (c.group) base.background = "#F2F6F1";
                    if (c.targets) return (
                      <td key={c.k} style={{ ...base, ...wStyle, padding: "3px 5px" }}>
                        <TargetSummaryCell record={r} onOpen={() => onManageTargets(r)} />
                      </td>
                    );
                    if (c.targetField && r.targetsUnavailable) return (
                      <td key={c.k} style={{ ...base, ...wStyle, padding: "6px 9px", color: T.inkFaint,
                                             background: T.paper2, fontFamily: MONO, fontSize: 10.5 }}
                          title="Targets could not be loaded, so editing is disabled.">
                        Unavailable
                      </td>
                    );
                    if (c.edit) return (
                      <td key={c.k} onContextMenu={(e) => {
                        e.preventDefault();
                        onAuditCell({ projectId: r.auditId || r.id, projectIds: r.auditIds,
                                      targetId: c.targetField ? r.primaryTarget?.id : null,
                                      field: c.k, value: v });
                      }} onClick={(e) => {
                        if (e.target.tagName !== "INPUT") e.currentTarget.querySelector("input")?.focus();
                      }}
                          style={{ ...base, ...wStyle, padding: "3px 5px", background: "#FBFCFA", cursor: "text" }}>
                        <EditCell value={v} type={c.edit} onChange={(nv) => onEdit(r.id, c.k, nv)}
                        />
                      </td>
                    );
                    if (c.money) return <td key={c.k} {...auditProps} style={{ ...base, ...wStyle, fontFamily: MONO, textAlign: "right", whiteSpace: "nowrap", cursor: auditProps.onContextMenu ? "help" : undefined }}>
                      {v !== null && v !== undefined ? money(v) : <span style={{ color: T.inkFaint }}>{c.group && !r.collectionAvailable ? "None" : "—"}</span>}</td>;
                    if (c.pct) return <td key={c.k} {...auditProps} style={{ ...base, ...wStyle, fontFamily: MONO, textAlign: "right", cursor: auditProps.onContextMenu ? "help" : undefined }}>
                      {v === null && !r.collectionAvailable ? <span style={{ color: T.inkFaint }}>None</span> : pct(v)}</td>;
                    if (c.pill) return <td key={c.k} {...auditProps} style={base}>
                      <span className="inline-block rounded-full px-2 py-px text-[10.5px]"
                            style={{ border: `1px solid ${pillColor(v)}`, color: pillColor(v) }}>{v}</span></td>;
                    return <td key={c.k} {...auditProps} title={c.stick
                      ? [v, r.name, r.qmbOverlap ? "Also exists in QMB PROJECTS; QM LICENSES values are used" : ""].filter(Boolean).join(" \u2014 ")
                      : v} style={{ ...base,
                      ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden", textOverflow: "ellipsis" } : {}),
                      ...(c.stick ? { ...stick, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap", padding: "6px 8px", fontSize: 11.5 } : {}),
                      ...(c.wide ? { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {}),
                      cursor: auditProps.onContextMenu ? "help" : undefined }}>{v}
                      {c.stick && r.qmbOverlap && <span aria-label="Also exists in QMB Projects" title="Also exists in QMB PROJECTS; QM LICENSES values are used"
                        style={{ marginLeft: 5, color: T.works, fontWeight: 800 }}>ⓘ</span>}
                    </td>;
                  })}
                  <td style={{ padding: "3px 5px", borderBottom: `1px solid ${T.ruleSoft}`, textAlign: "center" }}>
                    <button type="button" title={`Save changes for ${r.id}`} aria-label={`Save changes for ${r.id}`}
                            onClick={() => onSaveRow(r.id)} disabled={!dirtyIds.has(r.id) || savingIds.has(r.id)}
                            style={{ border: `1px solid ${dirtyIds.has(r.id) ? T.collected : T.rule}`,
                                     background: dirtyIds.has(r.id) ? "#E4EFEC" : T.paper2,
                                     color: dirtyIds.has(r.id) ? T.collected : T.inkFaint, borderRadius: 2,
                                     padding: "2px 6px", cursor: dirtyIds.has(r.id) ? "pointer" : "default", fontSize: 13 }}>
                      {savingIds.has(r.id) ? "…" : "▣"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {cols.map((c, i) => {
                  const base = { position: "sticky", bottom: 0, background: T.paper2, borderTop: `2px solid ${T.ink}`,
                    padding: "7px 9px", fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap", zIndex: 3 };
                  if (i === 0) return <td key={c.k} style={{ ...base, ...stick, background: T.paper2, zIndex: 4,
                    width: c.w, minWidth: c.w, maxWidth: c.w, padding: "7px 8px", fontSize: 11 }}>TOTAL</td>;
                  if (c.k === "district") return <td key={c.k} style={base}>{data.length} projects</td>;
                  if (c.money) return <td key={c.k} style={{ ...base, textAlign: "right",
                    ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden" } : {}) }}>{money(sum(data, c.k))}</td>;
                  if (c.k === "swa") {
                    const w2 = data.filter((r) => r.swa !== null && r.swa !== undefined);
                    const ct2 = sum(w2, "contract");
                    return <td key={c.k} style={{ ...base, textAlign: "right" }}>
                      {pct(ct2 ? w2.reduce((t, r) => t + r.swa * (r.contract || 0), 0) / ct2 : null)}</td>;
                  }
                  if (c.k === "billpct") { const ct = sum(data, "contract");
                    return <td key={c.k} style={{ ...base, textAlign: "right" }}>{pct(ct ? sum(data, "gross") / ct : null)}</td>; }
                  /* the count is of targets, not of projects that have one —
                     those are different numbers now and the label says which */
                  if (c.k === "targetSummary") return <td key={c.k} style={{ ...base, textAlign: "right",
                    ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w } : {}) }}>
                    {data.some((r) => r.targetsUnavailable)
                      ? <span style={{ color: T.inkFaint }}>unavailable</span>
                      : `${data.reduce((n, r) => n + r.targetCount, 0)} targets`}</td>;
                  return <td key={c.k} style={base} />;
                })}
                <td style={{ position: "sticky", bottom: 0, background: T.paper2, borderTop: `2px solid ${T.ink}` }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ---------------- target tracking ---------------- */

/* The standing calculation now lives in ./lib/targets and runs per target
   record rather than per project. Everything it needs is a target field; the
   project is carried as a reference so that no aggregate can accidentally sum
   a project's balance once per target. */

/* "Behind target" used to sit here too. No branch ever assigned it — the
   scoring was simplified at some point and the bucket was left behind, so it
   silently contributed nothing to the standings bar and a constant zero to the
   "behind" figure in the KPI beneath it. It has been removed. */
const BUCKET_COLOR = {
  "Overdue": T.bad, "Critical": "#D2A21C",
  "On track": T.collected, "Delivered on time": T.collected, "Delivered": T.inkSoft,
};
const DRAFT_COLOR = T.inkFaint;

/* the two standings that demand action are filled rather than outlined, so they
   carry across a room; everything else stays a quiet outline */
const BUCKET_PILL = {
  "Overdue":  { bg: T.bad,     fg: "#FFFFFF", bd: T.bad,     weight: 700 },
  "Critical": { bg: "#F0CB45", fg: T.ink,     bd: "#C79E1E", weight: 700 },
};
/* every standing renders at the same size so the column reads as one control,
   sized to the longest label ("Delivered on time") */
const PILL_BASE = {
  display: "inline-block", width: 112, textAlign: "center", padding: "2px 6px",
  borderRadius: 999, fontSize: 10, lineHeight: "13px", whiteSpace: "nowrap",
};
const pillStyle = (b) => {
  const s = BUCKET_PILL[b];
  return s
    ? { ...PILL_BASE, background: s.bg, color: s.fg, border: `1px solid ${s.bd}`, fontWeight: s.weight }
    : { ...PILL_BASE, background: "transparent", color: BUCKET_COLOR[b], border: `1px solid ${BUCKET_COLOR[b]}`, fontWeight: 500 };
};

function TargetAnalysis({ rows }) {
  const { tracked, drafts } = useMemo(() => assessTargets(rows), [rows]);
  /* Every row shares one target load, so if any is unknown they all are. */
  const unavailable = rows.some((r) => r.targetsUnavailable);

  if (unavailable) {
    return (
      <Panel title="Target tracking and priority">
        <div className="py-8 text-center text-xs" style={{ color: T.inkFaint, lineHeight: 1.7 }}>
          Targets could not be loaded, so nothing can be tracked here.<br />
          This is not the same as having no targets — reload the page to try again.
        </div>
      </Panel>
    );
  }

  if (tracked.length === 0) {
    return (
      <Panel title="Target tracking and priority">
        <div className="py-8 text-center text-xs" style={{ color: T.inkFaint, lineHeight: 1.7 }}>
          No targets set yet.<br />
          Open <b>Manage targets</b> on any row above and add one with a <b>Target qty</b> or a{" "}
          <b>Target completion</b> date, and it will appear here.
          {drafts.length > 0 && (
            <><br /><span style={{ color: T.works }}>
              {drafts.length} draft target{drafts.length === 1 ? "" : "s"} {drafts.length === 1 ? "is" : "are"} waiting
              for a quantity or a deadline.
            </span></>
          )}
        </div>
      </Panel>
    );
  }

  const buckets = ["Overdue", "Critical", "On track", "Delivered on time", "Delivered"];
  const counts = {};
  buckets.forEach((b) => (counts[b] = tracked.filter((t) => t.bucket === b)));

  /* Two different aggregations, kept apart on purpose. Every at-risk target is
     counted; the money behind them is counted once per project. A project with
     three overdue targets has three at-risk targets and one balance — summing
     the balance per target would triple a real peso figure while looking
     entirely reasonable. */
  const risk = atRiskExposure(tracked);
  const notAchieved = tracked.filter((t) => !t.done);
  const projectsTracked = distinctProjectCount(tracked);

  /* action items first; targets already met on time are listed underneath as a
     record of what has landed, and never carry a priority weight */
  const actionItems = tracked.filter((t) => t.rank <= 1).slice(0, 10);
  const onTrack = tracked.filter((t) => t.bucket === "On track").slice(0, 8);
  /* both delivered standings belong in the record of what has landed — a late
     delivery is if anything the more useful one to see */
  const achieved = tracked.filter((t) => t.done)
    .sort((a, b) => (b.project.bal || 0) - (a.project.bal || 0)).slice(0, 8);
  const priority = [...actionItems, ...onTrack, ...achieved];
  /* normalise the bar inside each bucket — otherwise one huge overdue project
     flattens every critical bar to a sliver */
  const bucketMax = {};
  priority.forEach((p) => { bucketMax[p.bucket] = Math.max(bucketMax[p.bucket] || 1, p.score); });

  return (
    <Panel title="Target tracking and priority" right={
      <span className="text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
        {tracked.length} target{tracked.length === 1 ? "" : "s"} across {projectsTracked} of {rows.length} projects
        {drafts.length > 0 && <> · {drafts.length} draft{drafts.length === 1 ? "" : "s"} not tracked</>}
      </span>
    }>
      {/* headline numbers */}
      <div className="mb-3 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Kpi label="Targets tracked" value={tracked.length}
             meta={`across ${projectsTracked} project${projectsTracked === 1 ? "" : "s"}`} />
        <Kpi label="Achieved on time" value={counts["Delivered on time"].length} color={T.collected}
             meta={counts["Delivered"].length
               ? `${counts["Delivered"].length} delivered, not confirmed on time`
               : "every delivery on time"} />
        <Kpi label="Not yet achieved" value={notAchieved.length}
             meta={`${counts["Overdue"].length} overdue · ${counts["Critical"].length} critical · ${counts["On track"].length} on track`} />
        <Kpi label="Overdue targets" value={counts["Overdue"].length} color={T.bad}
             meta="past completion date" />
        {/* the value is the projects' combined balance, counted once each; the
            meta line says how many targets and projects produced it, so the two
            aggregations can never be read as one */}
        <Kpi label="Collection at risk" value={compact(risk.money)} color={T.works}
             meta={risk.targetCount
               ? `${risk.targetCount} target${risk.targetCount === 1 ? "" : "s"} · ${risk.projectCount} project${risk.projectCount === 1 ? "" : "s"} · ${money(risk.money)}`
               : "no targets at risk"} />
      </div>

      {/* how the tracked set splits */}
      <div className="mb-1 text-[10px] uppercase tracking-widest"
           style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>Where they stand</div>
      <div className="project-target-status-bar mb-3 flex h-6 overflow-hidden" style={{ border: `1px solid ${T.ink}`, background: T.paper2 }}>
        {buckets.map((b) => counts[b].length ? (
          <div key={b} title={`${b} — ${counts[b].length} target${counts[b].length === 1 ? "" : "s"}`}
               style={{ width: (counts[b].length / tracked.length) * 100 + "%", background: BUCKET_COLOR[b] }} />
        ) : null)}
      </div>
      <div className="project-target-status-legend mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: T.inkSoft }}>
        {buckets.map((b) => counts[b].length ? (
          <span key={b}>
            <span className="mr-1.5 inline-block h-2.5 w-2.5 align-[-1px]" style={{ background: BUCKET_COLOR[b] }} />
            {b} <b style={{ fontFamily: MONO, color: T.ink }}>{counts[b].length}</b>
          </span>
        ) : null)}
      </div>

      {/* the ranked worklist */}
      <div className="mb-1.5 text-[10px] uppercase tracking-widest"
           style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>
        Work these first — on-track and completed targets are listed underneath
      </div>
      <div className="overflow-x-auto">
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 11.5 }}>
          <thead>
            <tr>
              {[["#"], ["Project"], ["Scope"], ["District / engineer"], ["Standing"], ["Target qty", "right"],
                ["Actual", "right"], ["Done", "right"], ["Pace", "right"], ["Due"], ["Remarks"],
                ["Project balance", "right"], ["Priority"]].map(([hd, al]) => (
                <th key={hd} style={{ textAlign: al || "left", padding: "5px 8px",
                                      borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 9.5,
                                      textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap" }}>{hd}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {priority.map((p, i) => (
              <tr key={p.id} style={p.done || p.bucket === "On track" ? { background: "#F7FAF6" } : undefined}>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, color: T.inkFaint }}>
                  {p.done ? "\u2713" : p.bucket === "On track" ? "—" : i + 1}</td>
                <td title={p.project.name} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap" }}>{p.projectId}</td>
                {/* what the quantity on this row is actually for — without it two
                    targets of one project are indistinguishable */}
                <td title={p.scope || "No scope specified"} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`,
                             maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                             color: p.scope ? T.ink : T.inkFaint, fontStyle: p.scope ? "normal" : "italic" }}>
                  {p.scope || "No scope specified"}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.project.district} · <span style={{ color: T.inkSoft }}>{p.project.engineer}</span>
                </td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}>
                  <span style={pillStyle(p.bucket)}>{p.bucket}</span>
                </td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right" }}>
                  {qty(p.target)}{p.unit ? <span style={{ color: T.inkFaint }}> {p.unit}</span> : null}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right" }}>
                  {qty(p.actual)}{p.unit ? <span style={{ color: T.inkFaint }}> {p.unit}</span> : null}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right",
                             color: p.progress !== null && p.progress < 1 ? T.bad : T.collected }}>
                  {p.progress === null ? "—" : (p.progress * 100).toFixed(0) + "%"}</td>
                <td title={p.capacity === null
                    ? "Set a start date to measure the daily rate"
                    : `${qty(p.capacity.toFixed(2))} ${p.unit || "units"}/day achieved · ${qty((p.needRate || 0).toFixed(2))} needed · ${qty(Math.round(p.canDeliver))} deliverable in ${p.days} days vs ${qty(p.remaining)} outstanding`}
                    style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right",
                             color: p.pace === null ? T.inkFaint : p.pace < 1 ? T.bad : T.collected }}>
                  {p.pace === null ? "—" : p.pace.toFixed(2) + "\u00D7"}</td>
                {/* once delivered, the countdown to the deadline is meaningless —
                    what matters is the day it landed and by how much it missed */}
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, whiteSpace: "nowrap",
                             color: !p.done && p.days !== null && p.days < 0 ? T.bad : T.inkSoft }}>
                  {p.due ? fmtDate(p.due) : "—"}
                  {p.done ? (
                    p.lateDays === null
                      ? <span style={{ color: T.inkFaint }}> · completion date not set</span>
                      : <span style={{ color: p.lateDays > 0 ? T.bad : T.collected }}>
                          {" · "}{fmtDate(p.finish)}
                          {p.lateDays > 0 ? ` (${p.lateDays}d late)` : " (on time)"}
                        </span>
                  ) : p.days !== null && (
                    <span style={{ color: T.inkFaint }}> · {p.days < 0 ? Math.abs(p.days) + "d late" : p.days + "d left"}</span>
                  )}
                </td>
                {/* Remarks belongs to the project, so every target of one project
                    shows the same value. It is read through the reference, never
                    copied onto the target. */}
                <td title={p.project.note || ""} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`,
                             maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                             color: p.project.note ? T.ink : T.inkFaint }}>
                  {p.project.note || "—"}</td>
                {/* the project's balance, repeated per target and never summable —
                    the column is named for the project for exactly that reason */}
                <td title={`Balance for collection on project ${p.projectId} — one figure for the project, not per target`}
                    style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right", whiteSpace: "nowrap" }}>
                  {money(p.project.bal || 0)}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, width: 90 }}>
                  {p.done || p.bucket === "On track" ? (
                    <span style={{ fontFamily: MONO, fontSize: 10, color: T.inkFaint }}>—</span>
                  ) : (
                    <span className="block h-2" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
                      <span className="block h-full" style={{ width: (p.score / bucketMax[p.bucket]) * 100 + "%", background: BUCKET_COLOR[p.bucket] }} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint, lineHeight: 1.6 }}>
        One row per target, so a project with several targets appears several times. On track means the target
        completion date is more than three days away and the target has not yet been reached. Critical means the
        deadline is within three days; overdue means the deadline has passed. A target counts as delivered when
        Actual output reaches Target qty, and as <b>delivered on time</b> only when its Actual completion date is on
        or before the Target completion date — leave that date blank and it stays <b>delivered</b>, since there is
        nothing to prove it landed on time. Priority ranks overdue and critical targets first. <b>Project balance</b>
        belongs to the project, not the target: it repeats across a project's targets and is counted once in
        Collection at risk. Draft targets — no quantity and no deadline — are listed in Manage targets and tracked
        nowhere.
      </div>
    </Panel>
  );
}

/* ---------------- manage targets ----------------
   The project's own fields appear here as text and never as inputs. That is
   what keeps a target edit from touching contract, status or remarks — there is
   no control to mis-click, which is stronger than any warning.
------------------------------------------------- */

const TARGET_COLUMNS = [
  { k: "scope", label: "Scope", type: "text", w: 200 },
  { k: "target_qty", label: "Target qty", type: "qty", w: 92 },
  { k: "unit", label: "Unit", type: "text", w: 80 },
  { k: "start_date", label: "Start date", type: "date", w: 132 },
  { k: "target_completion", label: "Target completion", type: "date", w: 132 },
  { k: "actual_completion", label: "Actual completion", type: "date", w: 132 },
  { k: "actual_output", label: "Actual output", type: "qty", w: 96 },
];

const emptyTarget = () => ({
  scope: "", target_qty: "", unit: "", start_date: "",
  target_completion: "", actual_completion: "", actual_output: "",
});

const draftPill = {
  ...PILL_BASE, background: "transparent", color: DRAFT_COLOR,
  border: `1px dashed ${DRAFT_COLOR}`, fontWeight: 500,
};

/* ---------------- target history ----------------
   Read-only, and layered above Manage targets rather than replacing it, so
   checking what changed never costs unsaved edits.

   The per-cell audit trail on the ledger row is left exactly as it was: it
   answers "what happened to this one field", which is still the right question
   for status, contract and remarks. It cannot answer this one. Target fields no
   longer have cells of their own to right-click, and a save that touched four
   fields of one target reads as four unrelated entries there. This view groups
   by the save.
------------------------------------------------- */

const ACTION_TONE = {
  create: T.collected,
  update: T.cash,
  archive: T.inkFaint,
  restore: T.works,
};

const DATE_FIELD_KEYS = new Set(["start_date", "target_completion", "actual_completion"]);

/* Stored as text, so it is shown as text — except for dates, which are written
   as ISO and read badly that way. Nothing else is reinterpreted: a quantity is
   displayed exactly as it was recorded, because reformatting an audit value
   risks showing something other than what was saved. */
const historyValue = (fieldKey, value) => {
  if (isBlankValue(value)) return "—";
  return DATE_FIELD_KEYS.has(fieldKey) ? fmtDate(value) : String(value);
};

const targetLabel = (target) =>
  target?.scope || (target?.archived_at ? "Archived target" : "Target with no scope");

function TargetHistoryModal({ project, targets, focusTargetId = null, onClose }) {
  const stored = useMemo(() => (targets || []).filter((t) => t && t.id && !String(t.id).startsWith("new:")),
    [targets]);
  const ids = useMemo(() => stored.map((t) => t.id), [stored]);
  const scopeById = useMemo(() => new Map(stored.map((t) => [t.id, targetLabel(t)])), [stored]);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(focusTargetId || "all");

  /* The initial state is already "loading", so nothing is set synchronously
     here: the modal is mounted fresh each time it is opened, and `targets` is
     the stored list, which does not change while it is open. */
  useEffect(() => {
    let alive = true;
    loadTargetHistory(ids)
      .then((data) => { if (alive) { setRows(data); setError(""); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.message || String(e)); setLoading(false); } });
    return () => { alive = false; };
  }, [ids]);

  /* Every target's rows are fetched once and narrowed here, so switching
     between targets costs no request and the whole-project view is free. */
  const events = useMemo(() => groupTargetHistory(
    selected === "all" ? rows : rows.filter((r) => r.target_id === selected),
  ), [rows, selected]);

  const heading = { padding: "6px 7px", textAlign: "left", borderBottom: `1px solid ${T.ruleSoft}`,
    fontFamily: DISPLAY, fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em", color: T.inkFaint };

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
         style={{ position: "fixed", inset: 0, zIndex: 26, background: "rgba(22,33,28,.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="target-history-title"
           style={{ width: "min(760px, 100%)", maxHeight: "84vh", display: "flex", flexDirection: "column",
                    background: T.panel, border: `1px solid ${T.ink}`, borderRadius: 2,
                    boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>

        <div className="flex items-start justify-between gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <div style={{ minWidth: 0 }}>
            <h2 id="target-history-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 700, textTransform: "uppercase" }}>
              Target history
            </h2>
            <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 11, color: T.inkSoft }}>
              {project.id}{project.name ? ` — ${project.name}` : ""}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close target history"
                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink,
                           padding: "3px 8px", cursor: "pointer" }}>×</button>
        </div>

        {stored.length > 1 && (
          <div className="px-4 py-2" style={{ borderBottom: `1px solid ${T.ruleSoft}`, background: T.paper2 }}>
            <label style={{ fontFamily: MONO, fontSize: 10.5, color: T.inkSoft }}>
              Show{" "}
              <select value={selected} onChange={(e) => setSelected(e.target.value)}
                      aria-label="Which target to show history for"
                      style={{ fontFamily: MONO, fontSize: 11, color: T.ink, background: T.panel,
                               border: `1px solid ${T.rule}`, borderRadius: 2, padding: "2px 5px" }}>
                <option value="all">All targets ({stored.length})</option>
                {stored.map((t) => (
                  <option key={t.id} value={t.id}>{targetLabel(t)}{t.archived_at ? " · archived" : ""}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div style={{ overflow: "auto", flex: 1, padding: "12px 16px" }}>
          {loading && <div style={{ color: T.inkFaint, fontSize: 12 }}>Loading target history…</div>}
          {error && <div role="alert" style={{ color: T.bad, fontSize: 12 }}>Could not load target history: {error}</div>}
          {!loading && !error && !events.length && (
            <div className="py-8 text-center text-xs" style={{ color: T.inkFaint, lineHeight: 1.7 }}>
              {ids.length === 0
                ? <>No saved targets yet.<br />History starts once a target is saved.</>
                : <>No recorded changes yet.<br />Every save from this point on is listed here.</>}
            </div>
          )}

          {!loading && !error && events.map((event) => {
            const tone = ACTION_TONE[event.action] || T.inkSoft;
            /* Whose target this was matters only when several are on screen. */
            const scope = selected === "all"
              ? (event.targetScope || scopeById.get(event.targetId) || null)
              : null;
            return (
              <div key={event.key} style={{ border: `1px solid ${T.ruleSoft}`, borderRadius: 2, marginBottom: 10 }}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2"
                     style={{ background: T.paper2, borderBottom: isEventOnly(event) ? "none" : `1px solid ${T.ruleSoft}` }}>
                  <span style={{ ...PILL_BASE, width: "auto", minWidth: 66, background: tone + "1A",
                                 color: tone, border: `1px solid ${tone}55`, fontWeight: 600 }}>
                    {actionLabel(event.action)}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.ink }}>
                    {event.changedAt ? new Date(event.changedAt).toLocaleString() : "Date not recorded"}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.inkSoft }}>· {event.user}</span>
                  {scope && (
                    <span style={{ fontSize: 10.5, color: T.inkSoft, minWidth: 0, overflow: "hidden",
                                   textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {scope}</span>
                  )}
                  {/* Rows written before the targets table existed carry no
                      batch, and were made on the ledger row rather than here.
                      Saying so is more honest than presenting them as if they
                      came from this modal. */}
                  {event.source === "panel" && (
                    <span style={{ fontFamily: MONO, fontSize: 10, color: T.inkFaint }}>· from the ledger row</span>
                  )}
                </div>

                {!isEventOnly(event) && (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                    <thead><tr>
                      <th style={{ ...heading, width: 170 }}>Field</th>
                      <th style={heading}>Previous value</th>
                      <th style={heading}>New value</th>
                    </tr></thead>
                    <tbody>
                      {event.fields.map((field, i) => (
                        <tr key={`${event.key}:${field.fieldKey || field.label}:${i}`}>
                          <td style={{ padding: "6px 7px", borderBottom: `1px solid ${T.ruleSoft}`, color: T.inkSoft }}>
                            {field.label}
                          </td>
                          <td style={{ padding: "6px 7px", borderBottom: `1px solid ${T.ruleSoft}`,
                                       fontFamily: MONO, fontSize: 10.5, color: T.inkFaint }}>
                            {historyValue(field.fieldKey, field.from)}
                          </td>
                          <td style={{ padding: "6px 7px", borderBottom: `1px solid ${T.ruleSoft}`,
                                       fontFamily: MONO, fontSize: 10.5, color: T.ink, fontWeight: 600 }}>
                            {historyValue(field.fieldKey, field.to)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-4 py-2" style={{ borderTop: `1px solid ${T.rule}`, background: T.paper2 }}>
          <span className="text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
            One entry per save. Archiving keeps a target and its history on record — nothing here is ever deleted.
          </span>
        </div>
      </div>
    </div>
  );
}

function TargetsModal({ project, onClose, onSaved }) {
  const stored = useMemo(() => project.targets || [], [project.targets]);
  const originals = useMemo(() => new Map(stored.map((t) => [t.id, t])), [stored]);

  const [rows, setRows] = useState(() => stored.map((t) => ({
    ...t,
    target_qty: t.target_qty ?? "", unit: t.unit ?? "", scope: t.scope ?? "",
    start_date: t.start_date ?? "", target_completion: t.target_completion ?? "",
    actual_completion: t.actual_completion ?? "", actual_output: t.actual_output ?? "",
  })));
  const [showArchived, setShowArchived] = useState(false);
  /* null while closed; { targetId } while open, where a null targetId means the
     whole project. Opening it changes nothing about the edits in progress. */
  const [history, setHistory] = useState(null);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const nextId = useRef(0);
  const today = useMemo(() => todayMs(), []);

  const isPendingArchived = (r) => Boolean((r.archived_at && !r._restore) || r._archive);
  const visible = rows.filter((r) => showArchived || !isPendingArchived(r));
  const archivedCount = rows.filter(isPendingArchived).length;

  const edit = (id, field, value) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));

  const addTarget = () => {
    const id = `new:${nextId.current++}`;
    setRows((prev) => [...prev, { id, _isNew: true, ...emptyTarget() }]);
    setMessage("");
  };

  /* A new row has never been written, so discarding it is just dropping it.
     A stored one is archived rather than deleted: nothing in this schema grants
     DELETE, and its audit history references it. */
  const removeTarget = (row) => {
    if (row._isNew) { setRows((prev) => prev.filter((r) => r.id !== row.id)); return; }
    const name = row.scope || "this target";
    if (!window.confirm(`Archive ${name}? It stops counting towards tracking but stays on record and can be restored.`)) return;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, _archive: true, _restore: false } : r)));
  };
  const restoreTarget = (row) =>
    setRows((prev) => prev.map((r) => (r.id === row.id
      ? { ...r, _restore: Boolean(r.archived_at) && !r._restore, _archive: false } : r)));

  /* Live standing, computed from what is currently typed rather than from what
     was last saved, so the pill answers the row in front of you. */
  const standingOf = (row) => {
    if (isPendingArchived(row)) return { label: "Archived", style: draftPill };
    if (!isTrackable(row)) return { label: "Draft", style: draftPill };
    return { label: assessTarget(project, row, today).bucket, style: null };
  };

  const changedRows = () => {
    const creates = [], updates = [], archives = [], restores = [];
    for (const row of rows) {
      const before = originals.get(row.id);
      if (row._isNew) { if (!row._archive) creates.push(row); continue; }
      if (row._archive && !before.archived_at) { archives.push(before); continue; }
      if (row._restore && before.archived_at) restores.push(before);
      if (row._archive) continue;
      const differs = TARGET_FIELDS.some(([field]) =>
        String(blankToNull(row[field]) ?? "") !== String(before[field] ?? ""));
      if (differs) updates.push({ id: row.id, before, after: row });
    }
    return { creates, updates, archives, restores };
  };

  const save = async () => {
    const { creates, updates, archives, restores } = changedRows();
    if (!creates.length && !updates.length && !archives.length && !restores.length) {
      setMessage("Nothing to save.");
      return;
    }

    const found = {};
    for (const row of creates) {
      const e = validateTarget(row, { isNew: true });
      if (Object.keys(e).length) found[row.id] = e;
    }
    for (const { id, after } of updates) {
      const e = validateTarget(after, { isNew: false });
      if (Object.keys(e).length) found[id] = e;
    }
    setErrors(found);
    if (Object.keys(found).length) {
      setMessage("Fix the highlighted fields before saving.");
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      await saveTargets({ projectId: project.id, creates, updates, archives, restores });
      const parts = [
        creates.length && `${creates.length} added`,
        updates.length && `${updates.length} updated`,
        archives.length && `${archives.length} archived`,
        restores.length && `${restores.length} restored`,
      ].filter(Boolean);
      await onSaved(`Targets for ${project.id}: ${parts.join(", ")}.`);
      onClose();
    } catch (error) {
      setMessage(`Could not save: ${error.message}`);
      setBusy(false);
    }
  };

  const pending = changedRows();
  const pendingCount = pending.creates.length + pending.updates.length
    + pending.archives.length + pending.restores.length;

  const close = () => {
    if (pendingCount && !window.confirm("Discard unsaved target changes?")) return;
    onClose();
  };

  const head = { padding: "6px 8px", borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY,
    fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap", textAlign: "left" };

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
         style={{ position: "fixed", inset: 0, zIndex: 24, background: "rgba(22,33,28,.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="targets-title"
           style={{ width: "min(1120px, 100%)", maxHeight: "86vh", display: "flex", flexDirection: "column",
                    background: T.panel, border: `1px solid ${T.ink}`, borderRadius: 2,
                    boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>

        {/* project context — read-only, and deliberately not inputs */}
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <div className="flex items-start justify-between gap-3">
            <div style={{ minWidth: 0 }}>
              <h2 id="targets-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 700, textTransform: "uppercase" }}>
                Manage targets
              </h2>
              <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 12, color: T.ink, fontWeight: 600 }}>
                {project.id}{project.name ? ` — ${project.name}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Disabled rather than hidden when there is nothing to show, so
                  the control does not appear and disappear as targets are
                  added. A new row has no history until it is saved. */}
              <button type="button" onClick={() => setHistory({ targetId: null })} disabled={!stored.length}
                      title={stored.length ? "Every recorded change to this project's targets" : "No saved targets yet"}
                      style={{ border: `1px solid ${stored.length ? T.rule : T.ruleSoft}`, background: T.paper2,
                               color: stored.length ? T.inkSoft : T.inkFaint, borderRadius: 2,
                               padding: "3px 9px", fontSize: 11, whiteSpace: "nowrap",
                               cursor: stored.length ? "pointer" : "default" }}>
                History
              </button>
              <button type="button" onClick={close} aria-label="Close manage targets"
                      style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink,
                               padding: "3px 8px", cursor: "pointer" }}>×</button>
            </div>
          </div>
          <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 10.5, color: T.inkFaint }}>
            {project.district} · {project.engineer} · Status {project.status} · Contract {money(project.contract)}
            <span style={{ color: T.inkFaint }}> · project information, edited on the ledger row</span>
          </div>
        </div>

        {/* targets */}
        <div style={{ overflow: "auto", flex: 1, padding: "12px 16px" }}>
          {visible.length === 0 ? (
            <div className="py-8 text-center text-xs" style={{ color: T.inkFaint, lineHeight: 1.7 }}>
              No targets yet.<br />Add one to start tracking this project's deliverables.
            </div>
          ) : (
            <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 12 }}>
              <thead>
                <tr>
                  {TARGET_COLUMNS.map((c) => (
                    <th key={c.k} style={{ ...head, width: c.w, minWidth: c.w }}>
                      {c.label}{c.k === "scope" && <span aria-hidden="true" style={{ color: T.bad, marginLeft: 3 }}>*</span>}
                    </th>
                  ))}
                  <th style={{ ...head, width: 124, minWidth: 124 }}>Standing</th>
                  <th style={{ ...head, width: 96, minWidth: 96, textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const rowErrors = errors[row.id] || {};
                  const archived = isPendingArchived(row);
                  const standing = standingOf(row);
                  const warnings = archived ? [] : targetWarnings(row);
                  return (
                    <tr key={row.id} style={archived ? { opacity: 0.55 } : undefined}>
                      {TARGET_COLUMNS.map((c) => (
                        <td key={c.k} style={{ padding: "3px 4px", borderBottom: `1px solid ${T.ruleSoft}`,
                                               verticalAlign: "top",
                                               background: rowErrors[c.k] ? "#FBEEEC" : row._isNew ? "#F3F8F4" : "transparent" }}>
                          {archived ? (
                            <span style={{ fontFamily: c.type === "text" ? BODY : MONO, fontSize: 11.5,
                                           padding: "1px 4px", display: "block", color: T.inkSoft }}>
                              {row[c.k] === "" || row[c.k] === null ? "—" : String(row[c.k])}
                            </span>
                          ) : (
                            <EditCell value={row[c.k]} type={c.type} onChange={(v) => edit(row.id, c.k, v)} />
                          )}
                          {rowErrors[c.k] && (
                            <div style={{ color: T.bad, fontSize: 10, padding: "1px 4px" }}>{rowErrors[c.k]}</div>
                          )}
                          {/* a migrated target legitimately has no scope; say so
                              rather than inventing one */}
                          {c.k === "scope" && !archived && !row._isNew && !row.scope && !rowErrors.scope && (
                            <div style={{ color: T.inkFaint, fontSize: 10, fontStyle: "italic", padding: "1px 4px" }}>
                              No scope specified
                            </div>
                          )}
                        </td>
                      ))}
                      <td style={{ padding: "5px 6px", borderBottom: `1px solid ${T.ruleSoft}`, verticalAlign: "top" }}>
                        <span style={standing.style || pillStyle(standing.label)}>{standing.label}</span>
                        {warnings.map((w) => (
                          <div key={w} style={{ color: T.works, fontSize: 10, marginTop: 3, lineHeight: 1.3 }}>{w}</div>
                        ))}
                      </td>
                      <td style={{ padding: "5px 6px", borderBottom: `1px solid ${T.ruleSoft}`, textAlign: "center", verticalAlign: "top" }}>
                        <div className="flex flex-col items-center gap-1">
                        {row.archived_at ? (
                          <button type="button" onClick={() => restoreTarget(row)}
                                  title={row._restore ? "Cancel this restore" : "Bring this target back into tracking"}
                                  style={{ border: `1px solid ${row._restore ? T.collected : T.rule}`,
                                           background: row._restore ? "#E4EFEC" : T.paper2,
                                           color: row._restore ? T.collected : T.inkSoft,
                                           borderRadius: 2, padding: "2px 7px", fontSize: 10.5, cursor: "pointer" }}>
                            {row._restore ? "Restoring" : "Restore"}
                          </button>
                        ) : (
                          <button type="button" onClick={() => removeTarget(row)}
                                  title={row._isNew ? "Discard this new target" : "Archive this target"}
                                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.inkSoft,
                                           borderRadius: 2, padding: "2px 7px", fontSize: 10.5, cursor: "pointer" }}>
                            {row._isNew ? "Discard" : "Archive"}
                          </button>
                        )}
                        {/* A row that has never been saved has nothing to show,
                            so it gets no control rather than an empty view. */}
                        {!row._isNew && (
                          <button type="button" onClick={() => setHistory({ targetId: row.id })}
                                  title={`Every recorded change to ${row.scope || "this target"}`}
                                  style={{ border: "none", background: "none", color: T.inkFaint,
                                           padding: "0 2px", fontSize: 10, textDecoration: "underline",
                                           cursor: "pointer" }}>
                            History
                          </button>
                        )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={addTarget}
                    style={{ border: `1px solid ${T.collected}`, background: "#E4EFEC", color: T.collected,
                             borderRadius: 2, padding: "4px 10px", fontFamily: DISPLAY, fontWeight: 700,
                             fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em", cursor: "pointer" }}>
              + Add target
            </button>
            {archivedCount > 0 && (
              <label className="text-[11px]" style={{ fontFamily: MONO, color: T.inkSoft, cursor: "pointer" }}>
                <input type="checkbox" checked={showArchived} onChange={() => setShowArchived(!showArchived)}
                       style={{ accentColor: T.collected, marginRight: 5 }} />
                Show archived ({archivedCount})
              </label>
            )}
            <span className="text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
              Scope is required for a new target. A target with no quantity and no completion date stays a draft
              and is not tracked.
            </span>
          </div>
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
             style={{ borderTop: `1px solid ${T.rule}`, background: T.paper2 }}>
          <div className="text-[11.5px]" role={message.startsWith("Could") || message.startsWith("Fix") ? "alert" : undefined}
               style={{ fontFamily: MONO, color: message.startsWith("Could") || message.startsWith("Fix") ? T.bad : T.inkSoft }}>
            {message || `${rows.filter((r) => !isPendingArchived(r)).length} target${rows.filter((r) => !isPendingArchived(r)).length === 1 ? "" : "s"}${pendingCount ? ` · ${pendingCount} unsaved change${pendingCount === 1 ? "" : "s"}` : ""}`}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={close} disabled={busy}
                    style={{ border: `1px solid ${T.rule}`, background: T.panel, color: T.inkSoft,
                             borderRadius: 2, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={busy || !pendingCount}
                    style={{ border: `1px solid ${pendingCount ? T.collected : T.rule}`,
                             background: pendingCount ? T.collected : T.paper2,
                             color: pendingCount ? T.paper2 : T.inkFaint, borderRadius: 2,
                             padding: "5px 14px", fontFamily: DISPLAY, fontWeight: 700, fontSize: 12,
                             cursor: pendingCount ? "pointer" : "default" }}>
              {busy ? "Saving…" : `Save changes${pendingCount ? ` (${pendingCount})` : ""}`}
            </button>
          </div>
        </div>
      </div>

      {/* Layered above this modal rather than replacing it, and reading the
          targets as they are stored rather than as they are being edited —
          history is what happened, not what is about to. */}
      {history && (
        <TargetHistoryModal project={project} targets={stored} focusTargetId={history.targetId}
                            onClose={() => setHistory(null)} />
      )}
    </div>
  );
}

function PasswordChangePanel({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError("");
    if (password.length < 6 || password.length > 8) return setError("Password must be between 6 and 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    // Supabase's normal client update enforces the configured weak-password
    // check. This special flow is already limited to users with a temporary
    // password, so complete it through the protected server-side operation.
    const { data: passwordData, error: passwordError } = await supabase.functions.invoke("complete-password-change", {
      body: { password },
    });
    const passwordMessage = passwordData?.error || passwordError?.message;
    if (!passwordMessage) {
      const { error: profileError } = await supabase.rpc("complete_password_change");
      if (profileError) setError(profileError.message);
      else {
        setSuccess(true);
        window.setTimeout(onDone, 1800);
      }
    } else setError(passwordMessage);
    setBusy(false);
  };
  const field = { width: "100%", padding: "9px 11px", fontFamily: MONO, fontSize: 13, color: T.ink,
    background: T.paper2, border: `1px solid ${T.rule}`, borderRadius: 2, outline: "none" };
  return <div style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,33,28,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <style>{`@keyframes password-success-pop { 0% { transform: scale(.35); opacity: 0; } 70% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }`}</style>
    <form onSubmit={submit} style={{ width: "min(420px,100%)", background: T.panel, padding: 22, border: `1px solid ${T.ink}` }}>
      {success ? <div role="status" style={{ textAlign: "center", padding: "18px 8px 10px" }}>
        <div aria-hidden="true" style={{ width: 58, height: 58, margin: "0 auto 14px", borderRadius: "50%", background: T.collected, color: T.paper2,
                                            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34, fontWeight: 700,
                                            animation: "password-success-pop .55s ease-out both" }}>✓</div>
        <h2 style={{ fontFamily: DISPLAY, fontSize: 15, textTransform: "uppercase", color: T.collected }}>Password changed successfully</h2>
        <p style={{ fontSize: 12, color: T.inkSoft }}>Returning to Project Ledger…</p>
      </div> : <>
        <h2 style={{ fontFamily: DISPLAY, fontSize: 14, textTransform: "uppercase" }}>Change temporary password</h2>
        <p style={{ fontSize: 12, color: T.inkSoft }}>An administrator assigned a temporary password. Choose a private password to continue.</p>
        <input aria-label="New password" type="password" minLength={6} maxLength={8} placeholder="New password (6–8 characters)" value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...field, marginTop: 12 }} />
        <input aria-label="Confirm password" type="password" minLength={6} maxLength={8} placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ ...field, marginTop: 8 }} />
        {error && <div role="alert" style={{ marginTop: 10, color: T.bad, fontSize: 12 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 14, padding: 10, border: 0, background: T.ink, color: T.paper2, fontFamily: DISPLAY, fontWeight: 700 }}>{busy ? "Saving…" : "Change password"}</button>
      </>}
    </form>
  </div>;
}

const formatUploadDateTime = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
};

function DatasetHistoryModal({ onClose, onRestore }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoringId, setRestoringId] = useState("");

  useEffect(() => {
    let alive = true;
    loadDatasetVersions()
      .then((rows) => { if (alive) setVersions(rows); })
      .catch((err) => { if (alive) setError(err.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const restore = async (version) => {
    const label = version.source_label || "this saved dataset";
    if (!window.confirm(`Restore the shared Project Ledger to “${label}”?\n\nThe current imported data will be backed up first. Manual edits, targets and their audit history will not be changed.`)) return;
    setRestoringId(version.id);
    setError("");
    try {
      await onRestore(version);
    } catch (err) {
      setError(err.message);
      setRestoringId("");
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="dataset-history-title"
         style={{ position: "fixed", inset: 0, zIndex: 45, background: "rgba(22,33,28,.45)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(760px,100%)", maxHeight: "min(720px,90vh)", overflow: "auto",
                    background: T.panel, border: `1px solid ${T.ink}`, boxShadow: "0 18px 50px rgba(22,33,28,.22)" }}>
        <div className="flex items-start justify-between gap-4 px-4 py-3"
             style={{ borderBottom: `1px solid ${T.rule}` }}>
          <div>
            <h2 id="dataset-history-title" style={{ fontFamily: DISPLAY, fontSize: 14, fontWeight: 800,
                                                     textTransform: "uppercase", letterSpacing: ".045em" }}>
              Previous shared data
            </h2>
            <p className="mt-1 text-[11.5px]" style={{ color: T.inkSoft }}>
              Each entry is the complete imported ledger saved immediately before an Excel update or restore.
              Restoring changes imported project and collection data only; manual edits, targets and audit history stay as they are.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={Boolean(restoringId)}
                  aria-label="Close previous data"
                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink,
                           padding: "3px 8px", cursor: restoringId ? "default" : "pointer" }}>×</button>
        </div>

        <div className="p-4">
          {loading && <div style={{ color: T.inkSoft, fontSize: 12 }}>Loading restore points…</div>}
          {error && <div role="alert" className="mb-3 px-3 py-2"
                         style={{ color: T.bad, background: "#FBEEEC", border: `1px solid ${T.bad}55`, fontSize: 12 }}>
            Could not restore data: {error}
          </div>}
          {!loading && !error && versions.length === 0 && (
            <div className="px-3 py-8 text-center" style={{ color: T.inkSoft, background: T.paper2,
                                                            border: `1px solid ${T.ruleSoft}`, fontSize: 12 }}>
              No restore point exists yet. The system creates the first one immediately before the next successful Excel update.
            </div>
          )}
          {versions.length > 0 && (
            <div style={{ border: `1px solid ${T.ruleSoft}` }}>
              {versions.map((version, index) => (
                <div key={version.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"
                     style={{ background: index % 2 ? T.paper2 : T.panel,
                              borderBottom: index === versions.length - 1 ? "none" : `1px solid ${T.ruleSoft}` }}>
                  <div style={{ minWidth: 0, flex: "1 1 420px" }}>
                    <div className="text-[10px] uppercase tracking-wider" style={{ fontFamily: MONO, color: T.inkFaint }}>
                      {version.saved_reason === "before_restore" ? "Saved before a restore" : "Saved before an Excel update"}
                      {` · ${formatUploadDateTime(version.saved_at)}`}
                    </div>
                    <div className="mt-1 truncate text-xs" title={version.source_label || "No source label"}
                         style={{ color: T.ink, fontWeight: 600 }}>
                      {version.source_label || "No source label"}
                    </div>
                    <div className="mt-1 text-[10.5px]" style={{ fontFamily: MONO, color: T.inkSoft }}>
                      {version.project_count || 0} projects · originally uploaded by {version.uploaded_by_username || "Unknown user"}
                      {version.uploaded_at ? ` · ${formatUploadDateTime(version.uploaded_at)}` : ""}
                    </div>
                  </div>
                  <button type="button" onClick={() => restore(version)} disabled={Boolean(restoringId)}
                          style={{ border: `1px solid ${T.collected}`, background: restoringId === version.id ? T.paper2 : "#E4EFEC",
                                   color: T.collected, borderRadius: 2, padding: "6px 11px", fontFamily: DISPLAY,
                                   fontWeight: 700, fontSize: 11, textTransform: "uppercase",
                                   cursor: restoringId ? "default" : "pointer", opacity: restoringId && restoringId !== version.id ? .45 : 1 }}>
                    {restoringId === version.id ? "Restoring…" : "Restore this data"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExcelDataButton({ count, disabled, onClick }) {
  return <button type="button" onClick={onClick} disabled={disabled} aria-label={`View ${count} uploaded Excel file${count === 1 ? "" : "s"}`}
    title={count ? "View uploaded Excel files" : "No Excel files uploaded"}
    style={{ position: "relative", width: 34, height: 31, display: "inline-flex", alignItems: "center", justifyContent: "center", border: `1px solid ${count ? T.collected : T.rule}`, background: count ? "#E4EFEC" : T.paper2, color: count ? T.collected : T.inkFaint, opacity: disabled && count ? .6 : 1, cursor: count && !disabled ? "pointer" : "default" }}>
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M13 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-6V2Z" opacity=".28" />
      <path fill="currentColor" d="M3 5.3 14 3v18L3 18.7V5.3Zm3.1 3.1 1.8 3-2 3.2h2l1-1.8 1 1.8h2l-2-3.3 1.8-2.9H9.8L9 9.9l-.9-1.5h-2Z" />
      <path fill="currentColor" d="M15.5 7H19v1.5h-3.5V7Zm0 3.2H19v1.5h-3.5v-1.5Zm0 3.3H19V15h-3.5v-1.5Z" />
    </svg>
    <span style={{ position: "absolute", top: -7, right: -7, minWidth: 18, height: 18, padding: "0 4px", borderRadius: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", background: count ? T.ink : T.rule, color: T.paper2, border: `2px solid ${T.panel}`, fontFamily: MONO, fontSize: 9, fontWeight: 700 }}>{count}</span>
  </button>;
}

function AdminPanel({ onClose, currentUserId, onMultipleTargetsChanged }) {
  const [users, setUsers] = useState([]);
  const [captchaEnabled, setCaptchaEnabled] = useState(true);
  const [temporary, setTemporary] = useState({});
  const [resetSuccess, setResetSuccess] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [uploadOwner, setUploadOwner] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [uploadsBusy, setUploadsBusy] = useState(false);
  const [uploadMessage, setUploadMessage] = useState("");
  const [fileBusy, setFileBusy] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewSheet, setPreviewSheet] = useState("");

  const call = async (body) => {
    setBusy(true); setMessage("");
    const { data, error } = await supabase.functions.invoke("admin-users", { body });
    setBusy(false);
    if (error || data?.error) { setMessage(error?.message || data.error); return null; }
    return data;
  };
  const uploadCall = async (body) => {
    const { data, error } = await supabase.functions.invoke("admin-users", { body });
    if (error || data?.error) throw new Error(error?.message || data.error);
    return data;
  };
  const load = async () => { const data = await call({ action: "list" }); if (data) setUsers(data.users || []); };
  useEffect(() => {
    let alive = true;
    supabase.functions.invoke("admin-users", { body: { action: "list" } }).then(({ data, error }) => {
      if (!alive) return;
      setBusy(false);
      if (error || data?.error) setMessage(error?.message || data.error);
      else { setUsers(data?.users || []); setCaptchaEnabled(data?.captcha_enabled !== false); }
    });
    return () => { alive = false; };
  }, []);
  const resetPassword = async (id) => {
    const value = temporary[id] || "";
    if (value.length < 6 || value.length > 8) { setMessage("Enter a temporary password between 6 and 8 characters."); return; }
    const data = await call({ action: "reset-password", user_id: id, temporary_password: value });
    if (data) { setMessage(`Temporary password created for ${users.find((u) => u.id === id)?.username || "the selected user"}.`); setResetSuccess((p) => ({ ...p, [id]: true })); setTemporary((p) => ({ ...p, [id]: "" })); await load(); }
  };
  const toggleBan = async (u) => { const data = await call({ action: u.banned_until ? "unban" : "ban", user_id: u.id }); if (data) await load(); };
  const toggleCaptcha = async () => {
    const data = await call({ action: "set-captcha", enabled: !captchaEnabled });
    if (data) setCaptchaEnabled(data.captcha_enabled !== false);
  };
  const toggleMultipleTargets = async (selectedUser) => {
    const enabled = !selectedUser.multiple_targets_enabled;
    const data = await call({ action: "set-multiple-targets", user_id: selectedUser.id, enabled });
    if (!data) return;
    setUsers((previous) => previous.map((item) => (item.id === selectedUser.id
      ? { ...item, multiple_targets_enabled: enabled } : item)));
    if (selectedUser.id === currentUserId) onMultipleTargetsChanged(enabled);
    setMessage(`Multiple targets ${enabled ? "enabled" : "disabled"} for ${selectedUser.username || selectedUser.email || "the selected user"}.`);
  };
  const openUploads = async (owner) => {
    setUploadOwner(owner); setUploads([]); setPreview(null); setUploadMessage(""); setUploadsBusy(true);
    try {
      const data = await uploadCall({ action: "list-uploads", user_id: owner.id });
      setUploads(data.uploads || []);
    } catch (error) {
      setUploadMessage(error.message);
    } finally {
      setUploadsBusy(false);
    }
  };
  const closeUploads = () => { setUploadOwner(null); setUploads([]); setPreview(null); setUploadMessage(""); };
  const viewUpload = async (upload) => {
    setFileBusy(`view-${upload.id}`); setUploadMessage(""); setPreview({ upload, loading: true });
    try {
      const { url } = await uploadCall({ action: "file-url", upload_id: upload.id, download: false });
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The workbook could not be opened (${response.status}).`);
      const workbook = XLSX.read(await response.arrayBuffer(), { type: "array" });
      const sheets = Object.fromEntries(workbook.SheetNames.map((name) => [name,
        XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "" })
          .slice(0, 100).map((row) => (Array.isArray(row) ? row.slice(0, 30) : [])),
      ]));
      const firstSheet = workbook.SheetNames[0] || "";
      setPreviewSheet(firstSheet);
      setPreview({ upload, sheets, sheetNames: workbook.SheetNames });
    } catch (error) {
      setPreview({ upload, error: error.message });
    } finally {
      setFileBusy("");
    }
  };
  const downloadUpload = async (upload) => {
    setFileBusy(`download-${upload.id}`); setUploadMessage("");
    try {
      const { url } = await uploadCall({ action: "file-url", upload_id: upload.id, download: true });
      const link = document.createElement("a");
      link.href = url; link.download = upload.original_filename; document.body.appendChild(link); link.click(); link.remove();
    } catch (error) {
      setUploadMessage(error.message);
    } finally {
      setFileBusy("");
    }
  };

  const actionButton = { padding: "4px 7px", border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink, fontSize: 11 };
  const previewRows = preview?.sheets?.[previewSheet] || [];
  return <div style={{ position: "fixed", inset: 0, zIndex: 25, background: "rgba(22,33,28,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <div style={{ width: "min(1100px,100%)", maxHeight: "85vh", overflow: "auto", background: T.panel, border: `1px solid ${T.ink}` }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
        <h2 style={{ fontFamily: DISPLAY, fontSize: 14, textTransform: "uppercase" }}>User management</h2>
        <button type="button" onClick={onClose} style={{ border: `1px solid ${T.rule}`, background: T.paper2, padding: "3px 8px" }}>×</button>
      </div>
      <div style={{ padding: 16 }}>
        {message && <div role="status" style={{ marginBottom: 10, color: message.includes("error") || message.includes("required") ? T.bad : T.inkSoft, fontSize: 12 }}>{message}</div>}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 12px", marginBottom: 14, background: T.paper2, border: `1px solid ${T.rule}` }}>
          <div>
            <div style={{ fontFamily: DISPLAY, fontSize: 11, textTransform: "uppercase" }}>Live CAPTCHA protection</div>
            <div style={{ marginTop: 3, color: T.inkSoft, fontSize: 11 }}>Require hCaptcha on sign-in and password recovery.</div>
          </div>
          <button type="button" disabled={busy} onClick={toggleCaptcha} style={{ minWidth: 92, padding: "6px 9px", border: `1px solid ${captchaEnabled ? T.collected : T.bad}`, background: captchaEnabled ? "#E4EFEC" : "#FBEEEC", color: captchaEnabled ? T.collected : T.bad, fontFamily: DISPLAY, fontWeight: 700, fontSize: 11 }}>
            {captchaEnabled ? "Enabled" : "Disabled"}
          </button>
        </div>
        <div className="overflow-auto"><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr>{["Username", "Email", "Role", "Status", "Temporary password", "Data", "Multiple targets", "Actions"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 7px", borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
          <tbody>{users.map((u) => <tr key={u.id}>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO }}>{u.username || "—"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}>{u.email || "—"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}>{u.role}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, color: u.banned_until ? T.bad : T.collected }}>{u.banned_until ? "Blocked" : "Active"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}><input type="password" minLength={6} maxLength={8} placeholder="6–8 characters" value={temporary[u.id] || ""} onChange={(e) => setTemporary((p) => ({ ...p, [u.id]: e.target.value }))} style={{ width: 150, padding: "4px 6px", border: `1px solid ${T.rule}`, fontFamily: MONO, fontSize: 11 }} /></td>
            <td style={{ padding: "8px 12px 8px 7px", borderBottom: `1px solid ${T.ruleSoft}` }}><ExcelDataButton count={Number(u.upload_count) || 0} disabled={busy || !u.upload_count} onClick={() => openUploads(u)} /></td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}>
              <button type="button" disabled={busy} onClick={() => toggleMultipleTargets(u)}
                      title="Enable or disable the multiple-target modal for this user"
                      style={{ ...actionButton, minWidth: 74,
                               border: `1px solid ${u.multiple_targets_enabled ? T.collected : T.rule}`,
                               background: u.multiple_targets_enabled ? "#E4EFEC" : T.paper2,
                               color: u.multiple_targets_enabled ? T.collected : T.inkSoft }}>
                {u.multiple_targets_enabled ? "Enabled" : "Disabled"}
              </button>
            </td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}><button type="button" disabled={busy} onClick={() => resetPassword(u.id)} style={{ ...actionButton, marginRight: 6, background: resetSuccess[u.id] ? "#E4EFEC" : T.paper2, color: resetSuccess[u.id] ? T.collected : T.ink }}>{resetSuccess[u.id] ? "Created ✓" : "Reset"}</button><button type="button" disabled={busy} onClick={() => toggleBan(u)} style={{ ...actionButton, border: `1px solid ${u.banned_until ? T.collected : T.bad}`, color: u.banned_until ? T.collected : T.bad }}>{u.banned_until ? "Unblock" : "Block"}</button></td>
          </tr>)}</tbody>
        </table></div>
      </div>
    </div>

    {uploadOwner && <div style={{ position: "fixed", inset: 0, zIndex: 28, background: "rgba(22,33,28,.58)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(980px,100%)", maxHeight: "88vh", overflow: "auto", background: T.panel, border: `1px solid ${T.ink}`, boxShadow: "0 18px 55px rgba(22,33,28,.24)" }}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <div><h3 style={{ fontFamily: DISPLAY, fontSize: 13, textTransform: "uppercase" }}>Uploaded Excel files</h3><div style={{ marginTop: 2, color: T.inkSoft, fontSize: 11 }}>{uploadOwner.username || uploadOwner.email || "User"} · {uploads.length} file{uploads.length === 1 ? "" : "s"}</div></div>
          <button type="button" onClick={closeUploads} style={{ border: `1px solid ${T.rule}`, background: T.paper2, padding: "3px 8px" }}>×</button>
        </div>
        <div style={{ padding: 16 }}>
          {uploadMessage && <div role="alert" style={{ marginBottom: 10, color: T.bad, fontSize: 12 }}>{uploadMessage}</div>}
          {uploadsBusy ? <div style={{ padding: 20, color: T.inkSoft, textAlign: "center", fontSize: 12 }}>Loading uploaded files…</div> : uploads.length === 0 ? <div style={{ padding: 20, color: T.inkSoft, textAlign: "center", fontSize: 12 }}>No uploaded Excel files were found.</div> :
            <div className="overflow-auto"><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>{["Excel title", "Uploaded date and time", "Actions"].map((h) => <th key={h} style={{ textAlign: "left", padding: "7px 8px", borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
              <tbody>{uploads.map((upload) => <tr key={upload.id}>
                <td style={{ padding: 8, borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, overflowWrap: "anywhere" }}>{upload.original_filename}</td>
                <td style={{ padding: 8, borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}>{formatUploadDateTime(upload.uploaded_at)}</td>
                <td style={{ padding: 8, borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}><button type="button" disabled={Boolean(fileBusy)} onClick={() => viewUpload(upload)} style={{ ...actionButton, marginRight: 6 }}>{fileBusy === `view-${upload.id}` ? "Opening…" : "View"}</button><button type="button" disabled={Boolean(fileBusy)} onClick={() => downloadUpload(upload)} style={actionButton}>{fileBusy === `download-${upload.id}` ? "Preparing…" : "Download"}</button></td>
              </tr>)}</tbody>
            </table></div>}

          {preview && <div style={{ marginTop: 16, border: `1px solid ${T.rule}`, background: T.paper2 }}>
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${T.ruleSoft}` }}>
              <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, overflowWrap: "anywhere" }}>{preview.upload.original_filename}</div>
              <div className="flex items-center gap-2">{preview.sheetNames?.length > 0 && <select value={previewSheet} onChange={(e) => setPreviewSheet(e.target.value)} style={{ padding: "4px 7px", border: `1px solid ${T.rule}`, background: T.panel, fontSize: 11 }}>{preview.sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}</select>}<button type="button" onClick={() => setPreview(null)} style={actionButton}>Close preview</button></div>
            </div>
            {preview.loading ? <div style={{ padding: 24, color: T.inkSoft, textAlign: "center", fontSize: 12 }}>Reading workbook…</div> : preview.error ? <div role="alert" style={{ padding: 14, color: T.bad, fontSize: 12 }}>{preview.error}</div> : <><div className="overflow-auto" style={{ maxHeight: 330 }}><table style={{ borderCollapse: "collapse", minWidth: "100%", fontFamily: MONO, fontSize: 10 }}><tbody>{previewRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={{ maxWidth: 260, padding: "4px 6px", borderRight: `1px solid ${T.ruleSoft}`, borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: rowIndex === 0 ? 700 : 400 }}>{String(cell)}</td>)}</tr>)}</tbody></table></div><div style={{ padding: "6px 9px", color: T.inkFaint, fontSize: 10 }}>Preview shows the first 100 rows and 30 columns of the selected sheet.</div></>}
          </div>}
        </div>
      </div>
    </div>}
  </div>;
}

/* ---------------- app ---------------- */

export default function ProjectLedger({ user, onSignOut }) {
  const [store, setStore] = useState(EMPTY_STORE);
  const [sourceLabel, setSourceLabel] = useState("Loading…");
  const [uploadedBy, setUploadedBy] = useState("");
  const [dataReady, setDataReady] = useState(false);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [datasetHistoryOpen, setDatasetHistoryOpen] = useState(false);

  /* Both loads carry their own outcome rather than defaulting to an empty Map.
     A failure that renders as "nothing found" is what let a save overwrite
     stored values with the blanks it was showing. See ./lib/panelData. */
  const [manual, setManual] = useState(loadingState);
  const [targets, setTargets] = useState(loadingState);
  const [manageTarget, setManageTarget] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [savingIds, setSavingIds] = useState(new Set());
  const [saveMessage, setSaveMessage] = useState("");
  const [username, setUsername] = useState(user?.user_metadata?.username || user?.email || "Unknown user");
  const [role, setRole] = useState("user");
  const [multipleTargetsEnabled, setMultipleTargetsEnabled] = useState(false);
  const [forcePasswordChange, setForcePasswordChange] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [auditTarget, setAuditTarget] = useState(null);

  useEffect(() => {
    let alive = true;
    /* Settled independently and deliberately. Awaiting them together meant one
       rejection discarded the other's result, so a missing targets table took
       every hand-typed status, contract and remark off the screen with it. */
    Promise.allSettled([loadManual(), loadTargets()]).then(([m, t]) => {
      if (!alive) return;
      const manualState = settleLoad(m);
      const targetState = settleLoad(t);
      setManual(manualState);
      setTargets(targetState);
      const problems = [
        hasFailed(manualState) && `saved project updates (${manualState.error})`,
        hasFailed(targetState) && `targets (${targetState.error})`,
      ].filter(Boolean);
      if (problems.length) setSaveMessage(`Could not load ${problems.join(" and ")}.`);
    });
    if (isConfigured && supabase && user?.id) {
      supabase.from("profiles").select("username, role, force_password_change, multiple_targets_enabled").eq("id", user.id).maybeSingle()
        .then(({ data }) => {
          if (!alive || !data) return;
          if (data.username) setUsername(data.username);
          setRole(data.role || "user");
          setForcePasswordChange(Boolean(data.force_password_change));
          setMultipleTargetsEnabled(Boolean(data.multiple_targets_enabled));
        });
    }
    return () => { alive = false; };
  }, [user]);

  /* the shared dataset, applied on load and whenever somebody asks for a reload */
  const applyDataset = (row) => {
    if (!row) {
      setStore(EMPTY_STORE);
      setSourceLabel(isConfigured ? NO_DATA_LABEL : "Supabase not configured — imports cannot be saved");
      setUploadedBy("");
      return;
    }
    setStore(row.store);
    setSourceLabel(row.label || `${row.store.coll.length} projects`);
    setUploadedBy(row.username ? `uploaded by ${row.username}${row.at ? " · " + fmtDate(row.at.slice(0, 10)) : ""}` : "");
  };

  useEffect(() => {
    let alive = true;
    loadDataset().then((row) => {
      if (!alive) return;
      applyDataset(row);
      setDataReady(true);
    }).catch((error) => {
      if (!alive) return;
      setSourceLabel("Could not load the saved ledger");
      setLog([{ warn: true, text: `Could not load the saved ledger: ${error.message}` }]);
      setDataReady(true);
    });
    return () => { alive = false; };
  }, []);

  const reloadDataset = async () => {
    setReloading(true);
    try {
      applyDataset(await loadDataset());
      setLog([]);
    } catch (error) {
      setLog([{ warn: true, text: `Could not reload the saved ledger: ${error.message}` }]);
    } finally {
      setReloading(false);
    }
  };

  const restorePreviousDataset = async (version) => {
    await restoreDatasetVersion(version.id);
    const restored = await loadDataset();
    applyDataset(restored);
    setDatasetHistoryOpen(false);
    setLog([{ text: `Restored previous shared data: ${version.source_label || "saved dataset"}. Manual edits, targets and audit history were retained.` }]);
  };

  const editManual = (id, field, value) =>
    setDrafts((prev) => {
      const row = { ...(prev[id] || {}) };
      row[field] = value;
      const next = { ...prev };
      next[id] = row;
      return next;
    });

  /* "still loading" and "failed" are different: only the first shows a spinner
     message, but neither may be treated as an answer. */
  const manualLoading = !isReady(manual) && !hasFailed(manual);

  const dirtyIds = useMemo(() => new Set(Object.keys(drafts)), [drafts]);
  const dirtyCount = useMemo(() => Object.values(drafts)
    .reduce((count, row) => count + Object.keys(row).length, 0), [drafts]);

  const saveRow = async (id) => {
    if (!drafts[id] || savingIds.has(id)) return;
    const draft = drafts[id];
    const manualDraft = {};
    const targetDraft = {};
    for (const [field, value] of Object.entries(draft)) {
      if (INLINE_TARGET_FIELD_KEYS.has(field)) targetDraft[field] = value;
      else manualDraft[field] = value;
    }
    const hasManualChanges = Object.keys(manualDraft).length > 0;
    const hasTargetChanges = Object.keys(targetDraft).length > 0;
    const key = projectKey(id);
    const importedRow = importedRows.find((row) => row.id === id) || {};
    const manualPlan = hasManualChanges ? buildManualSave({
      manual, id, key, draft: manualDraft, importedRow,
      entry: isReady(manual) ? resolvedEntry(manual.value, importedRow, legacyAssignments) : undefined,
    }) : null;
    if (manualPlan && !manualPlan.ok) { setSaveMessage(`Could not save ${id}: ${manualPlan.reason}`); return; }

    let targetPlan = null;
    if (hasTargetChanges) {
      if (!isReady(targets)) {
        setSaveMessage(`Could not save ${id}: targets are unavailable. Reload the page and try again.`);
        return;
      }
      const current = records.find((record) => record.id === id);
      const primary = current?.primaryTarget || null;
      const after = {
        ...(primary || { ...emptyTarget(), project_id: id, scope: "Primary target" }),
        ...targetDraft,
      };
      const errors = validateTarget(after, { isNew: !primary });
      if (Object.keys(errors).length) {
        setSaveMessage(`Could not save ${id}: ${Object.values(errors)[0]}`);
        return;
      }
      targetPlan = primary
        ? { projectId: id, updates: [{ id: primary.id, before: primary, after }] }
        : { projectId: id, creates: [after] };
    }

    setSavingIds((prev) => new Set(prev).add(id));
    setSaveMessage("");
    try {
      /* The existing target RPCs keep target values and their audit rows in one
         transaction. If a row contains project-level edits too, a retry is safe:
         an already-applied target update becomes a no-op on the second call. */
      if (targetPlan) await saveTargets(targetPlan);
      if (manualPlan) {
        const { storedId, values, previous, changedFields } = manualPlan;
        await saveManualRow(storedId, values, previous, user?.id, username, changedFields);
        setManual((prev) => ({ ...prev, value: new Map(prev.value).set(key, { storedId, values }) }));
      }
      const targetsReloaded = targetPlan ? await refreshTargets() : true;
      setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
      if (targetsReloaded) setSaveMessage(`Saved changes for ${id}.`);
    } catch (error) {
      setSaveMessage(`Could not save ${id}: ${error.message}`);
    } finally {
      setSavingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  /* Targets are reloaded from the server after a modal save rather than patched
     in place, so the ids and timestamps the database generated are what the UI
     goes on holding. */
  const refreshTargets = async (message) => {
    try {
      const map = await loadTargets();
      setTargets(settleLoad({ status: "fulfilled", value: map }));
      if (message) setSaveMessage(message);
      return true;
    } catch (error) {
      /* The save itself succeeded, so the stored list is now ahead of what is
         on screen. Marking it unavailable is what stops the stale copy being
         offered as the current one. */
      setTargets(settleLoad({ status: "rejected", reason: error }));
      setSaveMessage(`Targets saved, but the list could not be reloaded: ${error.message}`);
      return false;
    }
  };

  const saveAll = async () => {
    const ids = [...dirtyIds];
    for (const id of ids) await saveRow(id);
  };

  const [filters, setFilters] = useState(() => { const o = {}; DIMS.forEach((d) => (o[d.k] = new Set())); return o; });
  const [q, setQ] = useState("");
  const [groupBy, setGroupBy] = useState("district");
  const [sort, setSort] = useState({ key: "bal", dir: -1 });

  const importedRows = useMemo(() => assemble(store.coll, store.dim), [store]);
  /* Version-1 datasets had no durable assignment for Project-ID-only manual
     data. Derive it immediately so existing values never disappear while the
     user is waiting to make the first year-aware import; the next save of the
     shared dataset persists the same assignment. */
  const legacyAssignments = useMemo(
    () => extendLegacyAssignments(store.legacy, importedRows),
    [store.legacy, importedRows],
  );
  /* imported columns and hand-typed columns are merged only at render time — an
     import rebuilds `importedRows` and never touches `manual` */
  const records = useMemo(() => {
    const today = todayMs();
    return importedRows.map((r) => {
      const key = projectKey(r.id);
      const entry = isReady(manual) ? resolvedEntry(manual.value, r, legacyAssignments) : undefined;
      const m = entry?.values;
      const draft = drafts[r.id];
      const merged = m ? { ...r, ...m } : { ...r };
      const set = (x) => x !== undefined && x !== null && x !== "";

      /* Targets hang off the project rather than being flattened into it, so
         the main table stays one row per project and every total, count, meter
         and chart below keeps reading exactly one value per project. */
      /* the spelling this project's saved values and history are filed under,
         which is not always how the current workbook spells the ID */
      const legacyId = legacyAssignments.get(r.baseKey) === r.identity
        ? r.baseKey : null;
      merged.auditId = entry?.storedId || r.id;
      merged.auditIds = [...new Set([r.id, entry?.storedId, legacyId].filter(Boolean))];
      /* An unavailable target list renders as empty so nothing downstream has
         to special-case it, but it is flagged as unknown rather than reported
         as "No target" — a project whose targets failed to load would
         otherwise invite somebody to add a duplicate of one that exists. */
      const targetsOf = projectTargets(targets, key);
      const legacyTargets = !targetsOf.unavailable && legacyId && legacyId !== key
        ? (targets.value.get(legacyId) || []) : [];
      merged.targets = [...new Map([...targetsOf.targets, ...legacyTargets].map((target) => [target.id, target])).values()];
      merged.targetsUnavailable = targetsOf.unavailable;
      merged.targetSummary = assessProjectTargets(merged, { today });
      merged.primaryTarget = selectPrimaryTarget(merged.targets);
      merged.targetCount = multipleTargetsEnabled
        ? merged.targetSummary.active
        : (merged.primaryTarget ? 1 : 0);
      merged.hasTarget = targetsLabel(targetsOf.unavailable, merged.targetCount);
      merged.scope = merged.primaryTarget?.scope ?? "";
      for (const column of INLINE_TARGET_COLS)
        merged[column.k] = merged.primaryTarget?.[column.k] ?? "";
      if (draft) Object.assign(merged, draft);

      /* Scope is searchable — it is the one target field somebody would look a
         project up by. Remarks stays the project's own field. */
      const scopes = merged.targets.filter((t) => !isArchived(t)).map((t) => t.scope).filter(Boolean);
      if (m || draft || scopes.length)
        merged._hay = [r._hay, merged.status, merged.contract, merged.note, ...scopes]
          .filter(set).join(" ").toLowerCase();
      return merged;
    });
  }, [importedRows, manual, drafts, targets, legacyAssignments, multipleTargetsEnabled]);
  const statusOptions = useMemo(() => [...new Set([
    "ONGOING", "SUSPENDED", "COMPLETED",
    ...records.map((r) => r.status).filter(Boolean),
  ])].sort((a, b) => String(a).localeCompare(String(b))), [records]);

  const handleFiles = async (files) => {
    setBusy(true);
    const out = [];
    const acceptedFiles = [];
    let coll = store.coll, dim = store.dim, gotColl = false, gotMaster = false;
    for (const f of files) {
      try {
        let accepted = false;
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
        const names = wb.SheetNames.map(NORM);
        const isColl = names.some((n) => n.includes("COLLECTIBLE"));
        const isMaster = names.some((n) => n.includes("QMB PROJECT") || n.includes("QM LICENSE"));
        out.push({ text: `${f.name} — ${wb.SheetNames.length} sheets` });
        if (isColl) {
          const r = readCollectibles(wb);
          out.push(...r.log);
          if (r.rows && r.rows.length) { coll = r.rows; gotColl = true; accepted = true; }
        }
        if (isMaster) {
          const r = readMaster(wb);
          out.push(...r.log);
          if (r.dim.size) { dim = r.dim; gotMaster = true; accepted = true; }
        }
        if (!isColl && !isMaster) {
          out.push({ warn: true, text: `${f.name}: no Collectibles / QMB Projects / QM Licenses sheet — skipped` });
        }
        if (accepted) acceptedFiles.push(f);
      } catch (err) {
        out.push({ warn: true, text: `${f.name}: could not be read (${err.message})` });
      }
    }
    if (gotColl || gotMaster) {
      const provisionalRows = assemble(coll, dim);
      const legacy = extendLegacyAssignments(legacyAssignments, provisionalRows);
      const next = { coll, dim, legacy };
      const nextRows = assemble(next.coll, next.dim);
      const matched = nextRows.filter((row) => row.collectionAvailable && (row.inQmb || row.inLicenses)).length;
      const masterOnly = nextRows.filter((row) => !row.collectionAvailable && (row.inQmb || row.inLicenses)).length;
      out.push({ text: `Consolidated: ${nextRows.length} Project ID-Year records · ${matched} matched to Collectibles · ${masterOnly} master-only` });
      if (masterOnly) out.push({ text: `${masterOnly} master project${masterOnly === 1 ? "" : "s"} shown with no collection data` });
      const parts = [];
      if (gotColl) parts.push("collectibles");
      if (gotMaster) parts.push("master");
      const label = `Imported ${parts.join(" + ")} · ${files.map((f) => f.name).join(", ")}`;
      setStore(next);
      setSourceLabel(label);
      /* shown immediately, then saved — a failed save leaves this browser working
         and says so, rather than throwing away a parse that succeeded */
      try {
        const changes = importedChanges(importedRows, nextRows);
        const at = await saveDataset(next, label, changes);
        setUploadedBy(`uploaded by ${username} · ${fmtDate(at.slice(0, 10))}`);
        out.push({ text: `Saved to the shared ledger — ${nextRows.length} projects are now what everyone sees` });
        out.push({ text: `${changes.length} changed Excel field${changes.length === 1 ? "" : "s"} recorded in audit history` });
        let archived = 0;
        for (const file of acceptedFiles) {
          try {
            await archiveLedgerUpload(file, user?.id);
            archived++;
          } catch (error) {
            out.push({ warn: true, text: `${file.name}: ledger data was saved, but the original workbook could not be archived (${error.message})` });
          }
        }
        if (archived) out.push({ text: `${archived} original workbook${archived === 1 ? "" : "s"} added to your upload history` });
      } catch (error) {
        setUploadedBy("not saved — visible in this browser only");
        out.push({ warn: true, text: `Shown here but NOT saved for other users: ${error.message}` });
      }
    }
    setLog(out);
    setBusy(false);
  };

  const query = q.trim().toLowerCase();
  const passes = (r, skip) => {
    for (const d of DIMS) {
      if (d.k === skip) continue;
      const s = filters[d.k];
      if (s.size && !s.has(r[d.k])) return false;
    }
    if (query && !r._hay.includes(query)) return false;
    return true;
  };
  const rows = records.filter((r) => passes(r, null));

  const countsFor = (dimKey) => {
    const m = new Map();
    records.forEach((r) => m.set(r[dimKey], 0));
    records.forEach((r) => { if (passes(r, dimKey)) m.set(r[dimKey], m.get(r[dimKey]) + 1); });
    return m;
  };

  const toggle = (dimKey, value) => setFilters((prev) => {
    const s = new Set(prev[dimKey]);
    s.has(value) ? s.delete(value) : s.add(value);
    return { ...prev, [dimKey]: s };
  });
  const clearOne = (dimKey) => setFilters((prev) => ({ ...prev, [dimKey]: new Set() }));
  const clearAll = () => { const o = {}; DIMS.forEach((d) => (o[d.k] = new Set())); setFilters(o); setQ(""); };
  const onSort = (k) => setSort((s) => (s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: -1 }));

  /* One row per project, as before. The target columns are filled only when a
     project has exactly one live target — true of every project immediately
     after the migration, so existing consumers of this file see no change. With
     several targets they are left blank rather than presenting one of them as
     though it were the whole project; the Targets count says why. */
  const exportCsv = (data) => {
    const qq = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const targetKeys = new Set(EXPORT_TARGET_COLS.map((c) => c.k));
    const cell = (r, c) => {
      /* A count of 0 would be read as fact by whoever opens the file, long
         after the error that produced it is off the screen. The word is the
         only safe thing to write. */
      if (r.targetsUnavailable) {
        if (c.k === "targetCount") return "unavailable";
        if (targetKeys.has(c.k)) return "";
      }
      if (!multipleTargetsEnabled && c.k === "targetCount") return r.primaryTarget ? 1 : 0;
      if (!targetKeys.has(c.k)) return r[c.k];
      if (!multipleTargetsEnabled) return r.primaryTarget ? r[c.k] : "";
      const live = (r.targets || []).filter((t) => !isArchived(t));
      return live.length === 1 ? live[0][c.k] : "";
    };
    const lines = [EXPORT_COLS.map((c) => qq(c.label)).join(",")];
    data.forEach((r) => lines.push(EXPORT_COLS.map((c) => qq(cell(r, c))).join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    a.download = "project-collectibles-filtered.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };

  const contract = sum(rows, "contract"), gross = sum(rows, "gross"), net = sum(rows, "net");
  const cg = sum(rows, "cg"), cc = sum(rows, "cc"), cr = sum(rows, "cr");
  const bal = sum(rows, "bal"), netbal = sum(rows, "netbal");
  const other = Math.max(0, contract - gross - cg);
  const activeSegs = DIMS.filter((d) => filters[d.k].size);
  const anyActive = activeSegs.length > 0 || query.length > 0;
  /* nothing to filter, chart or total until a workbook has been imported */
  const empty = records.length === 0;

  return (
    <div style={{
      background: T.paper, color: T.ink, fontFamily: BODY, fontSize: 14, minHeight: "100vh",
      backgroundImage: `linear-gradient(${T.ruleSoft} 1px,transparent 1px),linear-gradient(90deg,${T.ruleSoft} 1px,transparent 1px)`,
      backgroundSize: "28px 28px", backgroundPosition: "-1px -1px",
    }}>
      <style dangerouslySetInnerHTML={{ __html:
        `@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');` }} />

      <div className="mx-auto max-w-[1480px] px-4 pb-16">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4 pt-5 pb-3" style={{ borderBottom: `2px solid ${T.ink}` }}>
          <div>
            <h1 className="text-2xl uppercase" style={{ fontFamily: DISPLAY, fontWeight: 800, letterSpacing: ".045em" }}>Project Ledger</h1>
            <div className="mt-1 text-xs" style={{ color: T.inkSoft }}>
              Filter by district, license, senior engineer, category, location — read collectibles,
              balance for collection, balance works and status.
            </div>
          </div>
          <div className="flex items-end gap-4 text-right text-[11px] leading-relaxed" style={{ fontFamily: MONO, color: T.inkSoft }}>
            <div>
              {records.length} projects loaded<br />
              master from QMB Projects + QM Licenses
            </div>
            {role === "admin" && <button type="button" onClick={() => setAdminOpen(true)}
              style={{ color: T.ink, background: T.paper2, border: `1px solid ${T.rule}`, fontFamily: MONO, fontSize: 10, padding: "5px 7px", cursor: "pointer" }}>
              User management
            </button>}
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="px-2 py-1 uppercase"
                style={{
                  color: T.ink,
                  background: T.paper2,
                  border: `1px solid ${T.rule}`,
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: ".08em",
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </header>

        <ImportPanel onLoad={handleFiles} sourceLabel={sourceLabel} uploadedBy={uploadedBy}
                     log={log} busy={busy} onReload={reloadDataset}
                     onPrevious={() => setDatasetHistoryOpen(true)} reloading={reloading}
                     forceOpen={dataReady && empty} />

        {empty ? <EmptyLedger loading={!dataReady} configured={isConfigured} /> : <>

        <FilterBar q={q} setQ={setQ} filters={filters} countsFor={countsFor}
                   onToggle={toggle} onClearOne={clearOne} onClearAll={clearAll} anyActive={anyActive} />

        <div className="mb-4 flex flex-wrap items-baseline gap-2 px-3 py-2"
             style={{ background: T.paper2, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.ink}`,
                      fontFamily: MONO, fontSize: 12, color: T.inkSoft }}>
          <span><b style={{ color: T.ink }}>{rows.length}</b> of {records.length} projects</span>
          {activeSegs.length === 0 && !query && <span style={{ color: T.inkFaint }}>› no filters applied</span>}
          {activeSegs.map((d) => (
            <span key={d.k}>
              <span style={{ color: T.inkFaint }}>› </span>{d.label}:{" "}
              <b style={{ color: T.ink }}>{filters[d.k].size <= 2 ? [...filters[d.k]].join(", ") : filters[d.k].size + " selected"}</b>
            </span>
          ))}
          {query && <span><span style={{ color: T.inkFaint }}>› </span>search: <b style={{ color: T.ink }}>{query}</b></span>}
        </div>

        <div>
            <div className="mb-3 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(168px,1fr))" }}>
              <Kpi label="Projects" value={rows.length} meta={`of ${records.length}`} />
              <Kpi label="Contract amount" value={compact(contract)} meta={money(contract)} />
              <Kpi label="Collected (net)" value={compact(net)} color={T.collected}
                   meta={contract ? pct(net / contract) + " of contract" : "—"} />
              <Kpi label="Balance for collection" value={compact(bal)} color={T.works} meta={`net ${compact(netbal)}`} />
              <Kpi label="Balance works" value={compact(cg)} color={T.works}
                   meta={contract ? pct(cg / contract) + " of contract" : "—"} />
              <Kpi label="Retention held" value={compact(cr)} color={T.retention} meta={money(cr)} />
            </div>


            <div className="project-dashboard-grid grid gap-3" style={{ gridTemplateColumns: "7fr 3fr", alignItems: "stretch" }}>
              <Panel title="Where the money sits">
                <Meter label="Contract amount — billed vs works still to do"
                  segments={[
                    { label: "Billed gross", value: gross, color: T.collected },
                    { label: "Balance works", value: cg, color: T.works },
                    { label: "Unaccounted", value: other, color: T.ruleSoft },
                  ]}
                  legend={[
                    { color: T.collected, label: "Billed gross", value: money(gross), extra: pct(contract ? gross / contract : null) },
                    { color: T.works, label: "Balance works", value: money(cg), extra: pct(contract ? cg / contract : null) },
                    { label: "Contract", value: money(contract) },
                  ]} />
                <div style={{ flex: 1, minHeight: 16 }} />
                <Meter label="Balance for collection — what it is made of"
                  segments={[
                    { label: "Unbilled works", value: cg, color: T.works },
                    { label: "Cash balance", value: cc, color: T.cash },
                    { label: "Retention", value: cr, color: T.retention },
                  ]}
                  legend={[
                    { color: T.works, label: "Unbilled works", value: money(cg) },
                    { color: T.cash, label: "Cash balance", value: money(cc) },
                    { color: T.retention, label: "Retention", value: money(cr) },
                    { label: "Total", value: money(bal), extra: "net " + money(netbal) },
                  ]} />
              </Panel>
              <StatusChart rows={rows} />
            </div>

            <div className="project-group-chart-wrap" style={{ marginTop: 18 }}>
              <GroupChart rows={rows} groupBy={groupBy} onGroupBy={setGroupBy} />
            </div>

            {(manualLoading || saveMessage) && (
              <div className="mb-2 px-3 py-2 text-xs" role={saveMessage.startsWith("Could") ? "alert" : undefined}
                   style={{ color: saveMessage.startsWith("Could") ? T.bad : T.inkSoft,
                            background: saveMessage.startsWith("Could") ? "#FBEEEC" : T.paper2,
                            border: `1px solid ${saveMessage.startsWith("Could") ? T.bad + "55" : T.rule}` }}>
                {manualLoading ? "Loading saved project updates…" : saveMessage}
              </div>
            )}
            <LedgerTable rows={rows} sort={sort} onSort={onSort} onExport={exportCsv} onEdit={editManual}
                         onSaveRow={saveRow} onSaveAll={saveAll} dirtyIds={dirtyIds} dirtyCount={dirtyCount}
                         savingIds={savingIds} onAuditCell={setAuditTarget}
                         onManageTargets={setManageTarget} multipleTargetsEnabled={multipleTargetsEnabled}
                         statusOptions={statusOptions} />

            <TargetAnalysis rows={multipleTargetsEnabled ? rows : rows.map((record) => ({
              ...record,
              targets: record.primaryTarget ? [record.primaryTarget] : [],
            }))} />
            {auditTarget && <AuditModal key={`${auditTarget.projectId}:${auditTarget.field}`} target={auditTarget}
                                        onClose={() => setAuditTarget(null)} />}
            {multipleTargetsEnabled && manageTarget && (
              <TargetsModal
                key={manageTarget.id}
                /* re-read from `records` so the modal always sees the current
                   target list, including one it has just saved */
                project={records.find((r) => r.id === manageTarget.id) || manageTarget}
                onSaved={refreshTargets}
                onClose={() => setManageTarget(null)} />
            )}
        </div>

        </>}

        {adminOpen && (
          <AdminPanel
            currentUserId={user?.id}
            onMultipleTargetsChanged={(enabled) => {
              setMultipleTargetsEnabled(enabled);
              if (!enabled) setManageTarget(null);
            }}
            onClose={() => setAdminOpen(false)} />
        )}
        {datasetHistoryOpen && (
          <DatasetHistoryModal onClose={() => setDatasetHistoryOpen(false)} onRestore={restorePreviousDataset} />
        )}
        {forcePasswordChange && <PasswordChangePanel onDone={() => setForcePasswordChange(false)} />}
      </div>
    </div>
  );
}
