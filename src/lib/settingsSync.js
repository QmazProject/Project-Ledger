/* Merging the shared DTR settings (`dtr:cfg`).

   Settings are one stored object shared by every admin. A save sends only what this
   device changed since the copy it loaded (its base), applied to the latest stored
   settings under the revision check (mergeSave.js), with the same three-way rule as
   the roster and DTR rows: a setting changed on one side only takes that side's value;
   the same setting changed differently on both sides keeps the stored value (the
   first accepted change) and reports it.

   Settings that move as one value:
   - the morning pair (AM start, AM end) and the afternoon pair (PM start, PM end).
     Each pair is one working block; mixing one admin's start with another's end can
     describe a block that never happened. AM start is also the overnight-OT cutoff.
   - after a merge the whole day must still run AM start < AM end <= PM start < PM end;
     if two admins' changes to different pairs would break that, the stored schedule is
     kept and reported, since regular-hour credit and the OT cutoff both read it.
   Company name, department, form title and logo are each their own setting. Any other
   stored key (including ones this version no longer uses) is carried through untouched
   unless this device changed it. Payroll cut-offs are fixed dates, not settings. */

import { saveMerged, queuedBase } from "./mergeSave.js";
import { toMin, disp } from "./dtrTime.js";

const SCHED_PAIRS = { "sched.am": ["amStart", "amEnd"], "sched.pm": ["pmStart", "pmEnd"] };
const LABELS = {
  co: "Company name", dept: "Department", title: "Form title", logo: "Logo",
  amStart: "AM start", amEnd: "AM end", pmStart: "PM start", pmEnd: "PM end",
};

const canon = (v) => JSON.stringify(v === undefined ? null : v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* The settings every screen reads: stored values over the defaults, exactly as the app
   has always built them on load. */
export const normalizeSettings = (stored, defaults) =>
  Object.assign({}, defaults || {}, stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {});

function groupsOf(...settings) {
  const keys = new Set();
  settings.forEach((s) => Object.keys(s || {}).forEach((k) => { if (k !== "sched") keys.add(k); }));
  return [...[...keys].sort(), ...Object.keys(SCHED_PAIRS)];
}

function groupValue(s, group) {
  if (SCHED_PAIRS[group]) {
    const sched = (s && s.sched) || {};
    return Object.fromEntries(SCHED_PAIRS[group].map((f) => [f, sched[f] ?? null]));
  }
  return s && group in s ? s[group] : null;
}

function setGroup(s, group, value) {
  if (SCHED_PAIRS[group]) { s.sched = { ...(s.sched || {}), ...value }; return; }
  if (value === null) delete s[group]; else s[group] = clone(value);
}

export function scheduleIssue(sched) {
  if (!sched) return null;
  const t = ["amStart", "amEnd", "pmStart", "pmEnd"].map((k) => toMin(sched[k]));
  if (t.some((v) => v === null || Number.isNaN(v))) return null;
  return t[0] < t[1] && t[1] <= t[2] && t[2] < t[3] ? null : "the work schedule no longer runs in order";
}

export function diffSettings(base, local) {
  return groupsOf(base, local)
    .map((group) => ({ group, from: groupValue(base, group), to: groupValue(local, group) }))
    .filter((o) => canon(o.from) !== canon(o.to));
}

export function applySettingsOps(remote, ops) {
  const value = clone(remote) || {};
  const conflicts = [];
  let schedTouched = false;
  ops.forEach((o) => {
    const cur = groupValue(remote, o.group);
    if (canon(cur) === canon(o.to)) return;
    if (canon(cur) !== canon(o.from)) { conflicts.push({ group: o.group, kept: cur, wanted: o.to }); return; }
    setGroup(value, o.group, o.to);
    if (SCHED_PAIRS[o.group]) schedTouched = true;
  });
  if (schedTouched && scheduleIssue(value.sched) && !scheduleIssue(remote && remote.sched)) {
    value.sched = clone(remote && remote.sched);
    ops.filter((o) => SCHED_PAIRS[o.group]).forEach((o) => {
      if (!conflicts.some((c) => c.group === o.group)) conflicts.push({ group: o.group, kept: groupValue(remote, o.group), wanted: o.to });
    });
  }
  return { value, conflicts };
}

export async function saveSettingsChanges(base, local, write, { defaults, maxAttempts } = {}) {
  const submitted = normalizeSettings(local, defaults);
  const ops = diffSettings(base.value, submitted);
  if (!ops.length) return { state: "no-change", base, submitted, ops };
  const res = await saveMerged({
    base, write, maxAttempts,
    apply: (latest) => applySettingsOps(normalizeSettings(latest, defaults), ops),
    same: (a, b) => canon(a) === canon(b),
  });
  return { ...res, submitted, ops };
}

/* Settings queued on the device while offline, with the base stored beside them.
   Without a base they are set aside — nothing is written. */
export async function mergeQueuedSettings(local, kept, write, opts = {}) {
  const base = queuedBase(kept);
  if (!base) return { state: "set-aside", ops: [] };
  return saveSettingsChanges({ value: normalizeSettings(base.value, opts.defaults), revision: base.revision }, local, write, opts);
}

/* After a save that took in another admin's changes, the screen moves onto the stored
   settings, with anything edited here while the save was in flight replayed on top. */
export function rebaseSettings(result, submitted, now) {
  return applySettingsOps(result, diffSettings(submitted, now)).value;
}

export function describeSettingsConflicts(conflicts) {
  if (!conflicts || !conflicts.length) return "";
  const parts = conflicts.map((c) => {
    if (SCHED_PAIRS[c.group]) {
      const f = SCHED_PAIRS[c.group].find((k) => canon(c.kept && c.kept[k]) !== canon(c.wanted && c.wanted[k]))
        || SCHED_PAIRS[c.group][0];
      return { label: LABELS[f], shown: c.kept && c.kept[f] ? disp(c.kept[f], true) : "" };
    }
    const shown = typeof c.kept === "string" && c.group !== "logo" ? c.kept : "";
    return { label: LABELS[c.group] || c.group, shown };
  });
  if (parts.length === 1) {
    const p = parts[0];
    return `${p.label} was changed on another device first. `
      + `${p.shown ? `The saved value ${p.shown} was kept.` : "The saved value was kept."} Review it before changing again.`;
  }
  return `${parts.map((p) => p.label).join(", ")} were changed on another device first. `
    + "The saved values were kept. Review them before changing again.";
}
