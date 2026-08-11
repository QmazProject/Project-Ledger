import { useState } from "react";
import AuthGate from "./auth/AuthGate";
import ProjectLedger from "./ProjectLedger";
import DTRSystem from "../DTR System/dtr-system.jsx";

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

  if (dtrOpen) return <DTRSystem onBack={closeDtr} />;

  return (
    <AuthGate onLoginDoubleTap={openDtr}>
      {(user, signOut) => <ProjectLedger user={user} onSignOut={signOut} />}
    </AuthGate>
  );
}

export default App;
