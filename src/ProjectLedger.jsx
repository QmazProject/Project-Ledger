import { useState, useMemo, useRef, useEffect, useLayoutEffect } from "react";
import * as XLSX from "xlsx";
import { supabase, isConfigured } from "./lib/supabase";
import {
  projectKey, todayMs, assessTargets, assessProjectTargets, assessTarget,
  atRiskExposure, distinctProjectCount, isTrackable, isArchived,
  validateTarget, targetWarnings, selectPrimaryTarget, TARGET_FIELDS, SCOPE_LABEL,
} from "./lib/targets";
import { groupTargetHistory, actionLabel, isEventOnly, isBlankValue } from "./lib/targetHistory";
import {
  settleLoad, loadingState, isReady, hasFailed, projectTargets, targetsLabel,
  buildManualSave, normalizeManualValue, fractionFromPercent, percentFromFraction,
} from "./lib/panelData";
import {
  cleanText, numberOrNull, readMasterWorkbook, readCollectiblesWorkbook,
  assembleProjects, extendLegacyAssignments, resolvedEntry, importedChanges,
  IMPORT_AUDIT_FIELDS, IMPORT_SHEET_RULES, classifyWorkbookSheets, unrecognizedWorkbookLog,
  mergeMasterDimensions, mergeCollectionRows, removeProjectFromStore, duplicateProjectIds,
  buildManualProject, addProjectToStore, displayProjectId, appendDatasetNote,
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

const inFlight = new Map();

function once(key, start) {
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

/** Rejects rather than waiting forever.
 *
 *  Applied to the one request that gates the entire screen. A load that cannot
 *  finish is a bad outcome; a load that cannot finish and says nothing is a
 *  worse one, because the only thing distinguishing it from a slow network is
 *  how long somebody is willing to sit and watch. The rejection lands in the
 *  caller's existing catch, which already reports it and releases the screen. */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not respond within ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/* Short enough that somebody watching the screen sees the answer rather than
   giving up and reloading first. A load that has not returned in eight seconds
   is not going to be saved by twelve more. */
const DATASET_TIMEOUT_MS = 8_000;

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
    .select("project_id, status, contract_amount, remarks, engineer, swa");
  if (error) throw error;
  const byKey = new Map();
  for (const row of data || []) {
    const values = { note: row.remarks };
    if (row.status !== null && row.status !== undefined) values.status = row.status;
    if (row.contract_amount !== null && row.contract_amount !== undefined) values.contract = row.contract_amount;
    /* An absent override must not become a value. These are merged over the
       imported row, so carrying a null here would blank out the Senior engineer
       the workbook supplied for every project nobody has typed one against. */
    if (row.engineer !== null && row.engineer !== undefined && row.engineer !== "") values.engineer = row.engineer;
    if (row.swa !== null && row.swa !== undefined) values.swa = row.swa;
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
    /* Cleared back to blank means "no override", not "this project has no
       engineer" — the imported value comes back on the next load. Normalised
       through the same function the panel used, so what is stored is what is on
       screen and what the audit compared against. */
    engineer: normalizeManualValue("engineer", values.engineer) || null,
    swa: numOrNull(values.swa),
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "project_id" });
  if (error) throw error;

  const batchId = newBatchId();
  const auditFields = [["status", "Status"], ["contract", "Contract"], ["note", "Remarks"],
    ["engineer", "Senior engineer"], ["swa", "SWA %"]];
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

/* Administrator deletions.

   Permanent, and the only writes in this file that destroy rather than add.
   `isAdmin` in this browser decides whether the controls are drawn and nothing
   more: the role is re-read from profiles inside each function, so a non-admin
   who calls them directly is refused by the database rather than by the UI.

   The reason is required by the database, not merely collected here. Once the
   rows are gone it is the only remaining explanation of why. */
async function deleteTargetPermanently(targetId, reason) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const rows = await callTargetRpc("admin_delete_project_target", {
    p_target_id: targetId, p_reason: reason,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function deleteAuditEntries(auditIds, reason) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  return callTargetRpc("admin_delete_audit_entries", {
    p_audit_ids: auditIds, p_reason: reason,
  });
}

/* Every ID spelling the project's rows were filed under, resolved here rather
   than in SQL: a project imported before the year joined the ID has its manual
   values, audit and targets under the bare "QMB-001" while everything since is
   under "QMB-001 - 2025". Only the panel knows which of those belong to this
   row, and guessing in the database would delete another year's history. */
async function deleteProjectRecords(projectIds, reason) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const rows = await callTargetRpc("admin_delete_project", {
    p_project_ids: projectIds, p_reason: reason,
  });
  return (Array.isArray(rows) ? rows[0] : rows) || {};
}

/* Shared by both deletion paths so the wording of the warning cannot drift
   between them. Returns the typed reason, or null if the user backed out at
   either step. */
function confirmPermanentDelete(what, detail) {
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
const LEDGER_PERMISSIONS = [
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

async function loadMyPermissions() {
  if (!isConfigured || !supabase) return [];
  const { data, error } = await supabase.rpc("my_ledger_permissions");
  if (error) throw new Error(error.message || "Could not read your access.");
  return data || [];
}

/* ---------------- presence ----------------
   How often each browser says "still here", and how long a heartbeat counts for.
   The window is deliberately more than twice the beat: one missed request — a
   sleeping laptop, a phone switching network, a slow response — must not drop
   somebody off the list who is sitting right there. */
const PRESENCE_BEAT_MS = 45_000;
const PRESENCE_WINDOW_S = 150;
const PRESENCE_POLL_MS = 30_000;

let presenceBeatWarned = false;

async function recordPresence() {
  if (!isConfigured || !supabase) return;
  /* Not shown to the user, on purpose: a failed heartbeat changes nothing they
     are doing, the next beat is 45 seconds away, and it is not a feature they
     asked for or can act on. Not invisible either — a heartbeat that never
     works presents as "nobody is signed in", which reads as an answer rather
     than a fault. One console warning gives that a trail without turning a
     background task into an interruption.

     supabase.rpc RETURNS its error rather than throwing, so the error field has
     to be read; a bare try/catch around this call would catch nothing. */
  let failure = "";
  try {
    const { error } = await supabase.rpc("record_ledger_presence");
    if (error) failure = error.message || "unknown error";
  } catch (thrown) {
    failure = thrown.message || "request failed";   // network, not PostgREST
  }
  if (failure && !presenceBeatWarned) {
    presenceBeatWarned = true;
    console.warn(`Project Ledger: presence heartbeat failed — the admin header will show nobody signed in. ${failure}`);
  }
}

async function listPresence() {
  if (!isConfigured || !supabase) return [];
  const { data, error } = await supabase.rpc("list_ledger_presence", { p_within_seconds: PRESENCE_WINDOW_S });
  if (error) throw new Error(error.message || "Could not read who is signed in.");
  return data || [];
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
  /* The year-free spelling. `id` still holds "QMB-014 - 2025" and still does
     every join; this column only decides what the eye sees. Two years of the
     same project therefore render an identical ID, which is why the cell's
     tooltip below spells the year out. */
  { k: "displayId", label: "ID", stick: true, w: 92 },
  /* The year the ID column stops showing. Two years of the same project render
     an identical ID, so without this the only way to tell them apart was the
     cell's tooltip. Same field the Project year filter selects on, so a filtered
     view and this column can never disagree. */
  { k: "yearStr", label: "Year", w: 66 },
  { k: "district", label: "District" },
  { k: "license", label: "License" },
  /* Hand-typed like Status and Contract: the workbook supplies it, but a
     correction typed here outlives every later import of it. */
  { k: "engineer", label: "Senior engineer", edit: "text", w: 180 },
  { k: "category", label: "Category" },
  { k: "location", label: "Location" },
  { k: "status", label: "Status", edit: "status", w: 160 },
  { k: "contract", label: "Contract", edit: "amount", money: true, w: 101 },
  /* no `pct: true`: an editable cell formats itself, and two formatters on one
     column is how they drift apart */
  { k: "swa", label: "SWA %", edit: "pct", w: 92 },
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
  /* wraps for the same reason Balance Work does: a note somebody typed is a
     sentence, and 190px of it is not the note */
  { k: "note", label: "Remarks", edit: "text", w: 190, wrap: true },
];

/* Columns that sort on a different field from the one they display. The summary
   cell holds an object, so it orders by how many targets a project has; the year
   is text on screen ("UNSPECIFIED" where there is none) but has to order as a
   number, or 2022 and 2025 would sort beside the word rather than beside each
   other. */
const SORT_KEYS = { targetSummary: "targetCount", yearStr: "year" };

const INLINE_TARGET_COLS = [
  /* The work itself, ahead of the numbers that measure it. Same field the
     Manage Targets modal edits, so the two are one value and not two. */
  /* `wrap`: the value is a list of works — "Emulsified Asphalt, Wearing Course
     Hot Laid…" — not a word, so the cell has to show all of it rather than as
     much as 190px holds. */
  { k: "scope", label: SCOPE_LABEL, edit: "text", targetField: true, w: 190, wrap: true },
  { k: "target_qty", label: "Target qty", edit: "qty", targetField: true, w: 92 },
  { k: "unit", label: "Unit", edit: "text", targetField: true, w: 80 },
  { k: "start_date", label: "Start date", edit: "date", targetField: true, w: 132 },
  { k: "target_completion", label: "Target completion", edit: "date", targetField: true, w: 132 },
  { k: "actual_output", label: "Actual output", edit: "qty", targetField: true, w: 96 },
];
const INLINE_TARGET_FIELD_KEYS = new Set(INLINE_TARGET_COLS.map((column) => column.k));

/* The name each field is stored under in the audit trail. This is what the
   history query matches on, so it follows the database and not the column
   heading — see SCOPE_LABEL. */
const AUDIT_FIELD_LABELS = Object.fromEntries([
  ...IMPORT_AUDIT_FIELDS,
  ...TARGET_FIELDS,
  ["note", "Remarks"],
]);

/* ...and the name to show above that history, which is the one on the column. */
const AUDIT_DISPLAY_LABELS = { ...AUDIT_FIELD_LABELS, scope: SCOPE_LABEL };

/* The trail stores what was stored. SWA is a fraction there — from Excel and
   from the panel alike — so it has to be rendered the way the column renders
   it, or every row reads as a hundredfold error. Formatting on the way out
   rather than on the way in also covers the history written before the column
   was editable. */
const AUDIT_VALUE_FORMATTERS = {
  swa: (raw) => { const n = toNum(raw); return n === null ? raw : pct(n); },
};
const auditValue = (field, raw) => raw === null || raw === undefined || raw === ""
  ? "—"
  : (AUDIT_VALUE_FORMATTERS[field] ? AUDIT_VALUE_FORMATTERS[field](raw) : raw);

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
  { k: "scope", label: SCOPE_LABEL },
  { k: "target_qty", label: "Target qty" },
  { k: "unit", label: "Unit" },
  { k: "start_date", label: "Start date" },
  { k: "target_completion", label: "Target completion" },
  { k: "actual_completion", label: "Completion date (automatic)" },
  { k: "actual_output", label: "Actual output" },
];

/* the table hides the long project name; the export still carries it */
const EXPORT_COLS = [
  /* ID and Year as two columns, matching the table. This used to be one column
     holding "QMB-014 - 2025", because without a Year column that was the only
     way to tell 2024 from 2025 — the reason no longer holds now that Year is
     here, and a year glued into an ID is a spreadsheet's problem: it cannot be
     grouped, filtered or compared against a records system that keeps them
     apart. The two columns together carry exactly the information the single
     one did. */
  { k: "displayId", label: "ID" },
  { k: "yearStr", label: "Year" },
  { k: "name", label: "Project name" },
  /* yearStr again would duplicate the column just placed above; `note` is moved
     to the end instead of appearing mid-row. */
  ...COLS.slice(1).filter((c) => !c.targets && c.k !== "note" && c.k !== "yearStr"),
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

function ImportPanel({ onLoad, sourceLabel, uploadedBy, log, busy, onPrevious, canRestorePrevious, forceOpen }) {
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
          {canRestorePrevious && <button type="button" onClick={onPrevious} disabled={busy || !isConfigured}
                  className="rounded-sm px-2.5 py-1 text-xs"
                  title="Restore the shared ledger as it was before an earlier Excel update"
                  style={{ border: `1px solid ${T.rule}`, color: T.inkSoft,
                           opacity: busy || !isConfigured ? 0.6 : 1 }}>
            Previous data
          </button>}
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
              master-only projects kept visible. An upload <b>adds and updates</b>: projects already in the ledger
              that the new workbook does not list are kept, not removed. Hand-typed status, contract, remarks and
              targets are retained; only Excel fields that really changed receive an <b>Excel updated</b> audit entry.
            </p>
            {/* stated before the upload, not only after one is rejected */}
            <p className="mx-auto mt-1.5 max-w-xl text-[11px]" style={{ color: T.inkFaint }}>
              Sheet tabs read: {IMPORT_SHEET_RULES.map((rule) => <b key={rule.key} style={{ color: T.inkSoft }}>{rule.label}{rule.key === "collectibles" ? "" : " · "}</b>)}
              — a file with none of these tabs is rejected and the ledger is left unchanged.
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
  /* Counts while the load is outstanding.
     The load is bounded (see DATASET_TIMEOUT_MS), so this can only reach that
     many seconds before the screen resolves one way or the other. If it ever
     runs past it, the number is the diagnosis: the effect holding the timeout
     is not running. And if the number stops advancing, nothing is running at
     all — the page is blocked rather than waiting. */
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!loading) return undefined;
    const started = Date.now();
    const tick = setInterval(() => setWaited(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, [loading]);

  return (
    <div className="rounded-sm px-6 py-12 text-center"
         style={{ background: T.panel, border: `1px solid ${T.rule}` }}>
      <div className="text-base uppercase"
           style={{ fontFamily: DISPLAY, fontWeight: 800, letterSpacing: ".05em" }}>
        {loading ? "Loading the ledger…" : "No project data yet"}
      </div>
      {loading && (
        <div className="mt-2 text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
          {waited}s · this resolves within {Math.round(DATASET_TIMEOUT_MS / 1000)}s either way
        </div>
      )}
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

function FilterBar({ q, setQ, filters, countsFor, onToggle, onClearOne, onClearAll, anyActive, disabled }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open || disabled) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(null); };
    const esc = (e) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open, disabled]);

  return (
    <div ref={ref} className="project-filter-bar sticky top-0 z-20 mb-3 rounded-sm px-3 pb-3 pt-2.5"
         style={{ background: T.panel, border: `1px solid ${T.rule}`, boxShadow: "0 10px 26px -22px rgba(22,33,28,.7)" }}>
      {/* Inert rather than removed. Taking the bar off the screen would move
          everything below it and lose the reader's place; leaving it visible but
          plainly unusable says the selections are still there and will apply
          again the moment the duplicate view is closed. */}
      <div className="project-filter-controls flex flex-wrap items-end gap-2"
           inert={disabled ? "" : undefined}
           aria-hidden={disabled || undefined}
           style={disabled ? { opacity: 0.45, filter: "grayscale(1)", pointerEvents: "none" } : undefined}>
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

/* Lifecycle order, not alphabetical: a project is unspecified before it is
   bid, awarded before it runs, and suspended only after it has started. The
   dropdown reads top to bottom the way the work actually moves. */
const PROJECT_STATUS_OPTIONS = ["UNSPECIFIED", "NOT YET AWARDED", "ONGOING", "COMPLETED", "SUSPENDED"];
const PROJECT_STATUS_TONE = {
  /* Grey, and deliberately the flattest of the five: UNSPECIFIED is the
     absence of an answer, so it must not compete with the statuses that carry
     one. It is also what a blank status renders as — see below. */
  UNSPECIFIED: { background: T.paper2, border: T.rule, color: T.inkFaint },
  /* Blue, borrowed from the cash tone. Prospective work, distinct from
     ONGOING's amber so the two are not read as the same stage at a glance. */
  "NOT YET AWARDED": { background: "#E8F0F7", border: T.cash, color: T.cash },
  ONGOING: { background: "#FFF4C2", border: "#D2A21C", color: "#765900" },
  COMPLETED: { background: "#E4EFEC", border: T.collected, color: T.collected },
  SUSPENDED: { background: "#FBEEEC", border: T.bad, color: T.bad },
};

/* The SWA cell is percent on both sides of the keyboard — 10.1 in, "10.1%"
   back, 0.101 stored (see fractionFromPercent). The typed text is held
   separately while the cell has focus: deriving it from the stored fraction on
   every keystroke would eat the dot the moment somebody typed "10.". */
/* `wrap` is for the columns that hold a sentence rather than a word. A single
   line input showed only as much of a saved Balance Work as the column was
   wide — "Emulsified Asphalt, Wearing Course Hot Lai…" — and the rest could be
   reached only by clicking into the cell and scrolling it. A textarea grown to
   its own content shows every line of it while staying one field: same value,
   same onChange, same Escape. */
function EditCell({ value, type, onChange, wrap = false }) {
  const [focus, setFocus] = useState(false);
  /* null means "not being typed into"; "" is a real value the user cleared */
  const [typed, setTyped] = useState(null);
  const v = value ?? "";
  const numericValue = type === "amount" ? toNum(v) : null;
  let displayValue = v;
  if (type === "amount" && !focus && v !== "")
    displayValue = numericValue === null ? v : money(numericValue);
  else if (type === "pct") {
    /* Focused and blurred must show the same number. pct() rounds to one
       decimal, so a typed 58.45 read back as "58.5%" and the cell disagreed
       with what the user had just entered. percentFromFraction is the exact
       inverse of what the keystroke handler stored, so what comes back is
       precisely what was typed — 58.4 stays 58.4%, 58.45 stays 58.45% — with
       the % sign added on blur. */
    const asPercent = percentFromFraction(v);
    displayValue = focus ? (typed ?? asPercent) : (asPercent === "" ? "" : asPercent + "%");
  }

  /* Only text wraps. The number, percent and date cells reformat themselves on
     blur and are a single token by construction, so growing them would add
     height no value can ever fill. */
  const multiline = wrap && type === "text";
  const grow = useRef(null);
  /* Measured before paint, or a cell that is two lines tall would render one
     line tall for a frame every time the row re-renders. */
  useLayoutEffect(() => {
    const el = grow.current;
    if (!el) return;
    const fit = () => {
      /* auto first: scrollHeight never reports less than the height already
         set, so without this a cell that lost a line would keep the old one. */
      el.style.height = "auto";
      /* scrollHeight is content plus padding and stops short of the border, so
         a border-box height set from it alone clips the last line by a pixel. */
      el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return undefined;
    /* How many lines the same text takes depends on how wide the column ended
       up, and that is settled by the browser after this runs — and again
       whenever the window is resized. Width only: fit() changes the height, so
       reacting to height here is how this would loop forever. */
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [multiline, displayValue]);

  if (type === "status") {
    const current = CLEAN(v).toUpperCase();
    /* A blank status *is* UNSPECIFIED, so it now selects the real option and
       takes its colour rather than showing a disabled placeholder. Display
       only — nothing is written until somebody picks a value, so a project
       nobody has touched keeps its empty status in the data and in the chart
       instead of being silently reclassified by a render. */
    const effective = current || "UNSPECIFIED";
    const recognized = PROJECT_STATUS_OPTIONS.includes(effective);
    const tone = PROJECT_STATUS_TONE[effective] || { background: T.paper2, border: T.rule, color: T.inkSoft };
    return (
      <select
        aria-label="Project status"
        value={recognized ? effective : "__current__"}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
        style={{
          width: "100%", border: `1px solid ${focus ? T.ink : tone.border}`,
          background: tone.background, color: tone.color, borderRadius: 2, padding: "2px 4px",
          fontFamily: MONO, fontSize: 11.5, fontWeight: 700, outline: "none", cursor: "pointer",
        }}
      >
        {/* Only an unrecognised *non-blank* status still needs this — a value
            some older import wrote that is not one of the five. Blank is now
            handled by UNSPECIFIED above. */}
        {!recognized && <option value="__current__" disabled>{current}</option>}
        {PROJECT_STATUS_OPTIONS.map((status) => (
          <option key={status} value={status} style={{ color: PROJECT_STATUS_TONE[status].color }}>
            {status}
          </option>
        ))}
      </select>
    );
  }

  const field = {
    width: "100%", border: `1px solid ${focus ? T.collected : "transparent"}`,
    background: focus ? T.panel : "transparent", borderRadius: 2, padding: "1px 4px",
    fontFamily: type === "text" ? BODY : MONO, fontSize: 11.5, color: T.ink,
    textAlign: type === "qty" || type === "amount" || type === "pct" ? "right" : "left", outline: "none",
  };
  const handlers = {
    onFocus: () => setFocus(true),
    onBlur: () => { setFocus(false); setTyped(null); },
  };

  if (multiline) return (
    <textarea
      ref={grow}
      rows={1}
      value={displayValue}
      onChange={(e) => onChange(e.target.value)}
      {...handlers}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.currentTarget.blur(); return; }
        /* The column stores one run of text, so Enter leaves the cell the way
           it does in every other cell instead of writing a newline into the
           value. Shift+Enter is left alone for anybody who wants one. */
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
      }}
      style={{
        ...field, display: "block", boxSizing: "border-box", resize: "none",
        /* the element is sized to its own content, so it never has anything to
           scroll — a scrollbar here would only steal width from the text */
        overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.35,
      }}
    />
  );

  return (
    <input
      value={displayValue}
      type={type === "date" ? "date" : "text"}
      inputMode={type === "qty" || type === "amount" || type === "pct" ? "decimal" : undefined}
      title={type === "pct" ? "Type the percentage itself — 10.1 is 10.1%" : undefined}
      onChange={(e) => {
        if (type === "pct") {
          const text = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
          setTyped(text);
          onChange(fractionFromPercent(text));
          return;
        }
        onChange(type === "amount"
          ? e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1")
          : e.target.value);
      }}
      {...handlers}
      onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
      style={field}
    />
  );
}

function AuditModal({ target, onClose, isAdmin }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  /* Removed from the list as well as from the database, rather than reloading:
     the query that filled this modal is keyed on the cell, and re-running it
     after a delete would flicker the whole table for one removed row. */
  const purge = async (ids, what) => {
    const reason = confirmPermanentDelete(what, `${ids.length} audit entr${ids.length === 1 ? "y" : "ies"} for ${target.projectDisplayId || target.projectId}.`);
    if (!reason) return;
    setBusy(true);
    setNotice("");
    try {
      const deleted = await deleteAuditEntries(ids, reason);
      const gone = new Set(ids);
      setLogs((prev) => prev.filter((log) => !gone.has(log.id)));
      setNotice(`${deleted} audit entr${deleted === 1 ? "y" : "ies"} deleted and recorded in the purge log.`);
    } catch (deleteError) {
      setNotice(`Not deleted: ${deleteError.message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    /* With no `field`, this is the whole project's history rather than one
       cell's: that is the only place a project-level event — "created by hand",
       a target archived — can be read at all, because those are not filed under
       any editable column. */
    let query = supabase.from("project_manual_update_audit")
      .select("id, column_name, field_key, old_value, new_value, source, action, changed_by_username, changed_at")
      .in("project_id", target.projectIds?.length ? target.projectIds : [target.projectId])
      .order("changed_at", { ascending: false });
    if (target.field) query = query.eq("column_name", AUDIT_FIELD_LABELS[target.field]);
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
              Audit trail · {target.field ? AUDIT_DISPLAY_LABELS[target.field] : "Whole project"}
            </h2>
            <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 11, color: T.inkSoft }}>Project ID: {target.projectDisplayId || target.projectId}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close audit trail"
                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink, padding: "3px 8px", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: 16 }}>
          {loading && <div style={{ color: T.inkFaint, fontSize: 12 }}>Loading audit history…</div>}
          {error && <div style={{ color: T.bad, fontSize: 12 }}>Could not load audit history: {error}</div>}
          {!loading && !error && !logs.length && <div style={{ color: T.inkFaint, fontSize: 12 }}>
            {target.field ? "No saved changes for this cell yet." : "Nothing has been recorded against this project yet."}
          </div>}
          {notice && <div style={{ marginBottom: 10, fontFamily: MONO, fontSize: 11,
                                   color: notice.startsWith("Not deleted") ? T.bad : T.collected }}>{notice}</div>}
          {!loading && !error && logs.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                {[["When", "left"], ...(target.field ? [] : [["Column", "left"]]), ["Activity", "left"], ["User", "left"], ["Previous value", "left"], ["New value", "left"]].map(([label, align]) => (
                  <th key={label} style={{ padding: "6px 7px", textAlign: align, borderBottom: `2px solid ${T.ink}`,
                                            fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{label}</th>
                ))}
                {isAdmin && <th style={{ padding: "6px 7px", textAlign: "right", borderBottom: `2px solid ${T.ink}`,
                                         fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>Delete</th>}
              </tr></thead>
              <tbody>{logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap", fontFamily: MONO, fontSize: 10.5 }}>
                    {new Date(log.changed_at).toLocaleString()}
                  </td>
                  {!target.field && (
                    <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap",
                                 fontFamily: MONO, fontSize: 10.5 }}>
                      {AUDIT_DISPLAY_LABELS[log.field_key] || log.column_name}
                    </td>
                  )}
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap",
                               color: log.action === "create" ? T.collected
                                 : log.source === "excel" ? T.works : T.inkSoft, fontWeight: 600 }}>
                    {log.action === "create" && log.field_key === "project" ? "Project created"
                      : log.source === "excel" ? "Excel updated" : "Manual edit"}
                  </td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}` }}>{log.changed_by_username}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, color: T.inkSoft }}>{auditValue(target.field || log.field_key, log.old_value)}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, fontWeight: 600 }}>{auditValue(target.field || log.field_key, log.new_value)}</td>
                  {isAdmin && (
                    <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, textAlign: "right" }}>
                      <button type="button" disabled={busy}
                              onClick={() => purge([log.id], "this audit entry")}
                              title="Permanently delete this audit entry"
                              style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.bad,
                                       borderRadius: 2, padding: "1px 6px", fontSize: 10.5,
                                       cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}</tbody>
            </table>
          )}
          {/* Administrator-only, and deliberately below the table rather than
              beside the close button: clearing a cell's whole history is not a
              control anybody should reach for on the way out of the modal. */}
          {isAdmin && !loading && !error && logs.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.ruleSoft}`,
                          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.inkFaint }}>
                Deleted entries are copied to the purge log with your name and reason.
              </span>
              <button type="button" disabled={busy}
                      onClick={() => purge(logs.map((log) => log.id), "the whole history for this cell")}
                      style={{ border: `1px solid ${T.bad}`, background: T.panel, color: T.bad,
                               borderRadius: 2, padding: "3px 9px", fontSize: 11,
                               cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}>
                {busy ? "Deleting…" : `Delete all ${logs.length} shown`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


/* The words assembleProjects substitutes for an absent value. Listing them as
   data that will be destroyed would promise the administrator something real
   was there. */
const DELETE_PLACEHOLDERS = new Set(["UNSPECIFIED", "UNASSIGNED", "NONE"]);

/* The confirmation for the only action in the panel that destroys a project.
   A window.confirm cannot do this job: the thing an administrator needs to
   weigh is what *this* project is carrying — how much history, whose typed
   values, how many targets — and a fixed sentence cannot say. So the counts are
   read from the database before the button is live, and the fields are listed
   by name. Nothing here is an estimate; the audit query matches the same rows
   the delete will match. */
function DeleteProjectModal({ project, onCancel, onConfirm, busy }) {
  const [reason, setReason] = useState("");
  const [audit, setAudit] = useState({ loading: true, error: "", rows: 0, columns: [] });

  /* Keyed on the ids themselves rather than on `project`, which is a fresh
     object on every render of the page behind this dialog: depending on the
     object would re-run the count continuously while it sits open. */
  const auditIdKey = (project.auditIds || [project.id]).join("|");
  const targetIdKey = (project.targets || []).map((t) => t.id).join("|");

  useEffect(() => {
    let alive = true;
    const targetIds = (project.targets || []).map((t) => t.id).filter(Boolean);
    /* Two queries rather than one .or(): the project IDs contain spaces and
       hyphens, which PostgREST's in.() list cannot carry unquoted inside or().
       Merged on row id so a row matched by both is counted once — the same
       thing the delete's `project_id = any(...) or target_id = any(...)` does. */
    const byProject = supabase.from("project_manual_update_audit")
      .select("id, column_name").in("project_id", project.auditIds?.length ? project.auditIds : [project.id]);
    const byTarget = targetIds.length
      ? supabase.from("project_manual_update_audit").select("id, column_name").in("target_id", targetIds)
      : Promise.resolve({ data: [], error: null });

    Promise.all([byProject, byTarget]).then(([a, b]) => {
      if (!alive) return;
      const failure = a.error || b.error;
      if (failure) { setAudit({ loading: false, error: failure.message, rows: 0, columns: [] }); return; }
      const merged = new Map();
      for (const row of [...(a.data || []), ...(b.data || [])]) merged.set(row.id, row.column_name);
      setAudit({ loading: false, error: "", rows: merged.size,
                 columns: [...new Set(merged.values())].sort() });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditIdKey, targetIdKey]);

  const imported = IMPORT_AUDIT_FIELDS
    .filter(([key]) => project[key] !== null && project[key] !== undefined && project[key] !== ""
      && !DELETE_PLACEHOLDERS.has(project[key]));
  const liveTargets = (project.targets || []).filter((t) => !isArchived(t)).length;
  const archivedTargets = (project.targets || []).length - liveTargets;
  /* Counts still loading, or a failed count, must not be confirmable: an
     administrator agreeing to destroy "an unknown amount of history" has not
     been told anything. */
  const ready = !audit.loading && !audit.error && reason.trim().length > 0 && !busy;

  const section = { marginTop: 12 };
  const heading = { fontFamily: DISPLAY, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                    letterSpacing: ".06em", color: T.inkSoft, marginBottom: 4 };

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
         style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,33,28,.45)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="delete-project-title"
           style={{ width: "min(620px, 100%)", maxHeight: "85vh", overflow: "auto", background: T.panel,
                    border: `2px solid ${T.bad}`, borderRadius: 2, boxShadow: "0 18px 50px rgba(0,0,0,.3)" }}>
        <div style={{ padding: "12px 16px", background: "#FBEEEC", borderBottom: `1px solid ${T.bad}55` }}>
          <h2 id="delete-project-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 800,
                                                 textTransform: "uppercase", color: T.bad }}>
            Permanently delete {project.id}
          </h2>
          <div style={{ marginTop: 4, fontSize: 12, color: T.ink, lineHeight: 1.45 }}>
            This cannot be undone from the panel. Everything listed below is destroyed, not archived and not
            hidden. Restoring it afterwards takes a database administrator and both halves of the recovery:
            <b> Previous data</b> for the imported values, and the purge log for the rest.
          </div>
        </div>

        <div style={{ padding: 16, fontSize: 12 }}>
          {project.name && <div style={{ color: T.inkSoft, marginBottom: 8 }}>{project.name}</div>}

          <div style={section}>
            <div style={heading}>Imported values that will be deleted ({imported.length})</div>
            {imported.length === 0
              ? <div style={{ color: T.inkFaint }}>None recorded.</div>
              : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <tbody>{imported.map(([key, label]) => (
                    <tr key={key}>
                      <td style={{ padding: "3px 7px 3px 0", color: T.inkSoft, width: "45%" }}>{label}</td>
                      <td style={{ padding: "3px 0", fontFamily: MONO, fontSize: 11 }}>{auditValue(key, project[key])}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
          </div>

          <div style={section}>
            <div style={heading}>Targets</div>
            {project.targetsUnavailable
              ? <div style={{ color: T.bad }}>Could not be loaded, so it is not known how many would be deleted.</div>
              : (project.targets || []).length === 0
                ? <div style={{ color: T.inkFaint }}>None.</div>
                : (
                  <div>
                    {liveTargets} live{archivedTargets ? `, ${archivedTargets} archived` : ""} — every one is deleted,
                    with its own history
                    <ul style={{ margin: "4px 0 0 16px", color: T.inkSoft }}>
                      {(project.targets || []).map((t) => (
                        <li key={t.id}>{t.scope || "(no Balance Work)"}{isArchived(t) ? " · archived" : ""}</li>
                      ))}
                    </ul>
                  </div>
                )}
          </div>

          <div style={section}>
            <div style={heading}>Audit history</div>
            {audit.loading && <div style={{ color: T.inkFaint }}>Counting entries…</div>}
            {audit.error && <div style={{ color: T.bad }}>Could not count the audit history ({audit.error}). Nothing can be deleted until this is known.</div>}
            {!audit.loading && !audit.error && (
              audit.rows === 0
                ? <div style={{ color: T.inkFaint }}>No recorded changes.</div>
                : <div>
                    <b>{audit.rows}</b> entr{audit.rows === 1 ? "y" : "ies"} across: {audit.columns.join(", ")}
                    <div style={{ color: T.inkFaint, marginTop: 2 }}>
                      Both Excel-updated and Manual-edit records, for the project and for its targets.
                    </div>
                  </div>
            )}
          </div>

          <div style={section}>
            <div style={heading}>Hand-typed values</div>
            {project.manualFields?.length
              ? <div>{project.manualFields.map((f) => AUDIT_DISPLAY_LABELS[f] || f).join(", ")} — typed in the panel and not recoverable from any workbook.</div>
              : <div style={{ color: T.inkFaint }}>None.</div>}
          </div>

          <div style={{ ...section, paddingTop: 12, borderTop: `1px solid ${T.ruleSoft}` }}>
            <label htmlFor="delete-reason" style={heading}>Reason (required, stored in the purge log)</label>
            <input id="delete-reason" value={reason} autoFocus disabled={busy}
                   onChange={(e) => setReason(e.target.value)}
                   placeholder="e.g. wrong Project ID typed into the 2026 workbook"
                   style={{ width: "100%", border: `1px solid ${T.rule}`, borderRadius: 2, padding: "5px 7px",
                            fontFamily: BODY, fontSize: 12, background: busy ? T.paper2 : T.panel }} />
          </div>

          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onCancel} disabled={busy}
                    style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink,
                             borderRadius: 2, padding: "5px 12px", fontSize: 12, cursor: busy ? "default" : "pointer" }}>
              Cancel
            </button>
            <button type="button" disabled={!ready} onClick={() => onConfirm(reason.trim())}
                    title={audit.loading ? "Waiting for the audit count" : !reason.trim() ? "A reason is required" : ""}
                    style={{ border: `1px solid ${T.bad}`, background: ready ? T.bad : T.paper2,
                             color: ready ? T.panel : T.inkFaint, borderRadius: 2, padding: "5px 12px",
                             fontSize: 12, fontWeight: 600, cursor: ready ? "pointer" : "default" }}>
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Who has the panel open. Names rather than a count alone: "4 users online"
   tells an administrator nothing they can act on, whereas a name tells them who
   to ask before overwriting a shared dataset.

   The list is a lower bound and the card says so. Presence expires by age, so
   somebody who opened the panel and walked away still appears for a couple of
   minutes, and somebody whose browser cannot reach the database never appears. */

/* Green while the heartbeat is recent, amber once it is old enough that the
   person may have closed the tab and not been noticed yet. The colour is the
   difference between "is here" and "was here a minute ago", which is exactly
   the distinction somebody deciding whether to interrupt needs. */
const presenceTone = (secondsAgo) => (secondsAgo <= 75 ? T.collected : T.works);

function PresenceDot({ secondsAgo, size = 7, pulse = true }) {
  const tone = presenceTone(secondsAgo);
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size, flex: "none" }}>
      {pulse && (
        <span className="ledger-pulse-ring" aria-hidden="true"
              style={{ position: "absolute", inset: 0, borderRadius: "50%", background: tone }} />
      )}
      <span style={{ position: "relative", width: size, height: size, borderRadius: "50%",
                     background: tone, boxShadow: `0 0 0 1.5px ${T.panel}` }} />
    </span>
  );
}

const UserGlyph = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none"
       stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="3.4" />
    <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
  </svg>
);

const sinceLabel = (seconds) => (seconds < 60 ? "just now"
  : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago`
  : `${Math.floor(seconds / 3600)} h ago`);

function PresenceStrip({ presence, currentUsername }) {
  const { users, error } = presence;
  const [open, setOpen] = useState(false);

  if (error) {
    return (
      <div title={error} style={{ display: "flex", alignItems: "center", gap: 5,
                                  fontFamily: MONO, fontSize: 10, color: T.bad }}>
        <PresenceDot secondsAgo={99999} pulse={false} />
        signed in: unavailable
      </div>
    );
  }

  /* Other people first. Leading with your own name would spend the one visible
     slot on the one person the reader already knows is here. */
  const others = users.filter((u) => u.username !== currentUsername);
  const me = users.find((u) => u.username === currentUsername);
  const ordered = [...others, ...(me ? [me] : [])];

  if (!ordered.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 10, color: T.inkFaint }}>
        <PresenceDot secondsAgo={0} pulse={false} />
        <UserGlyph /> only you
      </div>
    );
  }

  const headline = others[0]?.username || currentUsername;
  const extra = ordered.length - 1;
  const freshest = Math.min(...ordered.map((u) => u.seconds_ago ?? 0));

  return (
    <div style={{ position: "relative" }}
         onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button"
              onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
              onClick={() => setOpen((wasOpen) => !wasOpen)}
              aria-expanded={open}
              aria-label={`${ordered.length} signed in. ${ordered.map((u) => u.username).join(", ")}`}
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "default",
                       border: `1px solid ${open ? T.rule : "transparent"}`, borderRadius: 999,
                       background: open ? T.panel : T.paper2, padding: "3px 9px 3px 7px",
                       fontFamily: MONO, fontSize: 10.5, color: T.inkSoft, lineHeight: 1 }}>
        <PresenceDot secondsAgo={freshest} />
        <UserGlyph />
        <span style={{ color: T.ink, fontWeight: 600, maxWidth: 130, overflow: "hidden",
                       textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {headline}
        </span>
        {extra > 0 && (
          <span style={{ color: T.inkSoft }}>+{extra} user{extra === 1 ? "" : "s"}</span>
        )}
      </button>

      {open && (
        <div role="status"
             style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 25,
                      minWidth: 232, maxHeight: 300, overflowY: "auto", textAlign: "left",
                      background: T.panel, border: `1px solid ${T.ink}`, borderRadius: 3,
                      boxShadow: "0 14px 34px rgba(22,33,28,.22)" }}>
          <div style={{ padding: "7px 10px", borderBottom: `1px solid ${T.ruleSoft}`,
                        fontFamily: DISPLAY, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase",
                        letterSpacing: ".07em", color: T.inkSoft }}>
            {ordered.length} signed in
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: "3px 0" }}>
            {ordered.map((u) => (
              <li key={u.user_id}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 10px",
                           fontFamily: MONO, fontSize: 11 }}>
                <PresenceDot secondsAgo={u.seconds_ago ?? 0} pulse={false} />
                <span style={{ color: T.ink, fontWeight: u.username === currentUsername ? 400 : 600,
                               overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {u.username}
                  {u.username === currentUsername && <span style={{ color: T.inkFaint }}> (you)</span>}
                </span>
                <span style={{ marginLeft: "auto", color: T.inkFaint, fontSize: 10, whiteSpace: "nowrap" }}>
                  {sinceLabel(u.seconds_ago ?? 0)}
                </span>
              </li>
            ))}
          </ul>
          <div style={{ padding: "6px 10px", borderTop: `1px solid ${T.ruleSoft}`,
                        fontSize: 9.5, color: T.inkFaint, lineHeight: 1.45 }}>
            Anyone whose browser cannot reach the database does not appear, so treat this as a minimum.
          </div>
        </div>
      )}
    </div>
  );
}

/* The counterpart to deleting a project. Imports add and update but never
   invent, so a project that exists in the world and not yet in any workbook had
   no way in at all — the only route was to wait for the next Excel file.

   Only Project ID and Year are required, because they are the identity every
   target, audit row and manual value is filed under. Everything else is a value
   a later import can supply, and leaving a field blank here leaves it for that
   import rather than freezing a guess in place. */
const ADD_PROJECT_FIELDS = [
  { k: "name", label: "Project name", w: "100%" },
  { k: "district", label: "District" },
  { k: "license", label: "License" },
  { k: "engineer", label: "Senior engineer" },
  { k: "category", label: "Category" },
  { k: "location", label: "Location" },
  { k: "contract", label: "Contract amount", numeric: true },
  { k: "swa", label: "SWA %", numeric: true },
];

function AddProjectModal({ onCancel, onCreate, busy, currentYear }) {
  const [values, setValues] = useState({ projectId: "", year: String(currentYear), status: "UNSPECIFIED" });
  const [error, setError] = useState("");
  const set = (k, v) => setValues((prev) => ({ ...prev, [k]: v }));

  const submit = async () => {
    setError("");
    const message = await onCreate(values);
    if (message) setError(message);
  };

  const field = { border: `1px solid ${T.rule}`, borderRadius: 2, padding: "5px 7px",
                  fontSize: 12, fontFamily: BODY, width: "100%", background: T.panel };
  const label = { fontFamily: DISPLAY, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase",
                  letterSpacing: ".08em", color: T.inkSoft, display: "block", marginBottom: 3 };

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
         style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,33,28,.45)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="add-project-title"
           style={{ width: "min(640px, 100%)", maxHeight: "88vh", overflow: "auto", background: T.panel,
                    border: `1px solid ${T.ink}`, borderRadius: 2, boxShadow: "0 18px 50px rgba(0,0,0,.28)" }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.rule}` }}>
          <h2 id="add-project-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 800, textTransform: "uppercase" }}>
            Add a project
          </h2>
          <div style={{ marginTop: 4, fontSize: 11.5, color: T.inkSoft, lineHeight: 1.45 }}>
            Entered by hand. A later workbook containing this Project ID and Year updates the columns you leave
            blank; the ones you fill in stay on screen, and the workbook's own value is recorded in that
            column's audit trail instead.
          </div>
        </div>

        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 220px" }}>
              <label style={label} htmlFor="add-project-id">Project ID *</label>
              <input id="add-project-id" autoFocus value={values.projectId} disabled={busy}
                     onChange={(e) => set("projectId", e.target.value)}
                     placeholder="e.g. 26HD0023" style={{ ...field, fontFamily: MONO }} />
            </div>
            <div style={{ flex: "0 0 110px" }}>
              <label style={label} htmlFor="add-project-year">Year *</label>
              <input id="add-project-year" value={values.year} disabled={busy} inputMode="numeric"
                     onChange={(e) => set("year", e.target.value.replace(/[^0-9]/g, ""))}
                     style={{ ...field, fontFamily: MONO }} />
            </div>
            <div style={{ flex: "1 1 160px" }}>
              <label style={label} htmlFor="add-project-status">Status</label>
              <select id="add-project-status" value={values.status} disabled={busy}
                      onChange={(e) => set("status", e.target.value)} style={field}>
                {PROJECT_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {ADD_PROJECT_FIELDS.map((f) => (
              <div key={f.k} style={{ flex: f.w === "100%" ? "1 1 100%" : "1 1 180px" }}>
                <label style={label} htmlFor={`add-project-${f.k}`}>{f.label}</label>
                <input id={`add-project-${f.k}`} value={values[f.k] ?? ""} disabled={busy}
                       inputMode={f.numeric ? "decimal" : undefined}
                       onChange={(e) => set(f.k, f.numeric ? e.target.value.replace(/[^0-9.]/g, "") : e.target.value)}
                       style={{ ...field, fontFamily: f.numeric ? MONO : BODY,
                                textAlign: f.numeric ? "right" : "left" }} />
              </div>
            ))}
          </div>

          <div style={{ marginTop: 8, fontSize: 10.5, color: T.inkFaint, lineHeight: 1.45 }}>
            District, License, Senior engineer, Category and Location are stored in upper case, the way the
            readers store them, so a typed project groups and filters with the imported ones instead of
            beside them. SWA % is entered as a percentage.
          </div>

          {error && (
            <div role="alert" style={{ marginTop: 12, padding: "7px 9px", background: "#FBEEEC",
                                       border: `1px solid ${T.bad}55`, color: T.bad, fontSize: 12 }}>
              {error}
            </div>
          )}

          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onCancel} disabled={busy}
                    style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink,
                             borderRadius: 2, padding: "5px 12px", fontSize: 12,
                             cursor: busy ? "default" : "pointer" }}>
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={busy || !values.projectId.trim() || !values.year}
                    style={{ border: `1px solid ${T.collected}`,
                             background: busy || !values.projectId.trim() || !values.year ? T.paper2 : T.collected,
                             color: busy || !values.projectId.trim() || !values.year ? T.inkFaint : T.paper2,
                             borderRadius: 2, padding: "5px 12px", fontSize: 12, fontWeight: 600,
                             cursor: busy ? "default" : "pointer" }}>
              {busy ? "Adding…" : "Add project"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Raised when somebody presses F5 or Ctrl+R with typed values still unsaved.
   The browser's own refresh warning cannot offer to save — this one can, which
   is the whole reason it exists. It names the rows at stake rather than saying
   "you have unsaved changes", because the first question anybody asks is which
   ones. */
/* `cellCount` and `rowIds.length` are different numbers — one row can hold
   several edited cells — so both are named rather than picking one and letting
   the reader assume it was the other. */
function UnsavedReloadModal({ cellCount, rowIds, saving, onSave, onDiscard, onCancel }) {
  const shown = rowIds.slice(0, 8);
  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}
         style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(22,33,28,.45)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="reload-title"
           style={{ width: "min(520px, 100%)", background: T.panel, border: `2px solid ${T.works}`,
                    borderRadius: 2, boxShadow: "0 18px 50px rgba(0,0,0,.3)" }}>
        <div style={{ padding: "12px 16px", background: "#FDF3EA", borderBottom: `1px solid ${T.works}55` }}>
          <h2 id="reload-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 800,
                                         textTransform: "uppercase", color: T.works }}>
            Unsaved changes
          </h2>
          <div style={{ marginTop: 4, fontSize: 12, color: T.ink, lineHeight: 1.45 }}>
            You have <b>{cellCount} unsaved change{cellCount === 1 ? "" : "s"}</b> across{" "}
            <b>{rowIds.length} row{rowIds.length === 1 ? "" : "s"}</b>. Reloading now discards them —
            typing in a cell stores nothing until it is saved.
          </div>
        </div>
        <div style={{ padding: 16, fontSize: 12 }}>
          <div style={{ fontFamily: DISPLAY, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                        letterSpacing: ".06em", color: T.inkSoft, marginBottom: 4 }}>
            Rows with unsaved edits
          </div>
          <div style={{ fontFamily: MONO, fontSize: 11, color: T.ink, lineHeight: 1.6 }}>
            {shown.join(", ")}{rowIds.length > shown.length ? ` … and ${rowIds.length - shown.length} more` : ""}
          </div>
          <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={onCancel} disabled={saving}
                    style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink,
                             borderRadius: 2, padding: "5px 12px", fontSize: 12,
                             cursor: saving ? "default" : "pointer" }}>
              Cancel
            </button>
            <button type="button" onClick={onDiscard} disabled={saving}
                    style={{ border: `1px solid ${T.bad}`, background: T.panel, color: T.bad,
                             borderRadius: 2, padding: "5px 12px", fontSize: 12,
                             cursor: saving ? "default" : "pointer" }}>
              Reload and lose them
            </button>
            <button type="button" onClick={onSave} disabled={saving} autoFocus
                    style={{ border: `1px solid ${T.collected}`, background: T.collected, color: T.paper2,
                             borderRadius: 2, padding: "5px 12px", fontSize: 12, fontWeight: 600,
                             cursor: saving ? "default" : "pointer" }}>
              {saving ? "Saving…" : "Save, then reload"}
            </button>
          </div>
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

/* Two glyphs rather than one that dims. Scanning a long column for the rows
   that still need saving is the actual job, and a change of colour alone does
   not survive that scan — a disk means "there is something to click here", a
   tick means there is not. */
const SAVE_ICON_SIZE = 13;
const glyph = { width: SAVE_ICON_SIZE, height: SAVE_ICON_SIZE, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" };
const UnsavedGlyph = () => (
  <svg {...glyph} strokeWidth="1.9" style={{ display: "block" }}>
    <path d="M4 4h11l5 5v11H4z" /><path d="M8 4v5h7" /><path d="M8 20v-6h8v6" />
  </svg>
);
const SavedGlyph = () => (
  <svg {...glyph} strokeWidth="2" style={{ display: "block" }}>
    <path d="M5 12.5 10 17.5 19 7" />
  </svg>
);

/* Named in the Save tooltip so the shortcut is discoverable rather than folklore.
   Mac keyboards send the same event through metaKey, and a tooltip promising
   Ctrl+S to somebody holding Cmd is worse than saying nothing. */
const SAVE_SHORTCUT_LABEL = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "")
  ? "⌘S" : "Ctrl+S";

/* narrow enough to sit against Remarks: the table is width:100%, so any column
   left unbounded absorbs the slack and drifts away from its neighbour */
const SAVE_COL_W = 46;
const saveColWidth = { width: SAVE_COL_W, minWidth: SAVE_COL_W, maxWidth: SAVE_COL_W };

function SaveCell({ id, unsaved, saving, onSave }) {
  const label = saving ? `Saving ${id}…`
    : unsaved ? `Save changes for ${id}`
    : `No unsaved changes for ${id}`;
  return (
    <td style={{ padding: "3px 4px", borderBottom: `1px solid ${T.ruleSoft}`, textAlign: "center", ...saveColWidth }}>
      <button type="button" title={label} aria-label={label}
              onClick={() => onSave(id)} disabled={!unsaved || saving}
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center",
                       width: 24, height: 22, borderRadius: 2, padding: 0,
                       border: `1px solid ${unsaved ? T.collected : T.ruleSoft}`,
                       background: unsaved ? "#E4EFEC" : "transparent",
                       color: unsaved ? T.collected : T.inkFaint,
                       /* a row with nothing to save should not look like a button at all */
                       boxShadow: unsaved ? `0 1px 0 ${T.collected}22` : "none",
                       cursor: unsaved && !saving ? "pointer" : "default",
                       fontFamily: MONO, fontSize: 12, lineHeight: 1 }}>
        {saving ? "…" : unsaved ? <UnsavedGlyph /> : <SavedGlyph />}
      </button>
    </td>
  );
}

function LedgerTable({ rows, sort, onSort, onExport, onEdit, onSaveRow, onSaveAll, onAuditCell,
                      onManageTargets, multipleTargetsEnabled, isAdmin, dirtyIds, dirtyCount, savingIds,
                      onDeleteProject, onViewDuplicates, duplicateCount, emptyLabel, onAddProject,
                      onProjectHistory }) {
  /* Position of the ID-column context menu, in viewport coordinates, or null. */
  const [idMenu, setIdMenu] = useState(null);

  useEffect(() => {
    if (!idMenu) return undefined;
    const close = () => setIdMenu(null);
    const esc = (e) => { if (e.key === "Escape") setIdMenu(null); };
    /* `true` puts these on the capture phase so the menu closes on a scroll
       inside the table as well as on the window, which a bubbling listener on
       document would never see. */
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", esc);
    };
  }, [idMenu]);
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
    const key = SORT_KEYS[sort.key] || sort.key;
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
        {onAddProject && (
          <button onClick={onAddProject} className="rounded-sm px-2.5 py-1 text-xs"
                  aria-label="Add a project by hand" title="Add a project by hand — imports only add and update, they never invent"
                  style={{ border: `1px solid ${T.rule}`, background: T.panel, color: T.inkSoft }}>
            + Add project
          </button>
        )}
        <button onClick={onSaveAll} disabled={!dirtyCount || savingIds.size > 0}
                className="project-save-action rounded-sm px-2.5 py-1 text-xs"
                aria-label={`Save changes (${SAVE_SHORTCUT_LABEL})`}
                title={`Save changes (${SAVE_SHORTCUT_LABEL}) — saves every row with unsaved edits`}
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
      {idMenu && (
        /* Fixed to the viewport because the table scrolls in both directions;
           anchored to the row it was opened on, it would slide away from the
           cursor the moment anything moved. */
        <div role="menu"
             style={{ position: "fixed", left: Math.min(idMenu.x, window.innerWidth - 260), top: idMenu.y,
                      zIndex: 50, background: T.panel, border: `1px solid ${T.ink}`, borderRadius: 2,
                      boxShadow: "0 10px 30px rgba(0,0,0,.22)", padding: 3, minWidth: 240 }}
             onMouseDown={(e) => e.stopPropagation()}>
          {/* Always listed, and always with its count, so "no duplicates" is an
              answer the menu gives rather than something the reader has to
              infer from an option that is missing. At zero there is nothing to
              show, so it reports 0 instead of opening an empty table. */}
          <button type="button" role="menuitem" disabled={!duplicateCount}
                  onClick={() => { setIdMenu(null); onViewDuplicates(); }}
                  style={{ display: "block", width: "100%", textAlign: "left", border: "none",
                           background: "none", padding: "6px 9px", fontSize: 12,
                           color: duplicateCount ? T.ink : T.inkFaint,
                           cursor: duplicateCount ? "pointer" : "default", fontFamily: BODY }}>
            View duplicate Project IDs
            <span style={{ float: "right", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                           color: duplicateCount ? T.works : T.inkFaint }}>
              {duplicateCount}
            </span>
          </button>
          <div style={{ padding: "0 9px 5px", fontSize: 10, color: T.inkFaint, lineHeight: 1.4 }}>
            {duplicateCount
              ? "Project IDs appearing on more than one row, across years or otherwise."
              : "No Project ID appears more than once."}
          </div>
          {/* Opened on the row that was right-clicked, so it is only offered
              from a cell. The header knows the column, not a project. */}
          {idMenu.row && (
            <>
              <div style={{ borderTop: `1px solid ${T.ruleSoft}`, margin: "3px 0" }} />
              <button type="button" role="menuitem"
                      onClick={() => { const r = idMenu.row; setIdMenu(null); onProjectHistory(r); }}
                      style={{ display: "block", width: "100%", textAlign: "left", border: "none",
                               background: "none", padding: "6px 9px", fontSize: 12, color: T.ink,
                               cursor: "pointer", fontFamily: BODY }}>
                Project history
                <span style={{ float: "right", fontFamily: MONO, fontSize: 10.5, color: T.inkFaint }}>
                  {idMenu.row.displayId}
                </span>
              </button>
              <div style={{ padding: "0 9px 5px", fontSize: 10, color: T.inkFaint, lineHeight: 1.4 }}>
                Every recorded change to this project, including its creation.
              </div>
            </>
          )}
        </div>
      )}
      {data.length === 0 ? (
        /* "No projects match these filters" would be wrong in the duplicate
           view, where the filters are not what emptied the table. */
        <div className="py-10 text-center text-xs" style={{ color: T.inkFaint }}>
          {emptyLabel || "No projects match these filters."}
        </div>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: 620 }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.k} onClick={() => onSort(c.k)}
                      /* The ID header is the natural place to ask a question
                         about the ID column as a whole, so the duplicate menu
                         opens from here as well as from any ID cell. */
                      onContextMenu={c.stick && onViewDuplicates
                        ? (e) => { e.preventDefault(); setIdMenu({ x: e.clientX, y: e.clientY }); }
                        : undefined}
                      title={c.stick && onViewDuplicates
                        ? "Right-click for duplicate Project IDs" : undefined}
                      style={{ ...th, ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w,
                                                 whiteSpace: c.stick ? "nowrap" : "normal" } : {}),
                               color: c.edit ? "#C28A00" : T.ink,
                               ...(c.stick ? { ...stick, background: T.paper2, zIndex: 4 } : {}) }}>
                    {c.label}{c.edit && <span aria-hidden="true" style={{ color: T.bad, marginLeft: 3, fontWeight: 800 }}>*</span>} <span style={{ fontFamily: MONO, color: T.inkFaint }}>{sort.key === c.k ? (sort.dir > 0 ? "▲" : "▼") : "↕"}</span>
                  </th>
                ))}
                <th style={{ ...th, cursor: "default", textAlign: "center", padding: "7px 4px", ...saveColWidth }}>Save</th>
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
                        if (!e.target.matches("input, select")) e.currentTarget.querySelector("input, select")?.focus();
                      }}
                          style={{ ...base, ...wStyle, padding: "3px 5px", background: "#FBFCFA",
                                   cursor: c.edit === "status" ? "pointer" : "text" }}>
                        <EditCell value={v} type={c.edit} wrap={c.wrap} onChange={(nv) => onEdit(r.id, c.k, nv)}
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
                    /* No year in the hover text: the ID column dropped it and
                       the tooltip is the same label, so repeating it there put
                       back exactly what was asked to be removed. The overlap
                       sentence is admin-only for the same reason the \u24d8 below
                       is \u2014 showing the explanation while hiding the marker
                       would leak the thing the marker signals. */
                    /* Right-click on the ID column is the administrator's way
                       into the duplicate view. Only on that column, because
                       that is the column the question is about, and only for an
                       administrator — everybody else keeps the browser's own
                       context menu, which is what they expect. */
                    if (c.stick && onViewDuplicates) {
                      auditProps.onContextMenu = (e) => {
                        e.preventDefault();
                        setIdMenu({ x: e.clientX, y: e.clientY, row: r });
                      };
                    }
                    return <td key={c.k} {...auditProps} title={c.stick
                      ? [v, r.name,
                         isAdmin && r.qmbOverlap ? "Also exists in QMB PROJECTS; QM LICENSES values are used" : ""].filter(Boolean).join(" \u2014 ")
                      : v} style={{ ...base,
                      ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden", textOverflow: "ellipsis" } : {}),
                      ...(c.stick ? { ...stick, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap", padding: "6px 8px", fontSize: 11.5 } : {}),
                      ...(c.wide ? { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {}),
                      cursor: auditProps.onContextMenu ? "help" : undefined }}>{v}
                      {c.stick && isAdmin && r.qmbOverlap && <span aria-label="Also exists in QMB Projects" title="Also exists in QMB PROJECTS; QM LICENSES values are used"
                        style={{ marginLeft: 5, color: T.works, fontWeight: 800 }}>ⓘ</span>}
                      {/* An import can no longer remove a project, so this is
                          the only way a wrong Project ID leaves the ledger.
                          Administrators only, and on the ID cell because what
                          it deletes is the whole project, not a field of it. */}
                      {c.stick && onDeleteProject && (
                        <button type="button" onClick={(e) => { e.stopPropagation(); onDeleteProject(r); }}
                                title={`Delete ${r.id} and everything recorded against it`}
                                aria-label={`Delete project ${r.id} and everything recorded against it`}
                                style={{ float: "right", border: "none", background: "none", color: T.inkFaint,
                                         padding: "0 1px", fontSize: 11, lineHeight: 1, cursor: "pointer" }}
                                onMouseEnter={(e) => { e.currentTarget.style.color = T.bad; }}
                                onMouseLeave={(e) => { e.currentTarget.style.color = T.inkFaint; }}>
                          ×
                        </button>
                      )}
                    </td>;
                  })}
                  <SaveCell id={r.id} unsaved={dirtyIds.has(r.id)} saving={savingIds.has(r.id)} onSave={onSaveRow} />
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
                     those are different numbers now and the label says which.
                     Drafts are excluded from the total and named separately, so
                     this never disagrees with the Targets filter beside it. */
                  if (c.k === "targetSummary") {
                    const draftTotal = data.reduce((n, r) => n + (r.targetSummary?.drafts.length || 0), 0);
                    return <td key={c.k} style={{ ...base, textAlign: "right",
                      ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w } : {}) }}>
                      {data.some((r) => r.targetsUnavailable)
                        ? <span style={{ color: T.inkFaint }}>unavailable</span>
                        : `${data.reduce((n, r) => n + r.targetCount, 0)} targets${draftTotal ? ` · ${draftTotal} draft${draftTotal === 1 ? "" : "s"}` : ""}`}</td>;
                  }
                  return <td key={c.k} style={base} />;
                })}
                <td style={{ position: "sticky", bottom: 0, background: T.paper2, borderTop: `2px solid ${T.ink}`,
                             ...saveColWidth }} />
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

/* How many rows the worklist opens with. The rest are one click away rather
   than gone: this used to be three separate caps (10 action items, 8 on track,
   8 delivered) applied silently, so a ledger holding 76 tracked targets showed
   26 of them and said 76 in the caption above. Nothing on screen reconciled the
   two numbers. */
const TARGET_ROWS_COLLAPSED = 10;
/* Expanded, the panel keeps its height and the rows scroll inside it. Growing
   the page instead would push every panel below this one off the screen the
   moment somebody wanted to read past row ten. */
const TARGET_ROWS_MAX_HEIGHT = 560;

function TargetAnalysis({ rows }) {
  const { tracked, drafts } = useMemo(() => assessTargets(rows), [rows]);
  /* Not gated on role or on the multiple-targets flag. Every user sees the same
     worklist, so every user gets the same control over how much of it is on
     screen — an administrator has no more reason to read past row ten than the
     engineer whose targets these are. */
  const [showAll, setShowAll] = useState(false);
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
  const actionItems = tracked.filter((t) => t.rank <= 1);
  const onTrack = tracked.filter((t) => t.bucket === "On track");
  /* both delivered standings belong in the record of what has landed — a late
     delivery is if anything the more useful one to see */
  const achieved = tracked.filter((t) => t.done)
    .sort((a, b) => (b.project.bal || 0) - (a.project.bal || 0));
  /* Every tracked target, in the order the worklist presents them. Nothing is
     dropped here; `priority` below decides only how many are on screen. */
  const ranked = [...actionItems, ...onTrack, ...achieved];
  const hasMore = ranked.length > TARGET_ROWS_COLLAPSED;
  const priority = showAll || !hasMore ? ranked : ranked.slice(0, TARGET_ROWS_COLLAPSED);
  /* normalise the bar inside each bucket — otherwise one huge overdue project
     flattens every critical bar to a sliver.
     Measured across `ranked` and not across what is rendered: normalising the
     visible slice would rescale the first ten bars the moment the list was
     expanded, so the same target would appear more urgent collapsed than it did
     open. The bar means the same thing either way. */
  const bucketMax = {};
  ranked.forEach((p) => { bucketMax[p.bucket] = Math.max(bucketMax[p.bucket] || 1, p.score); });

  return (
    <Panel title="Target tracking and priority" right={
      <span className="text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
        {/* States what is on screen, not only what exists. The two used to be
            different numbers with nothing between them to explain the gap. */}
        showing {priority.length} of {tracked.length} target{tracked.length === 1 ? "" : "s"} across {projectsTracked} of {rows.length} projects
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
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-widest"
             style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>
          Work these first — on-track and completed targets are listed underneath
        </div>
        {/* Rendered only when there is something hidden, so a short ledger is not
            offered a control that would do nothing. */}
        {hasMore && (
          <button type="button" onClick={() => setShowAll(!showAll)}
                  className="project-target-showall rounded-sm px-2.5 py-1"
                  aria-expanded={showAll}
                  title={showAll
                    ? `Show only the first ${TARGET_ROWS_COLLAPSED} targets`
                    : `Show all ${ranked.length} tracked targets — the list scrolls inside this panel`}
                  style={{ border: `1px solid ${T.ink}`, background: showAll ? T.ink : "transparent",
                           color: showAll ? T.paper2 : T.ink, fontFamily: DISPLAY, fontWeight: 700,
                           letterSpacing: ".04em", textTransform: "uppercase", fontSize: 10,
                           whiteSpace: "nowrap" }}>
            {showAll ? `▴ Show top ${TARGET_ROWS_COLLAPSED}` : `▾ Show all ${ranked.length}`}
          </button>
        )}
      </div>
      {/* Expanded, the rows scroll inside a fixed height and the header stays
          put; collapsed, only the horizontal overflow of the original. */}
      <div className={showAll ? "overflow-auto" : "overflow-x-auto"}
           style={showAll ? { maxHeight: TARGET_ROWS_MAX_HEIGHT } : undefined}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 11.5 }}>
          <thead>
            <tr>
              {[["#"], ["Project"], ["District / engineer"], ["Standing"], ["Target qty", "right"],
                ["Actual", "right"], ["Done", "right"], ["Pace", "right"], ["Due"], [SCOPE_LABEL],
                ["Balance to collect", "right"], ["Priority"]].map(([hd, al]) => (
                /* Sticky needs an opaque background of its own — the panel's
                   white would otherwise let the scrolled rows show through the
                   heading. Harmless while the list is collapsed and nothing
                   scrolls under it. */
                <th key={hd} style={{ textAlign: al || "left", padding: "5px 8px",
                                      position: "sticky", top: 0, zIndex: 2, background: T.paper2,
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
                <td title={p.project.name} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap" }}>{p.projectDisplayId || p.projectId}</td>
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
                {/* The target's own Balance Work, which is what this row is
                    actually about. This column used to show the project's
                    Remarks: that belongs to the project, so every target of one
                    project repeated the same sentence, and the sentence had
                    nothing to do with the deliverable being ranked. Remarks
                    stays a project note in the Projects table and is not part of
                    target tracking. */}
                {/* Wrapped, not clipped. This cell used to end in an ellipsis —
                    "Emulsified Asphalt, Wearing Course Hot Lai…" — which hid the
                    part of the list that says what the row is ranking. The width
                    stays a maximum so the column cannot stretch the table; the
                    row grows downwards instead. */}
                <td title={p.scope || `No ${SCOPE_LABEL} specified for this target`}
                    style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`,
                             maxWidth: 210, whiteSpace: "normal", overflowWrap: "anywhere", lineHeight: 1.35,
                             color: p.scope ? T.ink : T.inkFaint }}>
                  {p.scope || "—"}</td>
                {/* The balance to collect belongs to the project, so it repeats
                    for each of that project's target rows. */}
                <td title={`Balance to collect on project ${p.projectId} — one figure for the project, not per target`}
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
        One row per target, so a project with several targets appears several times. The list opens at the{" "}
        {TARGET_ROWS_COLLAPSED} highest-priority targets; <b>Show all</b> adds the rest and scrolls them inside this
        panel rather than lengthening the page. On track means the target
        completion date is more than three days away and the target has not yet been reached. Critical means the
        deadline is within three days; overdue means the deadline has passed. A target counts as delivered when
        Actual output reaches Target qty. The system permanently records the date of the first qualifying Actual output
        save and uses it to decide whether delivery was on or before the Target completion date. The Actual output audit
        entry records the user, date, and time; later output corrections do not erase that completion. Priority ranks
        overdue and critical targets first. <b>Balance to collect</b>
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
  /* wraps for the same reason the ledger row's Balance Work does — this is the
     field being typed into, so it is the first place the full text has to be
     readable back */
  { k: "scope", label: SCOPE_LABEL, type: "text", w: 200, wrap: true },
  { k: "target_qty", label: "Target qty", type: "qty", w: 92 },
  { k: "unit", label: "Unit", type: "text", w: 80 },
  { k: "start_date", label: "Start date", type: "date", w: 132 },
  { k: "target_completion", label: "Target completion", type: "date", w: 132 },
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
  target?.scope || (target?.archived_at ? "Archived target" : `Target with no ${SCOPE_LABEL}`);

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
              {project.displayId || project.id}{project.name ? ` — ${project.name}` : ""}
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

function TargetsModal({ project, onClose, onSaved, isAdmin }) {
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
     A stored one is archived: it stops counting towards tracking but stays on
     record, which is the right answer for real work that ended. Deleting is a
     separate control below, for administrators, and is not the default. */
  const removeTarget = (row) => {
    if (row._isNew) { setRows((prev) => prev.filter((r) => r.id !== row.id)); return; }
    const name = row.scope || "this target";
    if (!window.confirm(`Archive ${name}? It stops counting towards tracking but stays on record and can be restored.`)) return;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, _archive: true, _restore: false } : r)));
  };
  const restoreTarget = (row) =>
    setRows((prev) => prev.map((r) => (r.id === row.id
      ? { ...r, _restore: Boolean(r.archived_at) && !r._restore, _archive: false } : r)));

  /* Unlike every other control here this one does not wait for Save. A delete
     cannot be part of a batch that might be abandoned half-way: the row and its
     history are gone the moment the database returns, so the modal reloads from
     the server immediately rather than holding a list that no longer matches. */
  const deleteTarget = async (row) => {
    const name = row.scope || "this target";
    const reason = confirmPermanentDelete(
      `${name}`,
      `The target and every audit entry recorded against it will be destroyed. Archiving keeps it on record instead.`,
    );
    if (!reason) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await deleteTargetPermanently(row.id, reason);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      await onSaved(`Deleted ${name} and ${result?.audit_rows_deleted ?? 0} audit entr${result?.audit_rows_deleted === 1 ? "y" : "ies"}. Recorded in the purge log.`);
      onClose();
    } catch (deleteError) {
      setMessage(`Not deleted: ${deleteError.message}`);
    } finally {
      setBusy(false);
    }
  };

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
                {project.displayId || project.id}{project.name ? ` — ${project.name}` : ""}
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
                            <EditCell value={row[c.k]} type={c.type} wrap={c.wrap} onChange={(v) => edit(row.id, c.k, v)} />
                          )}
                          {rowErrors[c.k] && (
                            <div style={{ color: T.bad, fontSize: 10, padding: "1px 4px" }}>{rowErrors[c.k]}</div>
                          )}
                          {/* a migrated target legitimately has no scope; say so
                              rather than inventing one */}
                          {c.k === "scope" && !archived && !row._isNew && !row.scope && !rowErrors.scope && (
                            <div style={{ color: T.inkFaint, fontSize: 10, fontStyle: "italic", padding: "1px 4px" }}>
                              No {SCOPE_LABEL} specified
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
                        {/* Administrators only, and last in the stack: Archive
                            stays the obvious control and this one has to be
                            reached for deliberately. */}
                        {isAdmin && !row._isNew && (
                          <button type="button" disabled={busy} onClick={() => deleteTarget(row)}
                                  title="Permanently delete this target and its audit history"
                                  style={{ border: "none", background: "none", color: T.bad,
                                           padding: "0 2px", fontSize: 10, textDecoration: "underline",
                                           cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}>
                            Delete
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
              {SCOPE_LABEL} is required for a new target. A target with no quantity and no completion date stays a draft
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

/* Which of the administrator features one user may reach. Named permissions
   rather than a second role, because the useful grants here are individually
   sized: somebody who should see who is signed in almost never also needs to
   destroy audit history. */
function AccessModal({ user, granted, onToggle, onClose, busy }) {
  const isAdmin = user.role === "admin";
  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
         style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(22,33,28,.45)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="access-title"
           style={{ width: "min(600px, 100%)", maxHeight: "86vh", overflow: "auto", background: T.panel,
                    border: `1px solid ${T.ink}`, borderRadius: 2, boxShadow: "0 18px 50px rgba(0,0,0,.28)" }}>
        <div className="flex items-start justify-between gap-3" style={{ padding: "12px 16px", borderBottom: `1px solid ${T.rule}` }}>
          <div>
            <h2 id="access-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 800, textTransform: "uppercase" }}>
              Access · {user.username || user.email}
            </h2>
            <div style={{ marginTop: 3, fontSize: 11.5, color: T.inkSoft }}>
              {isAdmin
                ? "Administrators hold every permission. Change the role to grant these individually."
                : "Each permission is granted separately and takes effect the next time this user loads the panel."}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close access"
                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink, padding: "3px 8px", cursor: "pointer" }}>×</button>
        </div>

        <div style={{ padding: 16 }}>
          {LEDGER_PERMISSIONS.map((permission) => {
            const on = isAdmin || granted.has(permission.k);
            return (
              <label key={permission.k}
                     style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 0",
                              borderBottom: `1px solid ${T.ruleSoft}`,
                              cursor: isAdmin || busy ? "default" : "pointer", opacity: isAdmin ? 0.6 : 1 }}>
                <input type="checkbox" checked={on} disabled={isAdmin || busy}
                       onChange={(e) => onToggle(permission.k, e.target.checked)}
                       style={{ marginTop: 2, width: 15, height: 15 }} />
                <span>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{permission.label}</span>
                  {/* Said here rather than discovered later: two of these hide a
                      control without being able to stop a determined request. */}
                  {!permission.enforced && (
                    <span title={permission.note}
                          style={{ marginLeft: 6, fontFamily: MONO, fontSize: 9.5, color: T.works,
                                   border: `1px solid ${T.works}55`, borderRadius: 2, padding: "0 4px" }}>
                      UI only
                    </span>
                  )}
                  <span style={{ display: "block", fontSize: 11, color: T.inkSoft, marginTop: 2 }}>
                    {permission.detail}
                  </span>
                  {!permission.enforced && (
                    <span style={{ display: "block", fontSize: 10, color: T.inkFaint, marginTop: 2 }}>
                      {permission.note}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
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
  const [access, setAccess] = useState(new Map());
  const [accessUser, setAccessUser] = useState(null);
  const [accessBusy, setAccessBusy] = useState(false);

  /* Grants live in their own table with their own RPCs, not behind the
     admin-users edge function, because they are ordinary rows in this database
     rather than anything needing the service key. Loaded by the mount effect
     above; changed one at a time below. */
  const toggleAccess = async (userId, permission, grantIt) => {
    setAccessBusy(true);
    const { error } = await supabase.rpc("set_ledger_permission", {
      p_user_id: userId, p_permission: permission, p_granted: grantIt,
    });
    setAccessBusy(false);
    if (error) { setMessage(`Could not change access: ${error.message}`); return; }
    /* Updated in place rather than reloaded: the answer is known, and a reload
       would close over a stale list while the request was in flight. */
    setAccess((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(userId) || []);
      if (grantIt) set.add(permission); else set.delete(permission);
      next.set(userId, set);
      return next;
    });
  };

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
    /* Deferred with the users request rather than called straight from the
       effect body, so nothing sets state during the render that scheduled it. */
    supabase.rpc("list_ledger_permissions").then(({ data, error }) => {
      if (!alive) return;
      if (error) { setMessage(`Could not read access settings: ${error.message}`); return; }
      const map = new Map();
      for (const row of data || []) {
        if (!map.has(row.user_id)) map.set(row.user_id, new Set());
        map.get(row.user_id).add(row.permission);
      }
      setAccess(map);
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
          <thead><tr>{["Username", "Email", "Role", "Status", "Temporary password", "Data", "Multiple targets", "Access", "Actions"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 7px", borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
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
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, textAlign: "center" }}>
              {/* A key, because what this opens is which doors this person can
                  open — not a settings cog, which would read as preferences. */}
              <button type="button" disabled={busy} onClick={() => setAccessUser(u)}
                      aria-label={`Access for ${u.username || u.email}`}
                      title={u.role === "admin"
                        ? "Administrator — holds every permission"
                        : `Access: ${(access.get(u.id)?.size || 0)} of ${LEDGER_PERMISSIONS.length} granted`}
                      style={{ display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer",
                               border: `1px solid ${T.rule}`, background: T.paper2, borderRadius: 2,
                               padding: "3px 7px", color: T.ink }}>
                <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" fill="none"
                     stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="12" r="4" /><path d="M12 12h9M17 12v4M20.5 12v3" />
                </svg>
                <span style={{ fontFamily: MONO, fontSize: 10.5,
                               color: u.role === "admin" ? T.collected : T.inkSoft }}>
                  {u.role === "admin" ? "all" : `${access.get(u.id)?.size || 0}/${LEDGER_PERMISSIONS.length}`}
                </span>
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
    {accessUser && (
      <AccessModal
        user={accessUser}
        granted={access.get(accessUser.id) || new Set()}
        busy={accessBusy}
        onToggle={(permission, grantIt) => toggleAccess(accessUser.id, permission, grantIt)}
        onClose={() => setAccessUser(null)} />
    )}
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
  const [deletingProject, setDeletingProject] = useState(null);
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const [presence, setPresence] = useState({ users: [], error: "" });
  const [permissions, setPermissions] = useState(null);
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [addingProject, setAddingProject] = useState(false);

  const userId = user?.id;

  useEffect(() => {
    let alive = true;
    /* Settled independently and deliberately. Awaiting them together meant one
       rejection discarded the other's result, so a missing targets table took
       every hand-typed status, contract and remark off the screen with it. */
    once("manual+targets", () => Promise.allSettled([loadManual(), loadTargets()])).then(([m, t]) => {
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
    if (isConfigured && supabase && userId) {
      /* Shared for the same reason as the loads above, and it matters more here
         than it looks: a discarded profile row leaves `role` at its "user"
         default, so an administrator silently loses the admin UI. */
      once(`profile:${userId}`, () => supabase.from("profiles")
        .select("username, role, force_password_change, multiple_targets_enabled")
        .eq("id", userId).maybeSingle())
        .then(({ data }) => {
          if (!alive || !data) return;
          if (data.username) setUsername(data.username);
          setRole(data.role || "user");
          setForcePasswordChange(Boolean(data.force_password_change));
          setMultipleTargetsEnabled(Boolean(data.multiple_targets_enabled));
        });
    }
    return () => { alive = false; };
    /* Keyed on the user's ID and not on the user object. AuthGate hands down
       `session.user`, and a token refresh produces a new object with the same
       contents — so depending on the object re-ran this whole load on every
       refresh, throwing away whatever was still in flight each time. */
  }, [userId]);

  /* Apply the shared dataset on initial load and after an import or restore. */
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
    once("dataset", () => withTimeout(loadDataset(), DATASET_TIMEOUT_MS, "The saved ledger"))
      .then((row) => {
        if (!alive) return;
        applyDataset(row);
        setDataReady(true);
      }).catch((error) => {
        if (!alive) return;
        setSourceLabel("Could not load the saved ledger");
        setLog([{ warn: true, text: `Could not load the saved ledger: ${error.message}. Reload the page to try again.` }]);
        setDataReady(true);
      });
    return () => { alive = false; };
  }, []);

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

  /* Reports whether the draft was actually cleared, so a caller that intends
     to reload afterwards can tell a save that failed from one that worked.
     Every existing caller ignores it and is unaffected. */
  const saveRow = async (id) => {
    if (!drafts[id] || savingIds.has(id)) return false;
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
    if (manualPlan && !manualPlan.ok) { setSaveMessage(`Could not save ${id}: ${manualPlan.reason}`); return false; }

    let targetPlan = null;
    if (hasTargetChanges) {
      if (!isReady(targets)) {
        setSaveMessage(`Could not save ${id}: targets are unavailable. Reload the page and try again.`);
        return false;
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
        return false;
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
      return true;
    } catch (error) {
      setSaveMessage(`Could not save ${id}: ${error.message}`);
      return false;
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

  /* The one action that removes a project. Imports are additive now, so a
     Project ID that was wrong in the workbook cannot be got rid of by fixing
     the workbook; this is the way out, and it is administrator-only.

     Two halves, in this order. The database rows go first, through one RPC that
     is one transaction and logs everything it destroys. Only if that succeeds is
     the imported row removed from the dataset payload and saved — the reverse
     order would risk a saved dataset with no project beside targets and history
     that still point at it, which reads as corruption rather than as a failed
     delete. Failing between the two leaves the DB rows gone and the imported row
     present, which the message says plainly so it can be retried. */
  const deleteProject = async (row, reason) => {
    setBusy(true);
    setSaveMessage("");
    try {
      const result = await deleteProjectRecords(row.auditIds?.length ? row.auditIds : [row.id], reason);

      const { store: nextStore, removedCollections } = removeProjectFromStore(store, row.identity);
      const label = appendDatasetNote(sourceLabel, `${row.id} deleted`);
      setStore(nextStore);
      setSourceLabel(label);
      /* No audit changes are passed: the rows that would have recorded them
         have just been deleted, and re-creating history for a project that no
         longer exists is not a record, it is noise. */
      await saveDataset(nextStore, label, []);

      setDrafts((prev) => { const next = { ...prev }; delete next[row.id]; return next; });
      try {
        setManual(settleLoad({ status: "fulfilled", value: await loadManual() }));
      } catch (manualError) {
        setManual(settleLoad({ status: "rejected", reason: manualError }));
      }
      await refreshTargets();
      setSaveMessage(
        `Deleted ${row.id}: ${result.targets_deleted ?? 0} target(s), `
        + `${result.audit_rows_deleted ?? 0} audit entr${result.audit_rows_deleted === 1 ? "y" : "ies"}, `
        + `${result.manual_rows_deleted ?? 0} manual row(s) and ${removedCollections} collection row(s). `
        + "Recorded in the purge log; the imported values remain in Previous data.",
      );
    } catch (error) {
      setSaveMessage(`Could not delete ${row.id}: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  /* Returns how many rows did not save, so "save and reload" can refuse to
     reload over a failure. saveRow has already put the reason on screen. */
  const saveAll = async () => {
    const ids = [...dirtyIds];
    let failed = 0;
    for (const id of ids) if (!(await saveRow(id))) failed++;
    return failed;
  };


  const [filters, setFilters] = useState(() => { const o = {}; DIMS.forEach((d) => (o[d.k] = new Set())); return o; });
  const [q, setQ] = useState("");
  const [groupBy, setGroupBy] = useState("district");
  const [sort, setSort] = useState({ key: "bal", dir: -1 });

  /* The three memos below are reported by the React Compiler's lint rule as
     memoization it "could not preserve", because `importedRows` and
     `legacyAssignments` are passed to functions imported from ./lib and the
     compiler does not analyse across module boundaries. Unable to see the body,
     it assumes any call might mutate its arguments, and a dependency that might
     be mutated cannot be relied on.

     Not one of them mutates anything, which is the whole reason they live in a
     tested library rather than here:

       extendLegacyAssignments  copies into `new Map(existing)` and reads `rows`
       resolvedEntry            only ever calls .get()
       importedChanges          reads both arrays, returns a new one
       assembleProjects         builds new row objects, touches neither input

     The memos must stay. babel-plugin-react-compiler is NOT in vite.config.js,
     so nothing replaces them at runtime: removing them would re-run
     assembleProjects over every project on every render. (Deleting them does
     silence the rule — the compiler then compiles this component cleanly — but
     that is only safe once the compiler is actually in the build.)

     So the advisory is suppressed rather than obeyed. If the compiler is ever
     added to the build, delete this block and the memos together and let it do
     the work. */
  /* eslint-disable react-hooks/preserve-manual-memoization */
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
      /* Three layers, weakest first: the workbook, then values typed when the
         project was created by hand, then values typed into a cell. Each later
         layer only covers the columns it actually holds, so a workbook value is
         hidden by a typed one and left intact underneath — which is what lets
         the Excel audit trail still record that the workbook changed. */
      const handEntered = r.manualValues || null;
      const merged = { ...r, ...(handEntered || {}), ...(m || {}) };
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
      /* Which fields somebody typed by hand, as opposed to inherited from the
         workbook. The delete confirmation names them: "3 hand-typed values" is
         not something an administrator can weigh, and "Status, Contract,
         Remarks" is. */
      merged.manualFields = [...new Set([
        ...Object.keys(handEntered || {}),
        ...(m ? Object.keys(m).filter((field) => set(m[field])) : []),
      ])];
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
      /* A draft is a target saved with a Balance Work name but no quantity and
         no completion date. It is stored, listed and editable, but there is
         nothing in it to measure, so every target column on its row renders
         blank. Counting drafts here filed those projects under "With target"
         while their row showed none, and wrote a target count beside it. Both
         numbers now count only targets that can actually be tracked. Drafts are
         not lost: Manage Targets still lists them and its button still counts
         them, which is where they can be completed. */
      const trackedCount = merged.targetSummary.tracked.length;
      /* the legacy single-target table reports the one target it can show */
      merged.targetCount = multipleTargetsEnabled ? trackedCount : Math.min(trackedCount, 1);
      merged.hasTarget = targetsLabel(targetsOf.unavailable, trackedCount);
      /* scope is one of these now, so it no longer needs lifting separately */
      for (const column of INLINE_TARGET_COLS)
        merged[column.k] = merged.primaryTarget?.[column.k] ?? "";
      if (draft) Object.assign(merged, draft);

      /* Balance Work is searchable — it is the one target field somebody would
         look a project up by. Remarks stays the project's own field. */
      const scopes = merged.targets.filter((t) => !isArchived(t)).map((t) => t.scope).filter(Boolean);
      /* handEntered included, or a hand-created project's name and district
         would be on screen and not findable by the search box above it. */
      if (m || draft || handEntered || scopes.length)
        merged._hay = [r._hay, merged.status, merged.contract, merged.note, merged.engineer,
          merged.name, merged.district, merged.category, merged.location, ...scopes]
          .filter(set).join(" ").toLowerCase();
      return merged;
    });
  }, [importedRows, manual, drafts, targets, legacyAssignments, multipleTargetsEnabled]);
  /* eslint-enable react-hooks/preserve-manual-memoization */

  /* Ctrl+S (Cmd+S on a Mac) saves every pending change — the same work the Save
     changes button does, and nothing the buttons cannot already do. Both of
     those stay exactly as they are; this is a third way to reach them, which is
     what makes it safe to add.

     On the window rather than on the table, because the caret is almost always
     inside a cell when somebody reaches for it, and a listener on the table
     would miss the keystroke the moment focus sat anywhere else. The cells call
     onChange on every keystroke, so the draft already holds the character just
     typed — there is no need to blur first and no risk of saving a stale value.

     The browser's own Save Page is suppressed only when the panel is going to
     act on the key. While a dialog is open the dialog owns saving, so the event
     is left alone and Ctrl+S keeps its normal browser meaning rather than
     silently saving the table hidden behind it. */
  const dialogOpen = Boolean(auditTarget || manageTarget || deletingProject
    || adminOpen || datasetHistoryOpen || forcePasswordChange || reloadPrompt);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "s" && event.key !== "S") return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (dialogOpen) return;

      event.preventDefault();
      /* Saying nothing here reads as a broken shortcut, so each case that
         declines to save says why in the same place a save would report. */
      if (!isConfigured) { setSaveMessage("Could not save: Supabase is not configured."); return; }
      if (busy || savingIds.size) return;
      if (!dirtyCount) { setSaveMessage("No unsaved changes."); return; }
      saveAll();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, busy, savingIds, dirtyCount, dirtyIds, drafts]);

  /* Losing typed values to a refresh.

     Two layers, because no single one can do the whole job. A page cannot put
     its own buttons in the dialog a refresh raises: the wording and the choices
     in `beforeunload` belong to the browser, and custom text was removed from
     every major engine years ago. What it shows is roughly "Leave site? Changes
     you made may not be saved", with Leave and Cancel, and that cannot be
     changed from here.

     So beforeunload is the guarantee — it covers the reload button, closing the
     tab, a typed URL, a back navigation, and it is the only thing that can stop
     any of them. And the keyboard reload is intercepted first, where a real
     dialog offering Save is possible. If a browser refuses to let that key be
     cancelled, beforeunload still fires behind it, so the worst case is the
     plain browser warning rather than silent loss. */
  const allowUnload = useRef(false);

  useEffect(() => {
    if (!dirtyCount) return undefined;
    const onBeforeUnload = (event) => {
      /* Set only by a choice that has already accounted for the edits: either
         they were saved, or the user was asked and chose to discard them.
         Without this the user would answer two dialogs for one decision. */
      if (allowUnload.current) return;
      event.preventDefault();
      event.returnValue = "";   // Chrome raises the dialog only if this is set
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const reloadKey = event.key === "F5"
        || ((event.ctrlKey || event.metaKey) && (event.key === "r" || event.key === "R"));
      if (!reloadKey || !dirtyCount || reloadPrompt) return;
      event.preventDefault();
      setReloadPrompt(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dirtyCount, reloadPrompt]);

  /* Every signed-in browser beats, whether or not the person is an admin —
     otherwise the list would only ever contain administrators, which is the
     opposite of what it is for. Beating continues while the tab is in the
     background, because a backgrounded tab is still the panel being open. */
  useEffect(() => {
    if (!user?.id || !isConfigured) return undefined;
    recordPresence();
    const beat = setInterval(recordPresence, PRESENCE_BEAT_MS);
    return () => clearInterval(beat);
  }, [user?.id]);

  /* Only administrators poll, so nobody else spends a request every 30 seconds
     on a list they are not allowed to see and would be refused anyway. */
  useEffect(() => {
    /* No state is reset on the way out: the strip is only rendered for an
       admin, so a leftover list is never shown, and clearing it here would be a
       synchronous setState in an effect for no visible gain. */
    if (!isConfigured || !Array.isArray(permissions) || !permissions.includes("view_presence")) return undefined;
    let alive = true;
    const read = async () => {
      try {
        const users = await listPresence();
        if (alive) setPresence({ users, error: "" });
      } catch (error) {
        /* Said out loud rather than shown as an empty list: "nobody is signed
           in" and "this could not be read" look identical otherwise, and an
           administrator would act on the first while the truth was the second. */
        if (alive) setPresence({ users: [], error: error.message });
      }
    };
    read();
    const poll = setInterval(read, PRESENCE_POLL_MS);
    return () => { alive = false; clearInterval(poll); };
  }, [permissions]);

  /* Returns an error sentence for the form to print, or "" when it worked.
     Saved to the shared dataset immediately rather than held locally: a project
     only this browser knows about is not in the ledger in any sense that
     matters, and the next person to import would never see it. */
  const createProject = async (input) => {
    const built = buildManualProject(
      { ...input, swa: input.swa === "" || input.swa === undefined ? "" : fractionFromPercent(input.swa) },
      { currentYear: new Date().getFullYear() },
    );
    if (!built.ok) return built.error;

    const added = addProjectToStore(store, built.record);
    if (!added.ok) return added.error;

    setBusy(true);
    try {
      const label = appendDatasetNote(sourceLabel, `${built.record.rawId} - ${built.record.year} added`);
      await saveDataset(added.store, label, []);
      setStore(added.store);
      setSourceLabel(label);

      /* One event, after the project actually exists. Recorded separately from
         the dataset save because that RPC writes per-field rows labelled as
         Excel changes, and this was neither. A failure here is reported without
         undoing the creation: the project is saved and real, and losing it to
         tidy up its audit row would be the worse outcome. */
      const created = displayProjectId(built.record.rawId, built.record.year);
      let auditNote = "";
      try {
        const { error } = await supabase.rpc("record_project_created", {
          p_project_id: built.record.identity,
          p_summary: `Created by hand${built.record.name ? ` — ${built.record.name}` : ""}`,
        });
        if (error) throw new Error(error.message);
      } catch (auditError) {
        auditNote = ` The project was saved, but its "created" audit entry was not recorded (${auditError.message}).`;
      }

      const held = built.manualFields.length;
      setSaveMessage(
        `Added ${created}.`
        + (held
          ? ` ${held} hand-entered value${held === 1 ? "" : "s"} will stay on screen through every later import — a workbook that disagrees is recorded in that column's audit trail as an Excel update rather than applied.`
          : " Every field was left blank, so a later import will fill them.")
        + auditNote,
      );
      return "";
    } catch (error) {
      /* The store is left untouched on failure — setStore has not run — so the
         panel and the shared dataset still agree with each other. */
      return `Could not save the new project: ${error.message}`;
    } finally {
      setBusy(false);
    }
  };

  /* A deliberate sign-out is the one departure the browser can actually report,
     so it is reported: without this the person stays on the admin's list for
     the rest of the heartbeat window after they have plainly left. Failure is
     ignored — the row expires by itself, which is the whole design. */
  /* Signing out is not allowed to wait for anything.

     Clearing presence used to be awaited here, so while any request was slow to
     come back the button did nothing at all — no spinner, no error, no sign-out
     — and the only way out of the page was to close the tab. The presence row
     expires on its own, which is what the empty catch below already conceded:
     this call is best-effort, and best-effort work must never stand between
     somebody and the door. Fired and left to finish on its own. */
  const signOutAndClearPresence = () => {
    if (isConfigured && supabase) {
      Promise.resolve(supabase.rpc("clear_ledger_presence")).catch(() => { /* expires anyway */ });
    }
    onSignOut();
  };

  /* null until the answer arrives, and every gate treats null as "no". Drawing
     a control and taking it away once the real answer lands is worse than a
     brief absence, and offering an action the database will refuse is worse. */
  useEffect(() => {
    if (!isConfigured || !user?.id) return undefined;   // stays null, which reads as no access
    let alive = true;
    loadMyPermissions()
      .then((list) => { if (alive) setPermissions(list); })
      .catch(() => { if (alive) setPermissions([]); });
    return () => { alive = false; };
  }, [user?.id, role]);

  const can = (permission) => Array.isArray(permissions) && permissions.includes(permission);

  const reloadNow = () => { allowUnload.current = true; window.location.reload(); };

  const saveThenReload = async () => {
    const failed = await saveAll();
    /* saveRow has already said which row failed and why. Reloading now would
       throw away the very edit that could not be stored, so the dialog closes
       and leaves the message on screen instead. */
    if (failed) { setReloadPrompt(false); return; }
    reloadNow();
  };

  const handleFiles = async (files) => {
    setBusy(true);
    const out = [];
    const acceptedFiles = [];
    let coll = store.coll, dim = store.dim, gotColl = false, gotMaster = false;
    for (const f of files) {
      try {
        let accepted = false;
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
        const sheets = classifyWorkbookSheets(wb);
        out.push({ text: `${f.name} — ${wb.SheetNames.length} sheets` });
        /* a file whose tabs are not recognised is rejected with instructions,
           not with a one-line "skipped" the uploader cannot act on */
        if (!sheets.recognized) {
          out.push(...unrecognizedWorkbookLog(f.name, wb.SheetNames));
        } else {
          /* Folded into what is already held, never substituted for it. A
             workbook covering one year used to remove every project the last
             workbook supplied, and remove them with no audit entry, because a
             row that stops existing has not changed. */
          if (sheets.hasCollectibles) {
            const r = readCollectibles(wb);
            out.push(...r.log);
            if (r.rows && r.rows.length) {
              const merged = mergeCollectionRows(coll, r.rows);
              coll = merged.rows; gotColl = true; accepted = true;
              out.push({ text: `Collectibles: ${merged.added} new, ${merged.updated} updated, ${merged.retained} kept from earlier uploads` });
            }
          }
          if (sheets.hasMaster) {
            const r = readMaster(wb);
            out.push(...r.log);
            if (r.dim.size) {
              const merged = mergeMasterDimensions(dim, r.dim);
              dim = merged.dim; gotMaster = true; accepted = true;
              out.push({ text: `Projects: ${merged.added} new, ${merged.updated} updated, ${merged.retained} kept from earlier uploads` });
              /* Said out loud. A hand-entered value silently outranking the
                 workbook looks identical to the workbook agreeing with it. */
              if (merged.keptManual) out.push({ text: `${merged.keptManual} hand-entered value${merged.keptManual === 1 ? "" : "s"} kept — the workbook differed and was not applied` });
            }
          }
          if (!accepted) out.push({ warn: true, text: `${f.name}: the sheet tab was found but no usable project rows were read from it` });
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
    } else {
      out.push({ warn: true, text: `Nothing was imported — the shared ledger is unchanged. Fix the sheet tab names above and upload again.` });
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
  /* The duplicate view is a different question from the filters, not another
     filter. The filters ask "which projects match these attributes"; this asks
     "which Project IDs are not unique", and answering it through the filter set
     would mean an admin could hide half of a duplicated pair by leaving a
     district selected — and then read the remaining half as unique. So it
     replaces the filters outright while it is on, and the bar above is disabled
     to say so rather than sitting there looking as though it still applies.
     Non-admins never reach this mode and their filters behave exactly as
     before. */
  const duplicates = useMemo(() => duplicateProjectIds(records), [records]);
  /* Guarded on the role as well as the flag, so a role that changes while the
     view is open drops straight back to the ordinary filtered table. */
  const duplicateView = can("view_duplicates") && duplicatesOnly;
  const rows = duplicateView
    ? records.filter((r) => duplicates.identities.has(r.identity))
    : records.filter((r) => passes(r, null));

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
      /* already draft-free, and it has to stay that way here: a "1" in this
         column beside six blank target cells is the same false reading the
         Targets filter used to give, only in a file read away from the app */
      if (c.k === "targetCount") return r.targetCount;
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
        `/* The three families are linked from index.html and served from /fonts,
            so nothing is fetched from a third party here. What remains is the
            animation, which has to live with the component that uses it. */

         /* The presence dot. The ring expands and fades once a cycle rather than
            the dot itself blinking: a blinking dot reads as a warning, a slow
            ring reads as a pulse — which is what it is. */
         @keyframes ledgerPulse {
           0%   { transform: scale(1);   opacity: .55; }
           70%  { transform: scale(2.6); opacity: 0; }
           100% { transform: scale(2.6); opacity: 0; }
         }
         .ledger-pulse-ring { animation: ledgerPulse 2.4s ease-out infinite; }
         /* Somebody who has asked for less motion still needs to see who is
            online; they just do not need it moving. */
         @media (prefers-reduced-motion: reduce) {
           .ledger-pulse-ring { animation: none; opacity: .35; }
         }` }} />

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
            {can("view_presence") && <PresenceStrip presence={presence} currentUsername={username} />}
            {role === "admin" && <button type="button" onClick={() => setAdminOpen(true)}
              style={{ color: T.ink, background: T.paper2, border: `1px solid ${T.rule}`, fontFamily: MONO, fontSize: 10, padding: "5px 7px", cursor: "pointer" }}>
              User management
            </button>}
            {onSignOut && (
              <button
                type="button"
                onClick={signOutAndClearPresence}
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
                     log={log} busy={busy} onPrevious={() => setDatasetHistoryOpen(true)}
                     canRestorePrevious={can("previous_data")}
                     forceOpen={dataReady && empty} />

        {empty ? <EmptyLedger loading={!dataReady} configured={isConfigured} /> : <>

        <FilterBar q={q} setQ={setQ} filters={filters} countsFor={countsFor}
                   onToggle={toggle} onClearOne={clearOne} onClearAll={clearAll} anyActive={anyActive}
                   disabled={duplicateView} />

        {duplicateView && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-3 py-2"
               style={{ background: "#FDF3EA", border: `1px solid ${T.works}`, borderLeft: `4px solid ${T.works}`,
                        fontFamily: MONO, fontSize: 12, color: T.ink }}>
            <span>
              <b>Duplicate Project IDs</b> · {duplicates.groups.length} ID
              {duplicates.groups.length === 1 ? "" : "s"} on {duplicates.rowCount} rows
              {duplicates.groups.some((g) => g.repeatedYear) && (
                <span style={{ color: T.bad }}>
                  {" · "}{duplicates.groups.filter((g) => g.repeatedYear).length} with the same ID twice in one year
                </span>
              )}
              <span style={{ color: T.inkSoft }}> — filters above are disabled in this view</span>
            </span>
            <button type="button" onClick={() => setDuplicatesOnly(false)}
                    style={{ border: `1px solid ${T.ink}`, background: T.panel, color: T.ink,
                             borderRadius: 2, padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>
              Back to all projects
            </button>
          </div>
        )}

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
                         isAdmin={role === "admin"}
                         onDeleteProject={can("delete_project") ? setDeletingProject : undefined}
                         onViewDuplicates={can("view_duplicates") ? () => setDuplicatesOnly(true) : undefined}
                         duplicateCount={duplicates.groups.length}
                         emptyLabel={duplicateView ? "No Project ID appears more than once." : undefined}
                         onAddProject={can("add_project") ? () => setAddingProject(true) : undefined}
                         onProjectHistory={(r) => setAuditTarget({ projectId: r.auditId || r.id, projectIds: r.auditIds,
                                                                   projectDisplayId: r.displayId, field: null })} />

            <TargetAnalysis rows={multipleTargetsEnabled ? rows : rows.map((record) => ({
              ...record,
              targets: record.primaryTarget ? [record.primaryTarget] : [],
            }))} />
            {auditTarget && <AuditModal key={`${auditTarget.projectId}:${auditTarget.field}`} target={auditTarget}
                                        isAdmin={can("delete_audit")}
                                        onClose={() => setAuditTarget(null)} />}
            {addingProject && (
              <AddProjectModal
                busy={busy}
                currentYear={new Date().getFullYear()}
                onCancel={() => setAddingProject(false)}
                onCreate={async (input) => {
                  const message = await createProject(input);
                  if (!message) setAddingProject(false);
                  return message;
                }} />
            )}
            {reloadPrompt && (
              <UnsavedReloadModal
                cellCount={dirtyCount}
                rowIds={[...dirtyIds]}
                saving={savingIds.size > 0}
                onSave={saveThenReload}
                onDiscard={reloadNow}
                onCancel={() => setReloadPrompt(false)} />
            )}
            {deletingProject && (
              <DeleteProjectModal
                key={deletingProject.identity}
                /* re-read from `records`, so a target saved or a value typed
                   while the dialog was open is counted by it */
                project={records.find((r) => r.identity === deletingProject.identity) || deletingProject}
                busy={busy}
                onCancel={() => setDeletingProject(null)}
                onConfirm={async (reason) => {
                  const row = records.find((r) => r.identity === deletingProject.identity) || deletingProject;
                  await deleteProject(row, reason);
                  setDeletingProject(null);
                }} />
            )}
            {multipleTargetsEnabled && manageTarget && (
              <TargetsModal
                key={manageTarget.id}
                /* re-read from `records` so the modal always sees the current
                   target list, including one it has just saved */
                project={records.find((r) => r.id === manageTarget.id) || manageTarget}
                onSaved={refreshTargets}
                isAdmin={can("delete_project")}
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
        {role === "admin" && datasetHistoryOpen && (
          <DatasetHistoryModal onClose={() => setDatasetHistoryOpen(false)} onRestore={restorePreviousDataset} />
        )}
        {forcePasswordChange && <PasswordChangePanel onDone={() => setForcePasswordChange(false)} />}
      </div>
    </div>
  );
}
