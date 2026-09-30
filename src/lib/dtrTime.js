/* Punch slots, time parsing and the ordering rules the DTR applies to them.

   Overtime that runs past midnight belongs to the duty date it started on:
   Monday OT in 6:00 PM, OT out 12:00 AM is Monday's record, six hours of
   overtime, and nothing is written to Tuesday. The stored otOut stays a plain
   "00:00" — an OT out earlier than its OT in is what says "next day", so no
   extra field has to be kept in step with it. That reading is allowed only up
   to the next scheduled AM start; past that it is a mistake, not overtime. */

export const SLOTS = [
  { k: "amIn",  label: "AM in",  btn: "Time in",              sub: "Start of the morning",  mer: "AM" },
  { k: "amOut", label: "AM out", btn: "Time out for lunch",   sub: "Break at noon",         mer: "AM" },
  { k: "pmIn",  label: "PM in",  btn: "Time in from lunch",   sub: "Back before 1:00 PM",   mer: "PM" },
  { k: "pmOut", label: "PM out", btn: "Time out for the day", sub: "End of regular hours",  mer: "PM" },
  { k: "otIn",  label: "OT in",  btn: "Start overtime",       sub: "Overtime, regular day", mer: "PM" },
  { k: "otOut", label: "OT out", btn: "End overtime",         sub: "Close out overtime",    mer: "PM" },
];

const DAY = 24 * 60;
/* the default schedule's AM start, for a caller that has no schedule to hand */
const AM_START_DEFAULT = "08:00";
const p2 = (n) => String(n).padStart(2, "0");

export const toMin = (hm) => { if (!hm) return null; const a = hm.split(":").map(Number); return a[0] * 60 + a[1]; };

export function disp(hm, withMer) {
  if (!hm) return "";
  const a = hm.split(":").map(Number);
  const mer = a[0] >= 12 ? "PM" : "AM";
  let hh = a[0] % 12; if (hh === 0) hh = 12;
  return `${hh}:${p2(a[1])}${withMer ? " " + mer : ""}`;
}

/* Typed times only. `otIn` is the day's OT in, passed by the typed-entry paths so
   a bare 12 in OT out can mean the midnight that ends an evening's overtime. */
export function parseTime(txt, merHint, slotKey, otIn) {
  if (!txt) return "";
  const t = txt.trim().toUpperCase();
  const m = t.match(/^(\d{1,2})[:.\s]?(\d{2})?\s*(AM|PM|A|P)?$/);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  /* After a PM OT in, nobody's overtime ends at noon: a bare 12 (or 12:MM) in
     OT out is midnight. An explicit "12:00 PM" is still read as written. */
  if (!m[3] && slotKey === "otOut" && h === 12 && otIn && toMin(otIn) >= 12 * 60) return `00:${p2(mi)}`;
  /* Explicit AM/PM suffixes always win. A bare 12 in the AM-out field means
     noon in normal timesheet shorthand. Otherwise the row's meridian hint
     covers hours 1-11 whether or not a colon was typed, so "5:06" in a PM row
     is 17:06 and not five in the morning; 0, 12 and 13-23 are already
     unambiguous and are read as written. The wheel picker and the type=time
     input send 24-hour values and pass no hint, so they come through unchanged. */
  const mer = m[3]
    ? (m[3][0] === "A" ? "AM" : "PM")
    : slotKey === "amOut" && h === 12 && !t.includes(":")
      ? "PM"
    : t.includes(":")
      ? (h >= 1 && h <= 11 ? merHint : null)
      : h <= 12 ? merHint : null;
  if (mer === "PM" && h < 12) h += 12;
  if (mer === "AM" && h === 12) h = 0;
  return `${p2(h)}:${p2(mi)}`;
}

/* ---- overnight overtime ---- */

/* an OT out earlier than its OT in ended the next morning */
export const otOutIsNextDay = (otIn, otOut) => !!otIn && !!otOut && toMin(otOut) < toMin(otIn);

/* OT out in minutes from the start of the duty date, so 00:00 after 18:00 is 1440 */
export const otEndMinutes = (otIn, otOut) =>
  (!otOut ? null : toMin(otOut) + (otOutIsNextDay(otIn, otOut) ? DAY : 0));

export const otMinutes = (r) =>
  (r.otIn && r.otOut ? Math.max(0, otEndMinutes(r.otIn, r.otOut) - toMin(r.otIn)) : 0);

/* the cutoff is inclusive: OT out exactly at the next AM start is still overtime */
export const otOutPastCutoff = (otIn, otOut, amStart = AM_START_DEFAULT) =>
  otOutIsNextDay(otIn, otOut) && toMin(otOut) > toMin(amStart || AM_START_DEFAULT);

export const otCutoffMessage = (amStart = AM_START_DEFAULT) =>
  `OT out can't be later than the next scheduled AM start at ${disp(amStart || AM_START_DEFAULT, true)}.`;

/* "2027-01-01" -> "2026-12-31", computed on the calendar, never on UTC */
export function previousIsoDate(ds) {
  const [y, mo, d] = ds.split("-").map(Number);
  const prev = new Date(y, mo - 1, d - 1);
  return `${prev.getFullYear()}-${p2(prev.getMonth() + 1)}-${p2(prev.getDate())}`;
}

/* Yesterday's overtime is still open when it has an OT in, no OT out, and it is
   not yet past the next AM start. `now` must also be earlier in the day than
   the OT in, or ending it now could not be the next-morning reading. Returns
   yesterday's date, or null. */
export function openOvernightOtDate(todayIso, recOf, nowHm, amStart = AM_START_DEFAULT) {
  const prevIso = previousIsoDate(todayIso);
  const prev = recOf(prevIso) || {};
  if (prev.leave || prev.holiday || !prev.otIn || prev.otOut) return null;
  const now = toMin(nowHm);
  if (now > toMin(amStart || AM_START_DEFAULT) || now >= toMin(prev.otIn)) return null;
  return prevIso;
}

/* Where the punch screen opens: yesterday while its overtime is still open (so the
   live punch ends it there, never as today's AM in), otherwise today. `loadYear(y)`
   must read that year from storage and resolve to its records — on Jan 1 yesterday
   is last year's, so that year is read before it is looked at. */
export async function landingPunchDate(todayIso, nowHm, amStart, loadYear) {
  const prevIso = previousIsoDate(todayIso);
  const years = { [todayIso.slice(0, 4)]: await loadYear(+todayIso.slice(0, 4)) };
  if (prevIso.slice(0, 4) !== todayIso.slice(0, 4)) years[prevIso.slice(0, 4)] = await loadYear(+prevIso.slice(0, 4));
  return openOvernightOtDate(todayIso, (ds) => (years[ds.slice(0, 4)] || {})[ds], nowHm, amStart) || todayIso;
}

/* the slot the live punch button records: the open overtime's end, or the first empty one */
export const nextPunchSlot = (rec, closingOvernightOt) =>
  (closingOvernightOt ? SLOTS.find((s) => s.k === "otOut") : SLOTS.find((s) => !rec[s.k]));

/* ---- payroll periods ---- */

/* payroll periods run 28 -> 12 and 13 -> 27 */
export function periodOf(d) {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  if (day >= 28) return { s: new Date(y, m, 28), e: new Date(y, m + 1, 12) };
  if (day <= 12) return { s: new Date(y, m - 1, 28), e: new Date(y, m, 12) };
  return { s: new Date(y, m, 13), e: new Date(y, m, 27) };
}

/* a day counts as filled in when it has a punch, a leave or holiday mark, or an accomplishment */
export const dayHasEntries = (r) =>
  !!r && (!!r.leave || !!r.holiday || SLOTS.some((s) => r[s.k]) || !!(r.note && String(r.note).trim()));

/* Start dates ("YYYY-MM-DD") of the payroll periods holding at least one filled-in day,
   from whole-year payloads. A Dec 28 -> Jan 12 period is found from either year's row. */
export function periodStartsWithEntries(yearPayloads) {
  const out = new Set();
  yearPayloads.forEach((payload) => {
    Object.entries(payload || {}).forEach(([ds, r]) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ds);
      if (!m || !dayHasEntries(r)) return;
      const s = periodOf(new Date(+m[1], +m[2] - 1, +m[3])).s;
      out.add(`${s.getFullYear()}-${p2(s.getMonth() + 1)}-${p2(s.getDate())}`);
    });
  });
  return out;
}

/* ---- ordering ---- */

/* A punch can't fall before the last one recorded or after the next one. The one
   exception is the OT pair, which may cross midnight up to the next AM start. */
export function orderIssue(r, key, t, amStart = AM_START_DEFAULT) {
  const i = SLOTS.findIndex((s) => s.k === key);
  if (i < 0 || !t) return null;
  for (let j = i - 1; j >= 0; j--) {
    if (r[SLOTS[j].k]) {
      if (key === "otOut" && SLOTS[j].k === "otIn")
        return otOutPastCutoff(r.otIn, t, amStart) ? otCutoffMessage(amStart) : null;
      if (toMin(t) < toMin(r[SLOTS[j].k]))
        return `${SLOTS[i].label} can't be earlier than ${SLOTS[j].label} (${disp(r[SLOTS[j].k], true)})`;
      break;
    }
  }
  for (let j = i + 1; j < SLOTS.length; j++) {
    if (r[SLOTS[j].k]) {
      const later = key === "otIn" && SLOTS[j].k === "otOut"
        ? otOutPastCutoff(t, r.otOut, amStart)
        : toMin(t) > toMin(r[SLOTS[j].k]);
      if (later)
        return `${SLOTS[i].label} can't be later than ${SLOTS[j].label} (${disp(r[SLOTS[j].k], true)})`;
      break;
    }
  }
  return null;
}

/* Validate every filled punch after a proposed edit. Checking only the edited
   value against the current neighbors can trap a user in an already-invalid
   day: correcting AM in is blocked because the old AM out is still earlier.
   An edited OT slot is checked first, so an OT out past the cutoff is reported
   as that, not as the OT in that happens to come before it. */
export function recordOrderIssue(r, amStart = AM_START_DEFAULT, editedKey) {
  if (editedKey === "otIn" || editedKey === "otOut") {
    const own = orderIssue(r, editedKey, r[editedKey], amStart);
    if (own) return own;
  }
  for (const slot of SLOTS) {
    const issue = orderIssue(r, slot.k, r[slot.k], amStart);
    if (issue) return issue;
  }
  return null;
}
