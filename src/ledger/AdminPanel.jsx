/* User management: accounts, roles, per-user permissions and upload history.

   Downloaded on demand rather than at sign-in — see ProjectLedger.jsx for how
   it is loaded and what happens when the download fails. */

import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { LEDGER_PERMISSIONS, T, DISPLAY, MONO, formatUploadDateTime } from "./shared";
import { loadXlsx } from "./data";

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

export default function AdminPanel({ onClose, currentUserId, onMultipleTargetsChanged }) {
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
      const XLSX = await loadXlsx();
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
