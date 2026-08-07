import { useEffect, useState } from "react";
import { supabase, isConfigured } from "../lib/supabase";
import { T, DISPLAY, BODY } from "../theme";
import SignIn from "./SignIn";

/* Renders children(user, signOut) only for a signed-in session. */
export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(isConfigured); // nothing to check when unconfigured

  const setRoute = (nextSession) => {
    const route = nextSession ? "/project-ledger" : "/login";
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
      setRoute(nextSession);
      setChecking(false);
    });

    // covers sign-in, sign-out, token refresh and expiry
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      setSession(next);
      setRoute(next);
      setChecking(false);
    });

    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

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

  if (!session) return <SignIn />;

  const signOut = () => supabase.auth.signOut();
  return children(session.user, signOut);
}
