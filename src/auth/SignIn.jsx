import { useState } from "react";
import { supabase, isConfigured } from "../lib/supabase";
import { T, DISPLAY, BODY, MONO } from "../theme";

/* Supabase returns terse messages — say something a person can act on */
function readable(err) {
  const m = String(err?.message || err || "").toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match an account.";
  if (m.includes("email not confirmed")) return "This account hasn't been confirmed yet. Ask the administrator to confirm it in Supabase.";
  if (m.includes("too many requests") || m.includes("rate limit")) return "Too many attempts. Wait a moment and try again.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Can't reach the server. Check your internet connection.";
  return err?.message || "Sign in failed. Try again.";
}

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError("");

    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }

    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);

    // on success the auth listener in AuthGate swaps this screen out
    if (error) {
      setError(readable(error));
      setPassword("");
    }
  };

  const field = {
    width: "100%", padding: "9px 11px", fontFamily: MONO, fontSize: 13,
    color: T.ink, background: T.paper2, border: `1px solid ${T.rule}`,
    borderRadius: 2, outline: "none",
  };
  const label = {
    display: "block", marginBottom: 5, fontFamily: DISPLAY, fontWeight: 600,
    fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: T.inkSoft,
  };

  return (
    <div style={{
      minHeight: "100vh", background: T.paper, color: T.ink, fontFamily: BODY,
      backgroundImage: `linear-gradient(${T.ruleSoft} 1px,transparent 1px),linear-gradient(90deg,${T.ruleSoft} 1px,transparent 1px)`,
      backgroundSize: "28px 28px", backgroundPosition: "-1px -1px",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div style={{
        width: "100%", maxWidth: 400, background: T.panel,
        border: `1px solid ${T.rule}`, borderTop: `3px solid ${T.ink}`,
        boxShadow: "0 24px 50px -30px rgba(22,33,28,.75)", borderRadius: 2,
      }}>
        <div style={{ padding: "20px 22px 14px", borderBottom: `1px solid ${T.rule}` }}>
          <h1 style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 20, letterSpacing: ".045em", textTransform: "uppercase" }}>
            Project Ledger
          </h1>
          <div style={{ marginTop: 4, fontSize: 12, color: T.inkSoft }}>
            QM Builders — sign in to continue
          </div>
        </div>

        {!isConfigured ? (
          <div style={{ padding: 22, fontSize: 13, color: T.inkSoft, lineHeight: 1.55 }}>
            <b style={{ color: T.bad }}>Not configured.</b> Add <code style={{ fontFamily: MONO }}>VITE_SUPABASE_URL</code> and{" "}
            <code style={{ fontFamily: MONO }}>VITE_SUPABASE_ANON_KEY</code> to <code style={{ fontFamily: MONO }}>.env.local</code>,
            then restart the dev server.
          </div>
        ) : (
          <form onSubmit={submit} style={{ padding: 22 }}>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor="email" style={label}>Email</label>
              <input id="email" type="email" value={email} autoFocus
                     autoComplete="username" disabled={busy} style={field}
                     onChange={(e) => setEmail(e.target.value)}
                     onFocus={(e) => (e.target.style.borderColor = T.ink)}
                     onBlur={(e) => (e.target.style.borderColor = T.rule)} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <label htmlFor="password" style={label}>Password</label>
                <button type="button" onClick={() => setShow((s) => !s)}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                                 marginBottom: 5, fontFamily: MONO, fontSize: 10, color: T.inkFaint }}>
                  {show ? "hide" : "show"}
                </button>
              </div>
              <input id="password" type={show ? "text" : "password"} value={password}
                     autoComplete="current-password" disabled={busy} style={field}
                     onChange={(e) => setPassword(e.target.value)}
                     onFocus={(e) => (e.target.style.borderColor = T.ink)}
                     onBlur={(e) => (e.target.style.borderColor = T.rule)} />
            </div>

            {error && (
              <div role="alert" style={{
                marginBottom: 14, padding: "8px 10px", fontSize: 12, lineHeight: 1.45,
                color: T.bad, background: "#FBEEEC", border: `1px solid ${T.bad}33`, borderLeft: `3px solid ${T.bad}`,
              }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={busy}
                    style={{
                      width: "100%", padding: "10px 12px", border: "none", borderRadius: 2,
                      background: busy ? T.inkFaint : T.ink, color: T.paper2,
                      fontFamily: DISPLAY, fontWeight: 700, fontSize: 12,
                      letterSpacing: ".12em", textTransform: "uppercase",
                      cursor: busy ? "default" : "pointer",
                    }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>

            <div style={{ marginTop: 14, fontSize: 11, lineHeight: 1.5, color: T.inkFaint }}>
              Accounts are created by the administrator in Supabase. There is no self sign-up.
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
