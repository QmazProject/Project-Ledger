/* One revision-checked save with bounded retries, shared by the stores that merge
   (DTR year rows and settings). Domain rules live with each store; this only runs the
   loop the storage safety model requires:

   - write the merged value only if the row is still at the revision it was built on;
   - when storage refuses (another device saved first), take the copy it hands back,
     re-apply this device's changes to it, and try again;
   - after `maxAttempts` refusals give up — the change stays queued; it is never forced;
   - the base only moves forward on a successful write, so a failed or refused save can
     never make the next attempt mistake another device's data for this device's.

   base      {value, revision}  the copy this device's changes were made against
   apply     (latestValue) -> {value, conflicts}
   same      (a, b) -> boolean, "is there anything left to write"
   write     (value, expectedRevision) -> {ok, revision} | {conflict, payload, revision};
             throws when storage cannot be reached */

export const MAX_MERGE_ATTEMPTS = 4;

export async function saveMerged({ base, apply, same, write, maxAttempts = MAX_MERGE_ATTEMPTS }) {
  let latest = base;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const applied = apply(latest.value);
    /* everything left was already stored or lost to an earlier change: nothing to send */
    if (latest !== base && same(applied.value, latest.value)) {
      return { state: "saved", base: latest, value: latest.value, merged: true, conflicts: applied.conflicts, wrote: false };
    }
    let res;
    try { res = await write(applied.value, latest.revision); }
    catch { return { state: "offline", base }; }
    if (res && res.ok) {
      return {
        state: "saved", base: { value: applied.value, revision: res.revision }, value: applied.value,
        merged: latest !== base, conflicts: applied.conflicts, wrote: true,
      };
    }
    if (res && res.conflict) { latest = { value: res.payload, revision: Number(res.revision) || 0 }; continue; }
    return { state: "failed", base };
  }
  return { state: "conflict-retries-exhausted", base };
}

/* A queued offline change can only be merged against the copy it was made from. An entry
   without one (queued by an older version) is not mergeable, and must never be sent. */
export function queuedBase(kept) {
  if (!kept || typeof kept !== "object" || !kept.value || typeof kept.value !== "object") return null;
  const revision = Number(kept.revision);
  return Number.isFinite(revision) ? { value: kept.value, revision } : null;
}
