import { Component, lazy, Profiler, Suspense, useEffect, useState } from "react";
import AuthGate from "./auth/AuthGate";
import ProjectLedger from "./ProjectLedger";
import PwaSplash from "./PwaSplash";
import { recordLedgerReactCommit, startLedgerTiming } from "./lib/ledgerStartup";

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
  const [dtrOpen, setDtrOpen] = useState(() => {
    try { return window.sessionStorage.getItem("forlive.workspace") === "dtr"; }
    catch { return false; }
  });
  const openDtr = () => {
    try { window.sessionStorage.setItem("forlive.workspace", "dtr"); } catch { /* unavailable */ }
    setDtrOpen(true);
  };
  const closeDtr = () => {
    try { window.sessionStorage.setItem("forlive.workspace", "ledger"); } catch { /* unavailable */ }
    setDtrOpen(false);
  };
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
