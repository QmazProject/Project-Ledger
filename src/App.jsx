import { useEffect, useState } from "react";
import AuthGate from "./auth/AuthGate";
import ProjectLedger from "./ProjectLedger";
import PwaSplash from "./PwaSplash";
import DTRSystem from "../DTR System/dtr-system.jsx";

function isStandalonePwa() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function App() {
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

  const [showPwaSplash, setShowPwaSplash] = useState(isStandalonePwa);
  useEffect(() => {
    if (!showPwaSplash) return undefined;
    const timer = window.setTimeout(() => setShowPwaSplash(false), 2400);
    return () => window.clearTimeout(timer);
  }, [showPwaSplash]);

  if (showPwaSplash) return <PwaSplash />;

  if (dtrOpen) return <DTRSystem onBack={closeDtr} />;

  return (
    <AuthGate onLoginDoubleTap={openDtr}>
      {(user, signOut) => <ProjectLedger user={user} onSignOut={signOut} />}
    </AuthGate>
  );
}

export default App;
