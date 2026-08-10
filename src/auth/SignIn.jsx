import { useEffect, useRef, useState } from "react";
import HCaptcha from "@hcaptcha/react-hcaptcha";
import { supabase, isConfigured } from "../lib/supabase";
import { T, DISPLAY, BODY, MONO } from "../theme";

/* Supabase returns terse messages — say something a person can act on */
function readable(err) {
  const m = String(err?.message || err || "").toLowerCase();
  if (m.includes("invalid login credentials")) return "That username and password don't match an account.";
  if (m.includes("email not confirmed")) return "This account hasn't been confirmed yet. Ask the administrator to confirm it in Supabase.";
  if (m.includes("too many requests") || m.includes("rate limit")) return "Too many attempts. Wait a moment and try again.";
  if (m.includes("failed to fetch") || m.includes("network")) return "Can't reach the server. Check your internet connection.";
  return err?.message || "Sign in failed. Try again.";
}

async function functionErrorMessage(error, data) {
  if (data?.error) return data.error;
  try {
    const body = await error?.context?.json();
    if (body?.error) return body.error;
  } catch { /* keep the SDK message when the response body is unavailable */ }
  return error?.message || "Sign in failed. Try again.";
}

export default function SignIn() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [forgot, setForgot] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaEnabled, setCaptchaEnabled] = useState(true);
  const captchaRef = useRef(null);
  const captchaSiteKey = import.meta.env.VITE_HCAPTCHA_SITE_KEY || import.meta.env.VITE_CAPTCHA_SITE_KEY;

  useEffect(() => {
    let alive = true;
    supabase?.from("security_settings").select("captcha_enabled").eq("id", 1).maybeSingle()
      .then(({ data }) => { if (alive && data) setCaptchaEnabled(data.captcha_enabled !== false); });
    return () => { alive = false; };
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");

    if (!username.trim() || (!forgot && !password)) {
      setError(forgot ? "Enter your username." : "Enter your username and password.");
      return;
    }

    if (captchaEnabled && !captchaToken) {
      setError("Complete the CAPTCHA challenge first.");
      return;
    }

    setBusy(true);
    const normalizedUsername = username.trim().toLowerCase();
    if (forgot) {
      await supabase.functions.invoke("password-recovery", {
        body: { username: normalizedUsername, ...(captchaEnabled ? { captcha_token: captchaToken } : {}) },
      });
      if (captchaEnabled) captchaRef.current?.resetCaptcha();
      setCaptchaToken("");
      setBusy(false);
      setNotice("If the username exists, a recovery link has been sent. Please check the registered email.");
      return;
    }

    const { data, error: functionError } = await supabase.functions.invoke("auth-login", {
      body: { username: normalizedUsername, password, ...(captchaEnabled ? { captcha_token: captchaToken } : {}) },
    });
    if (!functionError && data?.session) await supabase.auth.setSession(data.session);
    if (captchaEnabled) captchaRef.current?.resetCaptcha();
    setCaptchaToken("");
    setBusy(false);

    // on success the auth listener in AuthGate swaps this screen out
    if (functionError || data?.error) {
      setError(readable({ message: await functionErrorMessage(functionError, data) }));
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
      <div className="login-panel" style={{
        width: "100%", maxWidth: 400, background: T.panel,
        border: `1px solid ${T.rule}`,
        boxShadow: `0 0 0 1px ${T.ink}66, 0 0 8px ${T.ink}55, 0 24px 50px -30px rgba(22,33,28,.75)`, borderRadius: 2,
        position: "relative", overflow: "visible", isolation: "isolate",
      }}>
        <style>{`
          .login-border-runner {
            position: absolute;
            inset: -8px;
            width: calc(100% + 16px);
            height: calc(100% + 16px);
            pointer-events: none;
            z-index: 2;
          }
          .login-border-runner rect {
            stroke-dasharray: 260 740;
            animation: login-border-runner 3s linear infinite;
            filter: drop-shadow(0 0 3px rgba(215, 53, 47, .95));
          }
          .login-panel > div,
          .login-panel > form {
            position: relative;
            z-index: 1;
          }
          @keyframes login-border-runner {
            to { stroke-dashoffset: -1000; }
          }
        `}</style>
        <svg className="login-border-runner" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <rect className="runner-one" x="1" y="1" width="98" height="98" rx="2" pathLength="1000"
                fill="none" stroke="#d7352f" strokeWidth="1" />
        </svg>
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
              <label htmlFor="username" style={label}>Username</label>
              <input id="username" type="text" value={username} autoFocus
                     autoComplete="username" disabled={busy} style={field}
                     onChange={(e) => setUsername(e.target.value)}
                     onFocus={(e) => (e.target.style.borderColor = T.ink)}
                     onBlur={(e) => (e.target.style.borderColor = T.rule)} />
            </div>

            {!forgot && <div style={{ marginBottom: 16 }}>
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
            </div>}

            {error && (
              <div role="alert" style={{
                marginBottom: 14, padding: "8px 10px", fontSize: 12, lineHeight: 1.45,
                color: T.bad, background: "#FBEEEC", border: `1px solid ${T.bad}33`, borderLeft: `3px solid ${T.bad}`,
              }}>
                {error}
              </div>
            )}

            {notice && <div role="status" style={{ marginBottom: 14, padding: "8px 10px", fontSize: 12,
                                                     color: T.collected, background: "#E4EFEC", border: `1px solid ${T.collected}55` }}>
              {notice}
            </div>}

            {captchaEnabled && captchaSiteKey ? <div style={{ marginBottom: 14, display: "flex", justifyContent: "center" }}>
              <HCaptcha ref={captchaRef} sitekey={captchaSiteKey} onVerify={setCaptchaToken}
                        onExpire={() => setCaptchaToken("")} onError={() => setCaptchaToken("")} />
            </div> : captchaEnabled ? <div role="alert" style={{ marginBottom: 14, color: T.bad, fontSize: 12 }}>
              CAPTCHA site key is not configured.
            </div> : <div role="status" style={{ marginBottom: 14, color: T.inkSoft, fontSize: 12 }}>
              CAPTCHA is disabled by an administrator.
            </div>}

            <button type="submit" disabled={busy}
                    style={{
                      width: "100%", padding: "10px 12px", border: "none", borderRadius: 2,
                      background: busy ? T.inkFaint : T.ink, color: T.paper2,
                      fontFamily: DISPLAY, fontWeight: 700, fontSize: 12,
                      letterSpacing: ".12em", textTransform: "uppercase",
                      cursor: busy ? "default" : "pointer",
                    }}>
              {busy ? (forgot ? "Sending…" : "Signing in…") : (forgot ? "Send recovery link" : "Sign in")}
            </button>

            <button type="button" onClick={() => { setForgot((v) => !v); setError(""); setNotice(""); }}
                    style={{ width: "100%", marginTop: 10, padding: "7px 12px", border: `1px solid ${T.rule}`,
                             background: T.paper2, color: T.inkSoft, fontFamily: MONO, fontSize: 11, cursor: "pointer" }}>
              {forgot ? "Back to sign in" : "Forgot password?"}
            </button>

            <div style={{ marginTop: 14, fontSize: 11, lineHeight: 1.5, color: T.inkFaint }}>
              {forgot ? "Users without an active email must contact an administrator for a temporary password." :
                "Please use your Acumatica username and password to proceed."}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
