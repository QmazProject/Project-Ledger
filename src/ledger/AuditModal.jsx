/* The per-cell audit trail, opened by right-clicking a ledger cell.

   Downloaded on demand rather than at sign-in — see ProjectLedger.jsx for how
   it is loaded and what happens when the download fails. */

import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { confirmPermanentDelete, T, DISPLAY, MONO, AUDIT_FIELD_LABELS, AUDIT_DISPLAY_LABELS, auditValue } from "./shared";
import { deleteAuditEntries } from "./data";

export default function AuditModal({ target, onClose, isAdmin }) {
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
