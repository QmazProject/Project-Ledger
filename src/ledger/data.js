/* The Supabase calls the on-demand dialogs share with the ledger.

   Split out for the same reason ./shared.js was: a lazily-imported dialog that
   reached back into ProjectLedger.jsx would form an import cycle and be pulled
   straight back into the startup chunk. None of this logic changed in the move
   — the RPCs, the audit writes and the fail-closed isConfigured guards are the
   ones that were already here. */

import { supabase, isConfigured } from "../lib/supabase";
import { numberOrNull as toNum, setWorkbookSheetReader } from "../lib/projectImport";
import { startLedgerTiming } from "../lib/ledgerStartup";
import { blankToNull } from "./shared";

export const DATASET_VERSION_TABLE = "project_ledger_dataset_versions";

let xlsxModulePromise = null;

export async function loadXlsx() {
  const finish = startLedgerTiming("feature.xlsx_chunk");
  try {
    if (!xlsxModulePromise) xlsxModulePromise = import("xlsx");
    const module = await xlsxModulePromise;
    /* ./lib/projectImport parses the sheets but deliberately does not import
       xlsx itself — a static import there would pull the whole library back
       into the startup chunk and make this dynamic import ineffective. Register
       the reader here, where the library has just arrived and no workbook has
       been read yet. */
    setWorkbookSheetReader(module.utils.sheet_to_json);
    finish({ outcome: "ok" });
    return module;
  } catch (error) {
    // React-style retry semantics for a transient chunk/network failure. A
    // rejected import promise must not poison every later Excel attempt.
    xlsxModulePromise = null;
    finish({ outcome: "error" });
    throw new Error(
      `Excel tools could not be downloaded. Check the connection and retry. ${error.message || ""}`.trim(),
      { cause: error },
    );
  }
}

export async function loadDatasetVersions() {
  if (!isConfigured || !supabase) return [];
  const { data, error } = await supabase.from(DATASET_VERSION_TABLE)
    .select("id, source_label, project_count, uploaded_by_username, uploaded_at, saved_reason, saved_by_username, saved_at")
    .order("saved_at", { ascending: false })
    .limit(25);
  if (error) throw error;
  return data || [];
}

export const AUDIT_TABLE = "project_manual_update_audit";

export const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : toNum(v));
export const newBatchId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

export async function loadTargetHistory(targetIds) {
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

export const targetColumns = (v) => ({
  scope: blankToNull(v.scope),
  target_qty: numOrNull(v.target_qty),
  unit: blankToNull(v.unit),
  start_date: blankToNull(v.start_date),
  target_completion: blankToNull(v.target_completion),
  actual_completion: blankToNull(v.actual_completion),
  actual_output: numOrNull(v.actual_output),
  remarks: blankToNull(v.remarks),
});

/* PostgREST surfaces a RAISE EXCEPTION as an error with the raised message,
   which is what the modal shows. Anything without one falls back to the code so
   a failure is never reported as a blank string. */
export async function callTargetRpc(fn, args) {
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
export async function deleteTargetPermanently(targetId, reason) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const rows = await callTargetRpc("admin_delete_project_target", {
    p_target_id: targetId, p_reason: reason,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function deleteAuditEntries(auditIds, reason) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  return callTargetRpc("admin_delete_audit_entries", {
    p_audit_ids: auditIds, p_reason: reason,
  });
}

export async function saveTargets({ projectId, creates = [], updates = [], archives = [], restores = [] }) {
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
      p_remarks: c.remarks,
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
      p_remarks: c.remarks,
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
