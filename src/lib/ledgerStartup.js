/* Privacy-safe startup measurements for the Project Ledger.
 *
 * Entries contain stage names, durations and aggregate counts only. Project
 * values, usernames, ids, request URLs and error messages are deliberately not
 * accepted. Add ?ledgerMetrics=1 to the URL when an approximate decoded JSON
 * size is needed; serialising a large payload solely to count its bytes should
 * not be part of every normal sign-in.
 */

const MAX_ENTRIES = 160;
const SAFE_FIELDS = new Set([
  "outcome", "phase", "count", "projectCount", "manualCount", "targetCount",
  "approxPayloadBytes", "actualDurationMs", "baseDurationMs", "startTimeMs", "commitTimeMs",
  "datasetReady", "manualReady", "targetsReady", "profileReady", "permissionsReady",
]);

let entries = [];
let points = new Map();

const clock = () => globalThis.performance?.now?.() ?? Date.now();
const rounded = (value) => Math.round(Number(value) * 100) / 100;

const diagnosticsEnabled = () => {
  try {
    return new URLSearchParams(globalThis.location?.search || "").get("ledgerMetrics") === "1";
  } catch {
    return false;
  }
};

const safeDetails = (details = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (!SAFE_FIELDS.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = rounded(value);
    else if (typeof value === "boolean") out[key] = value;
    else if ((key === "outcome" || key === "phase") && typeof value === "string") out[key] = value.slice(0, 24);
  }
  return out;
};

const expose = () => {
  if (typeof globalThis.window === "undefined") return;
  globalThis.window.__PROJECT_LEDGER_STARTUP_METRICS__ = {
    diagnosticsEnabled: diagnosticsEnabled(),
    entries: entries.map((entry) => ({ ...entry })),
  };
};

const record = (stage, durationMs, details) => {
  const entry = {
    stage: String(stage || "unknown").slice(0, 64),
    durationMs: rounded(Math.max(0, durationMs || 0)),
    ...safeDetails(details),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  expose();
  if (diagnosticsEnabled()) console.info("Project Ledger startup", entry);
  return entry;
};

export function beginLedgerStartup() {
  entries = [];
  points = new Map();
  points.set("authenticated", clock());
  expose();
}

export function markLedgerStartupPoint(name) {
  points.set(String(name), clock());
}

export function recordLedgerStartupSince(stage, point, details) {
  const started = points.get(String(point));
  if (started === undefined) return null;
  return record(stage, clock() - started, details);
}

export function startLedgerTiming(stage) {
  const started = clock();
  let finished = false;
  return (details = {}) => {
    if (finished) return null;
    finished = true;
    return record(stage, clock() - started, details);
  };
}

export function measureLedgerWork(stage, work, details = {}) {
  const finish = startLedgerTiming(stage);
  try {
    const value = work();
    finish({ outcome: "ok", ...details });
    return value;
  } catch (error) {
    finish({ outcome: "error", ...details });
    throw error;
  }
}

export function measureApproximateJsonBytes(payload) {
  if (!diagnosticsEnabled()) return null;
  const finish = startLedgerTiming("dataset.payload_size_measure");
  try {
    const json = JSON.stringify(payload ?? null);
    const bytes = typeof TextEncoder === "undefined" ? json.length : new TextEncoder().encode(json).byteLength;
    finish({ outcome: "ok", approxPayloadBytes: bytes });
    return bytes;
  } catch {
    finish({ outcome: "error" });
    return null;
  }
}

export function recordLedgerReactCommit(_id, phase, actualDuration, baseDuration, startTime, commitTime) {
  record("react.project_ledger_commit", actualDuration, {
    outcome: "ok",
    phase,
    actualDurationMs: actualDuration,
    baseDurationMs: baseDuration,
    startTimeMs: startTime,
    commitTimeMs: commitTime,
  });
}

export function ledgerReadiness({ datasetStatus, manualStatus, targetsStatus, profileStatus, forcePasswordChange }) {
  const datasetReady = datasetStatus === "ready";
  const manualReady = manualStatus === "ready";
  const targetsReady = targetsStatus === "ready";
  const profileReady = profileStatus === "ready";
  const coreReady = datasetReady && manualReady && profileReady;
  return {
    datasetReady,
    manualReady,
    targetsReady,
    profileReady,
    coreReady,
    mutationsReady: coreReady && !forcePasswordChange,
    targetMutationsReady: coreReady && targetsReady && !forcePasswordChange,
  };
}

export function getLedgerStartupMetrics() {
  return entries.map((entry) => ({ ...entry }));
}

export function resetLedgerStartupMetrics() {
  entries = [];
  points = new Map();
  expose();
}
