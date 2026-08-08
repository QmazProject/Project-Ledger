import { useEffect, useState } from "react";
import AuthGate from "./auth/AuthGate";
import ProjectLedger from "./ProjectLedger";
import DTRSystem from "../DTR System/dtr-system.jsx";

function App() {
  const [dtrOpen, setDtrOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setDtrOpen(true);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (dtrOpen) return <DTRSystem onBack={() => setDtrOpen(false)} />;

  return (
    <AuthGate>
      {(user, signOut) => <ProjectLedger user={user} onSignOut={signOut} />}
    </AuthGate>
  );
}

export default App;
