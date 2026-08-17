/* Previous data — restores the shared ledger to an earlier saved state.

   Downloaded on demand rather than at sign-in — see ProjectLedger.jsx for how
   it is loaded and what happens when the download fails. */

import { useState, useEffect } from "react";
import { T, DISPLAY, MONO, formatUploadDateTime } from "./shared";
import { loadDatasetVersions } from "./data";

export default function DatasetHistoryModal({ onClose, onRestore }) {
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
