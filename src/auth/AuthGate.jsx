import { useEffect, useRef, useState } from "react";
import { supabase, isConfigured } from "../lib/supabase";
import { T, DISPLAY, BODY } from "../theme";
import SignIn from "./SignIn";
import ResetPassword from "./ResetPassword";
import PwaInstallPrompt from "./PwaInstallPrompt";
import { beginLedgerStartup } from "../lib/ledgerStartup";

/* Renders children(user, signOut) only for a signed-in session. */
export default function AuthGate({ children, onLoginDoubleTap }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(isConfigured); // nothing to check when unconfigured
  const [recovery, setRecovery] = useState(false);
  const activeUserId = useRef(null);

  const setRoute = (nextSession, isRecovery = false) => {
    const route = isRecovery ? "/reset-password" : nextSession ? "/project-ledger" : "/login";
    // Keep only the explicit, privacy-safe startup diagnostics switch across
    // the post-auth route change. Without this the redirect would remove it
    // before the dataset request starts, defeating the measurement run.
    const metricsSearch = new URLSearchParams(window.location.search).get("ledgerMetrics") === "1"
      ? "?ledgerMetrics=1" : "";
    if (window.location.pathname !== route) {
      window.history.replaceState({}, "", route + metricsSearch);
    }
  };

  useEffect(() => {
    if (!isConfigured) return;

    let alive = true;
    const activate = (nextSession, isRecovery = false) => {
      if (!nextSession || isRecovery) {
        activeUserId.current = null;
        setRecovery(isRecovery);
        setSession(nextSession);
        setRoute(nextSession, isRecovery);
        setChecking(false);
        return;
      }

      const nextUserId = nextSession.user?.id || null;
      if (activeUserId.current !== nextUserId) {
        activeUserId.current = nextUserId;
        beginLedgerStartup();
      }
      setRecovery(false);
      setSession(nextSession);
      setRoute(nextSession, false);
      setChecking(false);
    };

    supabase.auth.getSession().then(({ data }) => {
      if (alive) activate(data.session ?? null, window.location.pathname === "/reset-password");
    });

    // covers sign-in, sign-out, token refresh and expiry
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (alive) activate(next, event === "PASSWORD_RECOVERY");
    });

    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session || recovery || !onLoginDoubleTap) return undefined;

    let lastTap = 0;
    const onTouchEnd = (event) => {
      const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
      const hasTouch = navigator.maxTouchPoints > 0;
      if (!coarsePointer && !hasTouch) return;

      const now = Date.now();
      if (lastTap && now - lastTap <= 360) {
        event.preventDefault();
        lastTap = 0;
        onLoginDoubleTap();
      } else {
        lastTap = now;
      }
    };
    const onKeyDown = (event) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        onLoginDoubleTap();
      }
    };

    document.addEventListener("touchend", onTouchEnd, { passive: false });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [session, recovery, onLoginDoubleTap]);

  if (checking) {
    return (
      <div style={{
        minHeight: "100vh", background: T.paper, color: T.inkFaint, fontFamily: BODY,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ fontFamily: DISPLAY, fontWeight: 600, fontSize: 11, letterSpacing: ".16em", textTransform: "uppercase" }}>
          Loading…
        </div>
      </div>
    );
  }

  if (recovery || window.location.pathname === "/reset-password") return session ? <ResetPassword /> : <SignIn />;
  if (!session) return <><SignIn /><PwaInstallPrompt /></>;

  // This button signs out the browser in use. Supabase defaults to `global`,
  // which needlessly tries to revoke every device session and can return 403
  // when the server-side session was already removed. Local scope still clears
  // the persisted browser session and emits SIGNED_OUT for the route change.
  const signOut = () => supabase.auth.signOut({ scope: "local" });
  return children(session.user, signOut);
}
