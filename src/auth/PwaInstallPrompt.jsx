import { useEffect, useState } from "react";
import { T, DISPLAY, BODY, MONO } from "../theme";

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function platformHint() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "On iPhone or iPad, tap Share, then Add to Home Screen.";
  if (/Android/i.test(ua)) return "If the install prompt does not open, use your browser menu and choose Install app or Add to Home screen.";
  return "Use your browser's install icon in the address bar, or open the browser menu and choose Install Forlive.";
}

export default function PwaInstallPrompt() {
  const [open, setOpen] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");

  useEffect(() => {
    if (isStandalone()) return undefined;
    const showTimer = window.setTimeout(() => setOpen(true), 3000);
    const onBeforeInstall = (event) => {
      event.preventDefault();
      setDeferredPrompt(event);
    };
    const onInstalled = () => setOpen(false);
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.clearTimeout(showTimer);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!open) return null;

  const install = async () => {
    if (!deferredPrompt) {
      setHint(platformHint());
      return;
    }
    setBusy(true);
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      setOpen(false);
    } catch {
      setHint("The browser closed the install prompt. You can try again from the browser menu.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside role="dialog" aria-label="Install Forlive" style={{
      position: "fixed", right: 18, bottom: 18, zIndex: 100,
      width: "min(360px, calc(100vw - 36px))", padding: 14,
      background: T.panel, color: T.ink, border: `1px solid ${T.ink}`,
      boxShadow: `0 12px 32px ${T.ink}33`, fontFamily: BODY,
    }}>
      <button type="button" aria-label="Dismiss install prompt" onClick={() => setOpen(false)} style={{
        position: "absolute", top: 7, right: 8, border: 0, background: "transparent",
        color: T.inkSoft, fontSize: 20, lineHeight: 1, cursor: "pointer",
      }}>×</button>
      <div style={{ display: "flex", alignItems: "center", gap: 11, paddingRight: 20 }}>
        <img src="/icons/icon-192x192.png" alt="" width="44" height="44" style={{ borderRadius: 8, flex: "none" }} />
        <div>
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 17, letterSpacing: ".04em", textTransform: "uppercase" }}>Install Forlive</div>
          <div style={{ marginTop: 2, color: T.inkSoft, fontSize: 11.5, lineHeight: 1.4 }}>Open Project Ledger and DTR like an app.</div>
        </div>
      </div>
      <button type="button" onClick={install} disabled={busy} style={{
        width: "100%", marginTop: 12, padding: "9px 12px", border: 0, background: T.ink,
        color: T.paper2, fontFamily: DISPLAY, fontWeight: 700, fontSize: 12,
        letterSpacing: ".1em", textTransform: "uppercase", cursor: busy ? "default" : "pointer",
        opacity: busy ? .7 : 1,
      }}>{busy ? "Opening…" : "Install app"}</button>
      {hint && <div style={{ marginTop: 9, color: T.inkSoft, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.45 }}>{hint}</div>}
    </aside>
  );
}
