/* Concurrency-safe saving for the shared employee roster.

   The roster is one stored list (`dtr:roster`), shared by every device. Saving the
   whole in-memory copy let a device that loaded it earlier overwrite employees and
   fields another device had changed since. So a save never sends "my copy". It works
   out what THIS device changed since the copy it last synced (its base) — per
   employee, per field — and applies only those changes to the latest stored roster,
   under the same revision check the DTR year rows use: a write built from a copy the
   row has moved past is refused, the current copy comes back, and the changes are
   re-applied to it.

   Rules when two devices touch the same thing:
   - different employees, or different fields of one employee: both survive;
   - the same field: the change that reached storage first wins. The later device's
     value is NOT written; it is reported as a conflict and the device takes the
     stored value, so nobody's change is overwritten unseen;
   - Sunday periods merge per period (one device adding a cut-off never removes
     another's);
   - a passcode (hash, salt and work factor) and a signature placement (x, y, scale)
     move as one value — mixing halves of two passcodes would lock the employee out;
   - an employee deleted on another device is not recreated by an edit made from a
     stale copy; the edit is dropped and reported;
   - a delete wins over a concurrent edit of the same employee;
   - an add whose ID another device has already taken keeps the first one stored. */

export const MAX_ROSTER_ATTEMPTS = 4;

/* The stored shape of one employee: exactly what the roster save has always written. */
export function normalizeEmployee(e) {
  return {
    id: String(e.id || "").trim(), name: String(e.name || "").trim(),
    position: String(e.position || "").trim(), site: String(e.site || "").trim(),
    photo: e.photo || "", signature: e.signature || "",
    signatureEnabled: e.signatureEnabled === true, signatureOnLogbook: e.signatureOnLogbook === true,
    signatureX: Number(e.signatureX) || 0, signatureY: Number(e.signatureY) || 0, signatureScale: Number(e.signatureScale) || 1,
    role: e.role === "admin" ? "admin" : "viewer",
    /* carried through explicitly: dropping these on an unrelated roster edit would
       silently unlock every account that had a passcode */
    pinHash: e.pinHash || "", pinSalt: e.pinSalt || "", pinIter: Number(e.pinIter) || 0,
    /* same hazard: losing this would quietly hide Sundays somebody had already filled in */
    sundayPeriods: Array.isArray(e.sundayPeriods) ? e.sundayPeriods.map(String) : [],
  };
}

/* rows with neither an ID nor a name are blank form rows and are never stored */
export const normalizeRoster = (list) => (Array.isArray(list) ? list : [])
  .filter((e) => e && typeof e === "object")
  .map(normalizeEmployee)
  .filter((e) => e.id || e.name);

/* fields that change together; everything else is its own group */
const GROUPS = [
  ["name"], ["position"], ["site"], ["photo"], ["signature"], ["signatureEnabled"], ["signatureOnLogbook"],
  ["signatureX", "signatureY", "signatureScale"], ["role"], ["pinHash", "pinSalt", "pinIter"],
];
const SET_FIELDS = ["sundayPeriods"];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pick = (emp, fields) => Object.fromEntries(fields.map((f) => [f, emp[f]]));

/* An employee is identified by ID. A row still being typed has no ID yet; it is keyed
   by name so it can be saved and found again, as it always has been. */
function keyed(list) {
  const seen = new Map();
  return list.map((emp) => {
    let key = emp.id ? `id:${emp.id}` : `draft:${emp.name}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    if (n) key += `#${n}`;
    return { key, emp };
  });
}

function fieldOps(key, was, emp) {
  const ops = [];
  GROUPS.forEach((fields) => {
    const from = pick(was, fields), to = pick(emp, fields);
    if (!same(from, to)) ops.push({ op: "update", key, id: emp.id, name: emp.name || was.name, fields, from, to });
  });
  SET_FIELDS.forEach((field) => {
    const add = emp[field].filter((v) => !was[field].includes(v));
    const remove = was[field].filter((v) => !emp[field].includes(v));
    if (add.length || remove.length) ops.push({ op: "set", key, id: emp.id, name: emp.name || was.name, field, add, remove });
  });
  return ops;
}

/* What `current` changed relative to `base`, both normalized. An ID edit (the same
   named row losing one key and gaining another) is a rename, so that a clash with an
   ID taken elsewhere cannot delete the employee being renamed. */
export function diffRoster(base, current) {
  const baseKeyed = keyed(base), curKeyed = keyed(current);
  const baseBy = new Map(baseKeyed.map((x) => [x.key, x.emp]));
  const curKeys = new Set(curKeyed.map((x) => x.key));
  const removed = baseKeyed.filter((x) => !curKeys.has(x.key));
  const ops = [];
  curKeyed.forEach(({ key, emp }, i) => {
    const was = baseBy.get(key);
    if (was) { ops.push(...fieldOps(key, was, emp)); return; }
    const renamedFrom = emp.name && removed.find((r) => !r.paired && r.emp.name === emp.name);
    if (renamedFrom) {
      renamedFrom.paired = true;
      ops.push({ op: "rename", key: renamedFrom.key, to: key, fromId: renamedFrom.emp.id, id: emp.id, name: emp.name });
      ops.push(...fieldOps(key, { ...renamedFrom.emp, id: emp.id }, emp));
      return;
    }
    ops.push({ op: "add", key, id: emp.id, name: emp.name, emp, after: i ? curKeyed[i - 1].key : null });
  });
  removed.filter((r) => !r.paired).forEach((r) => ops.unshift({ op: "remove", key: r.key, id: r.emp.id, name: r.emp.name }));
  return ops;
}

/* Apply one device's changes to the latest stored roster. Returns the roster to
   store, plus what could not be applied and why. */
export function applyRosterOps(latest, ops) {
  const list = keyed(latest).map((x) => ({ key: x.key, emp: { ...x.emp, sundayPeriods: [...x.emp.sundayPeriods] } }));
  const find = (key) => list.findIndex((x) => x.key === key);
  const conflicts = [], dropped = [], blocked = new Set();
  const drop = (o) => { if (!dropped.some((d) => d.key === o.key)) dropped.push({ key: o.key, id: o.id, name: o.name }); };
  ops.forEach((o) => {
    if (blocked.has(o.key)) return;
    const i = find(o.key);
    if (o.op === "remove") { if (i >= 0) list.splice(i, 1); return; }
    if (o.op === "add") {
      if (i >= 0) { conflicts.push({ key: o.key, id: o.id, name: o.name, fields: ["id"], kept: list[i].emp.name, wanted: o.name }); blocked.add(o.key); return; }
      const after = o.after === null ? -1 : find(o.after);
      const at = o.after === null ? 0 : (after >= 0 ? after + 1 : list.length);
      list.splice(at, 0, { key: o.key, emp: { ...o.emp, sundayPeriods: [...o.emp.sundayPeriods] } });
      return;
    }
    if (o.op === "rename") {
      if (i < 0) { drop(o); blocked.add(o.to); return; }
      if (find(o.to) >= 0) { conflicts.push({ key: o.key, id: o.fromId, name: o.name, fields: ["id"], kept: o.fromId, wanted: o.id }); blocked.add(o.to); return; }
      list[i] = { key: o.to, emp: { ...list[i].emp, id: o.id } };
      return;
    }
    if (i < 0) { drop(o); return; }
    const emp = list[i].emp;
    if (o.op === "update") {
      const now = pick(emp, o.fields);
      if (same(now, o.from)) Object.assign(emp, o.to);
      else if (!same(now, o.to)) conflicts.push({ key: o.key, id: o.id, name: emp.name || o.name, fields: o.fields, kept: now, wanted: o.to });
      return;
    }
    if (o.op === "set") {
      const held = emp[o.field].filter((v) => !o.remove.includes(v));
      emp[o.field] = [...held, ...o.add.filter((v) => !held.includes(v))];
    }
  });
  return { roster: list.map((x) => x.emp), conflicts, dropped };
}

/* One save: diff against the base this device last synced, apply to the latest stored
   roster, write only if storage is still at that revision, and on a refusal re-apply
   to the copy that came back. `write(roster, expectedRevision)` resolves to
   {ok, revision} or {conflict, payload, revision}, and throws when storage cannot be
   reached. The base only moves forward on a successful write, so a failed save can
   never make the next diff think another device's employees were deleted here. */
export async function saveRosterChanges(base, current, write, maxAttempts = MAX_ROSTER_ATTEMPTS) {
  const submitted = normalizeRoster(current);
  const ops = diffRoster(base.roster, submitted);
  if (!ops.length) return { state: "no-change", base, submitted, ops };
  let latest = base;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const applied = applyRosterOps(latest.roster, ops);
    /* everything left was already there or lost to an earlier change: nothing to write */
    if (latest !== base && same(applied.roster, latest.roster)) {
      return {
        state: "saved", base: latest, submitted, ops, roster: latest.roster, merged: true,
        conflicts: applied.conflicts, dropped: applied.dropped, attempts: attempt - 1,
      };
    }
    let res;
    try { res = await write(applied.roster, latest.revision); }
    catch { return { state: "offline", base, submitted, ops }; }
    if (res && res.ok) {
      return {
        state: "saved", base: { roster: applied.roster, revision: res.revision }, submitted, ops,
        roster: applied.roster, merged: latest !== base, conflicts: applied.conflicts, dropped: applied.dropped, attempts: attempt,
      };
    }
    if (res && res.conflict) { latest = { roster: normalizeRoster(res.payload), revision: Number(res.revision) || 0 }; continue; }
    return { state: "failed", base, submitted, ops };
  }
  return { state: "conflict-retries-exhausted", base, submitted, ops };
}

/* After a save that took in other devices' changes, the screen moves onto the stored
   result. Anything edited here while the save was in flight is replayed on top, and
   blank rows being filled in stay where they are. */
export function rebaseRoster(result, submitted, now) {
  const blanks = (Array.isArray(now) ? now : []).filter((e) => !String(e.id || "").trim() && !String(e.name || "").trim());
  return [...applyRosterOps(result, diffRoster(submitted, normalizeRoster(now))).roster, ...blanks];
}

/* The profile table mirrors ID, name and role. Only employees this save actually added,
   renamed, re-roled or removed are touched there — never "delete everyone not in my
   copy", which a stale copy would turn into deleting other devices' new employees. */
export function profileChanges(ops, roster) {
  const byId = new Map(roster.filter((e) => e.id).map((e) => [e.id, e]));
  const upsert = new Set(), remove = new Set();
  ops.forEach((o) => {
    if (o.op === "add" || o.op === "rename" || (o.op === "update" && (o.fields.includes("name") || o.fields.includes("role")))) {
      if (o.id) upsert.add(o.id);
    }
    if (o.op === "remove" && o.id) remove.add(o.id);
    if (o.op === "rename" && o.fromId) remove.add(o.fromId);
  });
  return {
    upsert: [...upsert].filter((id) => byId.has(id))
      .map((id) => ({ employee_id: id, name: byId.get(id).name, role: byId.get(id).role })),
    remove: [...remove].filter((id) => !byId.has(id)),
  };
}
