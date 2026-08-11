import { useEffect, useState } from "react";
import { supabase, isConfigured } from "../lib/supabase";
import { T, DISPLAY, BODY } from "../theme";
import SignIn from "./SignIn";
import ResetPassword from "./ResetPassword";
import PwaInstallPrompt from "./PwaInstallPrompt";

/* Renders children(user, signOut) only for a signed-in session. */
export default function AuthGate({ children, onLoginDoubleTap }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(isConfigured); // nothing to check when unconfigured
  const [recovery, setRecovery] = useState(false);

  const setRoute = (nextSession, isRecovery = false) => {
    const route = isRecovery ? "/reset-password" : nextSession ? "/project-ledger" : "/login";
    if (window.location.pathname !== route) {
      window.history.replaceState({}, "", route);
    }
  };

  useEffect(() => {
    if (!isConfigured) return;

    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      const nextSession = data.session ?? null;
      setSession(nextSession);
      setRoute(nextSession, window.location.pathname === "/reset-password");
      setChecking(false);
    });

    // covers sign-in, sign-out, token refresh and expiry
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      if (!alive) return;
      const isRecovery = event === "PASSWORD_RECOVERY";
      setRecovery(isRecovery);
      setSession(next);
      setRoute(next, isRecovery);
      setChecking(false);
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

  const signOut = () => supabase.auth.signOut();
  return children(session.user, signOut);
}
