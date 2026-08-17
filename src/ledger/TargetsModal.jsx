/* Manage targets and the target history that layers above it.

   Downloaded on demand rather than at sign-in — see ProjectLedger.jsx for how
   it is loaded and what happens when the download fails. */

import { useState, useMemo, useRef, useEffect } from "react";
import { todayMs, assessTarget, isTrackable, validateTarget, targetWarnings, TARGET_FIELDS, SCOPE_LABEL } from "../lib/targets";
import { groupTargetHistory, actionLabel, isEventOnly, isBlankValue } from "../lib/targetHistory";
import { blankToNull, confirmPermanentDelete, fmtDate, T, DISPLAY, BODY, MONO, money, DRAFT_COLOR, PILL_BASE, pillStyle, emptyTarget } from "./shared";
import EditCell from "./EditCell";
import { loadTargetHistory, deleteTargetPermanently, saveTargets } from "./data";

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

export default function TargetsModal({ project, onClose, onSaved, isAdmin }) {
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
