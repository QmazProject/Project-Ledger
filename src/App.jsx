import AuthGate from "./auth/AuthGate";
import ProjectLedger from "./ProjectLedger";

function App() {
  return (
    <AuthGate>
      {(user, signOut) => <ProjectLedger user={user} onSignOut={signOut} />}
    </AuthGate>
  );
}

export default App;
