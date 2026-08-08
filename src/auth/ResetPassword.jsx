import { useState } from "react";
import { supabase } from "../lib/supabase";
import { T, DISPLAY, BODY, MONO } from "../theme";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) setError(updateError.message);
    else window.location.replace("/project-ledger");
  };

  const field = { width: "100%", padding: "9px 11px", fontFamily: MONO, fontSize: 13,
    color: T.ink, background: T.paper2, border: `1px solid ${T.rule}`, borderRadius: 2, outline: "none" };
  return <div style={{ minHeight: "100vh", background: T.paper, color: T.ink, fontFamily: BODY,
    display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <form onSubmit={submit} style={{ width: "100%", maxWidth: 400, padding: 22, background: T.panel, border: `1px solid ${T.rule}` }}>
      <h1 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 19, textTransform: "uppercase" }}>Set new password</h1>
      <p style={{ fontSize: 12, color: T.inkSoft, lineHeight: 1.5 }}>Choose a new password for your Project Ledger account.</p>
      <label style={{ display: "block", margin: "14px 0 5px", fontSize: 10, textTransform: "uppercase", color: T.inkSoft }}>New password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={field} autoFocus />
      <label style={{ display: "block", margin: "14px 0 5px", fontSize: 10, textTransform: "uppercase", color: T.inkSoft }}>Confirm password</label>
      <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={field} />
      {error && <div role="alert" style={{ marginTop: 14, padding: "8px 10px", fontSize: 12, color: T.bad, background: "#FBEEEC" }}>{error}</div>}
      <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 16, padding: "10px 12px", border: 0,
        background: busy ? T.inkFaint : T.ink, color: T.paper2, fontFamily: DISPLAY, fontWeight: 700, cursor: "pointer" }}>
        {busy ? "Saving…" : "Save new password"}
      </button>
    </form>
  </div>;
}
