/* What the panel is allowed to conclude from a load that may have failed.
 *
 * The panel reads two independent things from the database: hand-typed project
 * values (status, contract, remarks) and targets. Both used to be awaited
 * together, and both used to fall back to an empty collection on failure —
 * which reads exactly like a successful load of nothing. That single ambiguity
 * produced two separate ways to destroy data:
 *
 *   1. A failed load of *either* one discarded *both* results. Every hand-typed
 *      value vanished from the panel, and the next save of any row sent the
 *      columns it had not loaded as null, overwriting the stored values with
 *      the blanks on screen.
 *   2. A failed target load made every project read "No target", so adding one
 *      through the modal would duplicate a target that already existed.
 *
 * Both are the same mistake: absence of evidence rendered as evidence of
 * absence. Nothing here ever converts a failure into an empty collection. A
 * load that did not succeed carries no value at all, and the caller has to say
 * what to do about it.
 *
 * Pure on purpose — no React, no Supabase, no network — so the failure can be
 * reproduced in a test instead of by breaking a database.
 */

export const LOAD = {
  LOADING: "loading",
  READY: "ready",
  FAILED: "failed",
};

export const loadingState = () => ({ status: LOAD.LOADING, value: null, error: "" });

const messageOf = (reason) => {
  if (!reason) return "Unknown error";
  if (typeof reason === "string") return reason;
  return reason.message || String(reason);
};

/** Turns one Promise.allSettled entry into a load state.
 *
 *  A rejection produces `value: null`, never an empty Map. That is the whole
 *  point: `null` cannot be read as "there is nothing", so every consumer is
 *  forced to handle the failure rather than silently inheriting a wrong answer.
 */
export function settleLoad(result) {
  if (result && result.status === "fulfilled") {
    return { status: LOAD.READY, value: result.value, error: "" };
  }
  return { status: LOAD.FAILED, value: null, error: messageOf(result && result.reason) };
}

export const isReady = (state) => Boolean(state) && state.status === LOAD.READY && state.value != null;
export const hasFailed = (state) => Boolean(state) && state.status === LOAD.FAILED;

/** The targets of one project, and whether that answer is trustworthy.
 *
 *  `unavailable` is true both while loading and after a failure: in neither
 *  case does the panel know what targets exist, and the difference matters only
 *  to the wording of the message, not to what may be concluded.
 */
export function projectTargets(state, key) {
  if (!isReady(state)) return { targets: [], unavailable: true };
  return { targets: state.value.get(key) || [], unavailable: false };
}

/** The value behind the "Targets" filter. A third value rather than a forced
 *  choice between the two truthful ones — filtering a project into "No target"
 *  because the query failed would be a lie the user could act on. */
export const TARGETS_UNKNOWN = "Targets unavailable";
export const targetsLabel = (unavailable, count) =>
  unavailable ? TARGETS_UNKNOWN : count > 0 ? "With target" : "No target";

export const MANUAL_UNAVAILABLE_REASON =
  "Saved project updates could not be loaded, so saving is blocked — a save now would overwrite stored values with blanks. Reload the page and try again.";

/**
 * Everything one project-level save needs, or a refusal.
 *
 * Refuses outright unless the hand-typed values were actually loaded. The save
 * writes status, contract and remarks together, so a row assembled from a
 * failed load sends null for every field the user did not personally type —
 * and the audit trail then records that as a deliberate edit. There is no
 * partial version of this that is safe: without the stored values there is
 * nothing to preserve them from.
 */
export function buildManualSave({ manual, id, key, draft, importedRow, entry: resolved }) {
  if (!isReady(manual) || !(manual.value instanceof Map)) {
    return { ok: false, reason: MANUAL_UNAVAILABLE_REASON };
  }
  const entry = resolved || manual.value.get(key);
  const stored = entry?.values || {};
  return {
    ok: true,
    /* write back to the row this project's values were actually loaded from —
       an ID whose casing drifted between workbook versions is still the same
       project, and must not gain a second row */
    storedId: entry?.storedId || id,
    /* stored values first, then what was typed: every field the user did not
       touch keeps the value that is in the database */
    values: { ...stored, ...(draft || {}) },
    previous: { ...(importedRow || {}), ...stored },
    changedFields: new Set(Object.keys(draft || {})),
  };
}
