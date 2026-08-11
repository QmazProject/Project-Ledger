import { useEffect, useState } from "react";
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

  useEffect(() => {
    if (dtrOpen) return undefined;

    let lastTap = 0;
    const onTouchEnd = (event) => {
      const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
      const hasTouch = navigator.maxTouchPoints > 0;
      if (!coarsePointer && !hasTouch) return;

      const now = Date.now();
      if (lastTap && now - lastTap <= 360) {
        event.preventDefault();
        lastTap = 0;
        openDtr();
      } else {
        lastTap = now;
      }
    };

    document.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => document.removeEventListener("touchend", onTouchEnd);
  }, [dtrOpen]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        openDtr();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (dtrOpen) return <DTRSystem onBack={closeDtr} />;

  return (
    <AuthGate>
      {(user, signOut) => <ProjectLedger user={user} onSignOut={signOut} />}
    </AuthGate>
  );
}

export default App;
