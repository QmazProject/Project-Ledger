/* Merging a DTR year row that was edited offline.

   A year row holds every date of an employee-year. A device that was offline sends
   nothing like "my copy of the year": it works out, date by date and field by field,
   what it changed since the copy it was editing (its base), and applies only that to
   the latest stored year under the revision check (see mergeSave.js).

   Three-way rule for each field of each date — base, this device, latest stored:
   - only the stored copy changed           -> keep the stored value;
   - only this device changed               -> apply this device's value;
   - both changed it to the same value      -> fine;
   - both changed it differently            -> conflict: the stored value (the first
     accepted change) is kept and reported; this device's value is not written.
   Clearing a field is a change like any other (base had a value, this device has
   none), so an offline clear never erases a value another device set since.

   Groups that move as one:
   - a punch and its source mark (clock-stamped / typed / edited) are one field;
   - a day's status: marking leave or a holiday clears the punches, so when either side
     changes a day's status the whole day is one value — a merge can never produce a
     leave day that still carries punches.
   Calculated totals (dayMinutes, otMinutes, dayCredit, totalsAt) are never merged; the
   caller recalculates them on every day the merge changes. A merged day whose times
   no longer fit together (the ordering and overnight-OT rules) keeps the stored day.

   Each year row is merged on its own. A duty record belongs to its own date's row —
   an overnight OT that ended on Jan 1 is on Dec 31's record — so nothing moves rows. */

import { SLOTS } from "./dtrTime.js";
import { saveMerged, queuedBase } from "./mergeSave.js";

export const CALCULATED_FIELDS = ["dayMinutes", "otMinutes", "dayCredit", "totalsAt"];
const SLOT_KEYS = SLOTS.map((s) => s.k);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* What a person entered on a day: totals left out, and empty values (a blank note, an
   unset source mark, a false flag) treated the same as absent. Keys sorted, so two
   equal days compare equal as text. */
export function dayContent(day) {
  const out = {};
  if (!day || typeof day !== "object") return out;
  Object.keys(day).sort().forEach((k) => {
    if (CALCULATED_FIELDS.includes(k)) return;
    const v = day[k];
    if (k === "src") {
      if (v && typeof v === "object") {
        const src = {};
        Object.keys(v).sort().forEach((sk) => { if (v[sk]) src[sk] = v[sk]; });
        if (Object.keys(src).length) out.src = src;
      }
      return;
    }
    if (v === undefined || v === null || v === false) return;
    if (typeof v === "string" && !v.trim()) return;
    out[k] = v;
  });
  return out;
}

const canon = (v) => JSON.stringify(v === undefined ? null : v);
const status = (c) => (c.leave ? "leave" : c.holiday ? "holiday" : "");

function groupsOf(...contents) {
  const fields = new Set();
  contents.forEach((c) => Object.keys(c).forEach((k) => {
    if (k !== "src" && k !== "leave" && k !== "holiday" && !SLOT_KEYS.includes(k)) fields.add(k);
  }));
  return [...SLOT_KEYS.map((k) => `slot:${k}`), ...[...fields].sort().map((f) => `field:${f}`)];
}

function groupValue(c, group) {
  if (group.startsWith("slot:")) {
    const k = group.slice(5);
    return { v: c[k] ?? null, src: (c.src && c.src[k]) || null };
  }
  return c[group.slice(6)] ?? null;
}

function setGroup(day, group, value) {
  if (group.startsWith("slot:")) {
    const k = group.slice(5);
    if (value.v) day[k] = value.v; else delete day[k];
    if (value.src) day.src = { ...(day.src || {}), [k]: value.src };
    else if (day.src) delete day.src[k];
    return;
  }
  const f = group.slice(6);
  if (value === null) delete day[f]; else day[f] = value;
}

/* What `local` changed relative to `base`, as date -> field operations. */
export function diffYear(base, local) {
  const ops = [];
  const dates = new Set([...Object.keys(base || {}), ...Object.keys(local || {})]);
  [...dates].filter((d) => DATE.test(d)).sort().forEach((date) => {
    const b = dayContent(base && base[date]), l = dayContent(local && local[date]);
    if (canon(b) === canon(l)) return;
    if (status(b) !== status(l)) { ops.push({ date, group: "day", from: b, to: l, baseStatus: status(b) }); return; }
    groupsOf(b, l).forEach((group) => {
      const from = groupValue(b, group), to = groupValue(l, group);
      if (canon(from) !== canon(to)) ops.push({ date, group, from, to, baseStatus: status(b) });
    });
  });
  return ops;
}

/* Apply one device's changes to the latest stored year. */
export function applyYearOps(remote, ops, { validateDay, finalizeDay } = {}) {
  const value = { ...(remote && typeof remote === "object" && !Array.isArray(remote) ? remote : {}) };
  const conflicts = [];
  const byDate = new Map();
  ops.forEach((o) => { if (!byDate.has(o.date)) byDate.set(o.date, []); byDate.get(o.date).push(o); });
  byDate.forEach((dayOps, date) => {
    const stored = value[date];
    const r = dayContent(stored);
    let day = stored && typeof stored === "object" ? JSON.parse(JSON.stringify(stored)) : {};
    let changed = false;
    const lost = [];
    dayOps.forEach((o) => {
      if (o.group === "day") {
        if (canon(r) === canon(o.from)) { day = JSON.parse(JSON.stringify(o.to)); changed = true; }
        else if (canon(r) !== canon(o.to)) lost.push({ date, group: "day", kept: r, wanted: o.to });
        return;
      }
      const cur = groupValue(r, o.group);
      if (canon(cur) === canon(o.to)) return;
      /* the stored day was marked leave/holiday (or unmarked) meanwhile: that change owns the day */
      if (status(r) !== o.baseStatus || canon(cur) !== canon(o.from)) { lost.push({ date, group: o.group, kept: cur, wanted: o.to }); return; }
      setGroup(day, o.group, o.to);
      changed = true;
    });
    conflicts.push(...lost);
    if (!changed) return;
    const issue = validateDay ? validateDay(day) : null;
    if (issue && !(validateDay(stored || {}))) {
      conflicts.push({ date, group: "times", kept: r, wanted: dayContent(day), issue });
      return;
    }
    if (finalizeDay) finalizeDay(day);
    value[date] = day;
  });
  return { value, conflicts };
}

export function sameYearContent(a, b) {
  const dates = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const d of dates) if (canon(dayContent(a && a[d])) !== canon(dayContent(b && b[d]))) return false;
  return true;
}

/* One offline year: diff against its base, merge into the latest stored year, save. */
export async function saveYearChanges(base, local, write, opts = {}) {
  const ops = diffYear(base.value, local);
  if (!ops.length) return { state: "no-change", base, ops };
  const res = await saveMerged({
    base, write, maxAttempts: opts.maxAttempts,
    apply: (latest) => applyYearOps(latest, ops, opts),
    same: sameYearContent,
  });
  return { ...res, ops };
}

/* A year queued on the device while offline: `kept` is the base stored beside it.
   Without a base it is set aside — nothing is written. */
export async function mergeQueuedYear(local, kept, write, opts = {}) {
  const base = queuedBase(kept);
  if (!base) return { state: "set-aside", ops: [] };
  return saveYearChanges(base, local, write, opts);
}

/* ---- telling the person what was not applied ---- */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
function fieldLabel(group) {
  if (group === "day") return "leave/holiday mark";
  if (group === "times") return "times";
  if (group.startsWith("slot:")) {
    const slot = SLOTS.find((s) => s.k === group.slice(5));
    return slot ? titleCase(slot.label) : group.slice(5);
  }
  const f = group.slice(6);
  return f === "note" ? "accomplishment" : f;
}
const when = (date) => { const [, m, d] = date.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };

export function describeYearConflicts(conflicts) {
  if (!conflicts || !conflicts.length) return "";
  const what = (c) => `${when(c.date)} ${fieldLabel(c.group)}`;
  if (conflicts.length === 1) {
    return `${what(conflicts[0])} was changed on another device while you were offline. `
      + "The saved value was kept. Please review it before editing again.";
  }
  const shown = conflicts.slice(0, 3).map(what).join(", ");
  return `${conflicts.length} offline changes were not applied because they were changed on another device `
    + `(${shown}${conflicts.length > 3 ? ", …" : ""}). The saved values were kept. Please review them before editing again.`;
}
