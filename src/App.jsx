import { Component, lazy, Profiler, Suspense, useEffect, useState } from "react";
import AuthGate from "./auth/AuthGate";
import ProjectLedger from "./ProjectLedger";
import PwaSplash from "./PwaSplash";
import { recordLedgerReactCommit, startLedgerTiming } from "./lib/ledgerStartup";
import { DTR_HOME, isDtrPath } from "./lib/dtrRoutes";

async function loadDtrSystem() {
  const finish = startLedgerTiming("feature.dtr_chunk");
  try {
    const module = await import("../DTR System/dtr-system.jsx");
    finish({ outcome: "ok" });
    return module;
  } catch (error) {
    finish({ outcome: "error" });
    throw error;
  }
}

const createLazyDtr = () => lazy(loadDtrSystem);

function DtrFallback({ onBack }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <div role="status" style={{ textAlign: "center" }}>
        <div>Loading DTR workspace…</div>
        <button type="button" onClick={onBack} style={{ marginTop: 12 }}>Back to Project Ledger</button>
      </div>
    </div>
  );
}

class DtrErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error) { console.error("DTR workspace chunk failed", error); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
        <div role="alert" style={{ maxWidth: 520, textAlign: "center" }}>
          <div style={{ fontWeight: 700 }}>Could not load the DTR workspace.</div>
          <div style={{ marginTop: 8, opacity: 0.75 }}>Project Ledger is unaffected. Retry the DTR download or return to the ledger.</div>
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 14 }}>
            <button type="button" onClick={this.props.onRetry}>Retry DTR</button>
            <button type="button" onClick={this.props.onBack}>Back to Project Ledger</button>
          </div>
        </div>
      </div>
    );
  }
}

function isStandalonePwa() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function App() {
  const [DTRSystem, setDtrSystem] = useState(() => createLazyDtr());
  const [dtrAttempt, setDtrAttempt] = useState(0);
  /* The address decides the workspace: /dtr/… is the DTR, everything else the ledger.
     The DTR keeps its own page in the address; here only entering and leaving it. */
  const [dtrOpen, setDtrOpen] = useState(() => isDtrPath(window.location.pathname));
  const openDtr = () => {
    if (!isDtrPath(window.location.pathname)) window.history.pushState(null, "", DTR_HOME);
    setDtrOpen(true);
  };
  const closeDtr = () => {
    window.history.pushState(null, "", "/");
    setDtrOpen(false);
  };
  /* Back / Forward across the boundary: from /dtr/punch back to /login, or forward again */
  useEffect(() => {
    const onPop = () => setDtrOpen(isDtrPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const retryDtr = () => {
    setDtrSystem(createLazyDtr());
    setDtrAttempt((attempt) => attempt + 1);
  };

  const [showPwaSplash, setShowPwaSplash] = useState(isStandalonePwa);
  useEffect(() => {
    if (!showPwaSplash) return undefined;
    const timer = window.setTimeout(() => setShowPwaSplash(false), 2400);
    return () => window.clearTimeout(timer);
  }, [showPwaSplash]);

  if (showPwaSplash) return <PwaSplash />;

  if (dtrOpen) return (
    <DtrErrorBoundary key={dtrAttempt} onRetry={retryDtr} onBack={closeDtr}>
      <Suspense fallback={<DtrFallback onBack={closeDtr} />}>
        <DTRSystem onBack={closeDtr} />
      </Suspense>
    </DtrErrorBoundary>
  );

  return (
    <AuthGate onLoginDoubleTap={openDtr}>
      {(user, signOut) => (
        <Profiler id="ProjectLedger" onRender={recordLedgerReactCommit}>
          <ProjectLedger key={user.id} user={user} onSignOut={signOut} />
        </Profiler>
      )}
    </AuthGate>
  );
}

export default App;
