/* Wrapper for a dialog whose code is downloaded the first time it is opened.

   Three things have to be true of every one of them, which is why this exists
   once rather than five times:

     - a failed download must not blank the ledger. The boundary is inside the
       ledger's own tree, so a chunk that never arrives costs the dialog and
       nothing else.
     - a failed download must be retryable. React.lazy memoises the rejected
       promise, so retrying means building a *new* lazy component — resetting
       state here is what makes the Retry button do anything at all.
     - the wait must be visible but not modal-blocking to the point of trapping
       somebody. Every state offers a way back out.

   The load timing is recorded under the same feature.*_chunk stage the DTR
   workspace and the Excel tools already use, so ?ledgerMetrics=1 reports all of
   them the same way. */

import { Component, Suspense, lazy, useCallback, useState } from "react";
import { T, DISPLAY, BODY } from "./shared";

const shade = {
  position: "fixed", inset: 0, background: "rgba(12,20,16,0.42)",
  display: "grid", placeItems: "center", zIndex: 60, padding: 20,
};
const card = {
  background: T.panel, border: `1px solid ${T.rule}`, borderRadius: 10,
  padding: "20px 22px", maxWidth: 460, fontFamily: BODY, color: T.ink,
  boxShadow: "0 18px 46px rgba(12,20,16,0.24)",
};
const button = {
  fontFamily: DISPLAY, fontSize: 12, padding: "6px 12px", borderRadius: 6,
  border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink, cursor: "pointer",
};

class DialogErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error) { console.error(`${this.props.label} failed to load`, error); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={shade}>
        <div role="alert" style={card}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 14 }}>
            {this.props.label} could not be downloaded.
          </div>
          <div style={{ marginTop: 8, fontSize: 12.5, color: T.inkSoft, lineHeight: 1.5 }}>
            The rest of the ledger is unaffected — your projects, edits and unsaved
            changes are all still there. Check the connection and try again.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
            <button type="button" style={button} onClick={this.props.onRetry}>Retry</button>
            <button type="button" style={button} onClick={this.props.onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }
}

function DialogFallback({ label, onClose }) {
  return (
    <div style={shade}>
      <div role="status" style={card}>
        <div style={{ fontFamily: DISPLAY, fontSize: 13.5 }}>Loading {label}…</div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button type="button" style={button} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* `load` must be a stable reference — declare it at module scope beside the
   other loaders, never inline in JSX, or every render would start a fresh
   download and remount the dialog. */
export default function LazyDialog({ label, load, onClose, children }) {
  const [attempt, setAttempt] = useState(0);
  const [Loaded, setLoaded] = useState(() => lazy(load));
  const retry = useCallback(() => {
    setLoaded(() => lazy(load));
    setAttempt((n) => n + 1);
  }, [load]);

  return (
    <DialogErrorBoundary key={attempt} label={label} onRetry={retry} onClose={onClose}>
      <Suspense fallback={<DialogFallback label={label} onClose={onClose} />}>
        {children(Loaded)}
      </Suspense>
    </DialogErrorBoundary>
  );
}
