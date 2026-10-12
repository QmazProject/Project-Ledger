/* Biometric attendance logs (ZKTeco), read in the browser and set beside the DTR.

   The device export is one tap per line — ID, date and time, then four codes:
     6571  8/28/2026 7:51   1  0  1  0
   The second code says what the tap was: 0 in, 1 out, 2 break out, 3 break in,
   4 overtime in, 5 overtime out. A file holds every employee the device knows;
   only the signed-in employee's taps are ever kept, and the file itself is never
   stored. The roster says 006571 where the device says 6571, so IDs are compared
   without leading zeros.

   Nothing here writes a DTR record. Taps are placed into the six DTR boxes as a
   suggestion; the employee decides, day by day or box by box, what to take. */

import { SLOTS, toMin, disp, recordOrderIssue, pmOutNeedsAccomplishment } from "./dtrTime.js";

export const BIO_MAX_BYTES = 10 * 1024 * 1024;
/* a second tap of the same kind this soon after the first is the same tap, retried */
export const DOUBLE_TAP_MINUTES = 5;

const p2 = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SLOT_KEYS = SLOTS.map((s) => s.k);
const SLOT_LABEL = Object.fromEntries(SLOTS.map((s) => [s.k, s.label]));

const KIND_BY_CODE = { 0: "in", 1: "out", 2: "out", 3: "in", 4: "otIn", 5: "otOut" };
/* exports from the device's PC software spell the state out instead */
const KIND_BY_WORD = [
  [/^(over\s*time|ot)[\s/_-]*in$/i, "otIn"],
  [/^(over\s*time|ot)[\s/_-]*out$/i, "otOut"],
  [/^break[\s/_-]*out$/i, "out"],
  [/^break[\s/_-]*in$/i, "in"],
  [/^(c[\s/_-]*in|check[\s/_-]*in|in|i)$/i, "in"],
  [/^(c[\s/_-]*out|check[\s/_-]*out|out|o)$/i, "out"],
];
const KIND_LABEL = { in: "In", out: "Out", otIn: "OT in", otOut: "OT out" };

/* ---- dates, as "YYYY-MM-DD" strings on the calendar, never through UTC ---- */

export function addDaysIso(ds, n) {
  const [y, m, d] = ds.split("-").map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
}
export function datesBetween(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDaysIso(d, 1)) out.push(d);
  return out;
}
export const shortDate = (ds) => { const [, m, d] = ds.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };
const rangeLabel = (a, b) => (a === b ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`);

/* ---- IDs ---- */

/* "006571" and "6571" are one employee; an ID with letters is compared as written */
export const normalizeBioId = (id) => {
  const s = String(id ?? "").trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
};
/* other roster entries that would read as the same device ID */
export const bioIdClashes = (roster, employeeId) =>
  (roster || []).filter((e) => e && e.id && e.id !== employeeId && normalizeBioId(e.id) === normalizeBioId(employeeId));

/* ---- reading a file into rows ---- */

/* Text exports: the device's .dat is tab-separated; a .csv uses commas. Each row
   keeps its original line, which is what a download hands back. */
export function rowsFromText(text) {
  return String(text || "").replace(/^﻿/, "").split(/\r\n|\r|\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const cells = line.includes("\t") ? line.split("\t")
        : line.includes(",") ? line.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1"))
        : line.trim().split(/\s+/);
      return { cells, raw: line };
    });
}

/* Excel: every sheet, whatever it is called. Cells are taken as text, so one reader
   serves text and Excel — but a real Excel date is rewritten from its stored value
   first, as month/day/year 24-hour, because its display format may drop the time.
   The xlsx module is passed in: the DTR loads it only when an Excel file is chosen. */
export function rowsFromWorkbook(XLSX, data) {
  const wb = XLSX.read(data, { type: "array", cellNF: true });
  const date1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
  const rows = [];
  wb.SheetNames.forEach((name) => {
    const ws = wb.Sheets[name];
    Object.keys(ws).forEach((addr) => {
      const cell = ws[addr];
      if (addr[0] === "!" || !cell || cell.t !== "n" || !isDateFormat(cell.z)) return;
      cell.w = excelDateText(cell.v, cell.z, date1904);
    });
    XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, blankrows: false, defval: "" })
      .forEach((cells) => {
        const c = cells.map((x) => String(x ?? "").trim());
        if (c.some(Boolean)) rows.push({ cells: c, raw: c.join("\t") });
      });
  });
  return rows;
}

/* an Excel number format that shows a date or a time ("m/d/yy", "h:mm", ...) */
function isDateFormat(z) {
  if (!z || typeof z !== "string" || /^general$/i.test(z)) return false;
  return /[dmyhs]/i.test(z.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
}
/* An Excel date value is days since 30 Dec 1899 (1 Jan 1904 in the Mac system), the
   fraction being the time of day. Rounded to the minute, which is all a tap has. */
function excelDateText(v, z, date1904) {
  const total = Math.round(v * 1440);
  const mins = ((total % 1440) + 1440) % 1440;
  const clock = `${Math.floor(mins / 60)}:${p2(mins % 60)}`;
  if (v < 1) return clock;
  const t = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) + Math.floor(total / 1440) * 86400000);
  const day = `${t.getUTCMonth() + 1}/${t.getUTCDate()}/${t.getUTCFullYear()}`;
  return Number.isInteger(v) && !/[hs]/i.test(z) ? day : `${day} ${clock}`;
}

const DATE_RE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T]+(.+))?$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP])?\.?M?\.?$/i;

function parseClock(s) {
  const m = TIME_RE.exec(String(s || "").trim());
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  if (mi > 59) return null;
  const ap = m[4] && m[4].toUpperCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "P" && h < 12) h += 12;
    if (ap === "A" && h === 12) h = 0;
  }
  return h > 23 ? null : `${p2(h)}:${p2(mi)}`;
}

/* one row -> its parts, or null when it is not a tap (a header, a title, a blank) */
function scanRow(cells) {
  const c = cells.map((x) => String(x ?? "").trim());
  for (let i = 0; i < c.length; i++) {
    const dm = DATE_RE.exec(c[i]);
    if (!dm) continue;
    /* the time rides with the date, or follows it — with its AM/PM in a cell of its own */
    const split = !dm[4] && /^[AP]\.?M\.?$/i.test(c[i + 2] || "");
    const time = dm[4] ? parseClock(dm[4]) : parseClock(split ? `${c[i + 1]} ${c[i + 2]}` : c[i + 1]);
    const ti = dm[4] ? i : split ? i + 2 : i + 1;
    if (!time) return null;
    /* the ID is the nearest all-digits cell before the date: a name or a row number may sit further left */
    let id = "";
    for (let j = i - 1; j >= 0; j--) if (/^\d+$/.test(c[j])) { id = c[j]; break; }
    if (!id) return null;
    const after = c.slice(ti + 1).filter(Boolean);
    const word = after.find((x) => !/^\d+$/.test(x) && KIND_BY_WORD.some(([re]) => re.test(x)));
    let kind = null, code = "";
    if (word) { kind = KIND_BY_WORD.find(([re]) => re.test(word))[1]; code = word; }
    else {
      /* the device layout: verify, state, work code, reserved — the state is the second */
      const nums = after.filter((x) => /^\d+$/.test(x));
      const pick = nums.length >= 2 ? nums[1] : nums[0];
      if (pick !== undefined && KIND_BY_CODE[+pick] !== undefined) { kind = KIND_BY_CODE[+pick]; code = pick; }
    }
    if (!kind) return null;
    return { id, date: [dm[1], dm[2], dm[3]], time, kind, code };
  }
  return null;
}

const validDate = (y, m, d) => {
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
};

/* Every row that is a tap, with its date settled. The device writes month/day; a file
   whose dates only make sense as day/month is read that way, and one that mixes the
   two is refused rather than half-read. */
export function readBioRows(rows) {
  const scanned = [];
  let skipped = 0, dayFirst = false, monthFirst = false;
  (rows || []).forEach((row) => {
    const s = scanRow(row.cells || []);
    if (!s) { skipped++; return; }
    if (s.date[0].length !== 4) {
      if (+s.date[0] > 12) dayFirst = true;
      if (+s.date[1] > 12) monthFirst = true;
    }
    scanned.push({ ...s, raw: row.raw });
  });
  if (dayFirst && monthFirst) return { taps: [], skipped, error: "mixed-dates" };
  const taps = [];
  scanned.forEach((s) => {
    const [a, b, c] = s.date.map(Number);
    let y, m, d;
    if (s.date[0].length === 4) { y = a; m = b; d = c; }
    else { y = c < 100 ? 2000 + c : c; [m, d] = dayFirst ? [b, a] : [a, b]; }
    if (!validDate(y, m, d)) { skipped++; return; }
    taps.push({
      id: normalizeBioId(s.id), rawId: s.id, date: `${y}-${p2(m)}-${p2(d)}`,
      time: s.time, kind: s.kind, code: s.code, raw: s.raw,
    });
  });
  return { taps, skipped, dateOrder: dayFirst ? "day-first" : "month-first", error: taps.length ? "" : "not-bio" };
}

export const tapsForEmployee = (taps, employeeId) => {
  const id = normalizeBioId(employeeId);
  return (taps || []).filter((t) => t.id === id);
};

export function fileRange(taps) {
  if (!taps || !taps.length) return null;
  let first = taps[0].date, last = taps[0].date;
  taps.forEach((t) => { if (t.date < first) first = t.date; if (t.date > last) last = t.date; });
  return { first, last };
}

/* device serial from the export's name: A3B7233860061_attlogs.dat */
export const deviceSerialOf = (fileName) => {
  const m = /^([A-Za-z0-9]{8,})_attlog/i.exec(String(fileName || ""));
  return m ? m[1] : "";
};

/* ---- placing taps in the DTR's six boxes ---- */

const tapText = (t) => `${disp(t.time, true)}`;

/* The taps of one duty date, in time order, into AM in .. OT out. */
function placeDay(list, sched) {
  const noon = toMin(sched.amEnd), pmStart = toMin(sched.pmStart), pmEnd = toMin(sched.pmEnd);
  const slots = {}, notes = [];
  let last = null;
  list.forEach(({ t, m, moved }) => {
    let k;
    if (last && last.kind === t.kind && m - last.m <= DOUBLE_TAP_MINUTES) k = last.k;
    else if (t.kind === "otIn") k = "otIn";
    else if (t.kind === "otOut") k = "otOut";
    else if (t.kind === "in") k = slots.pmOut || m >= pmEnd ? "otIn" : (slots.amOut || m >= noon ? "pmIn" : "amIn");
    else k = moved || slots.pmOut || slots.otIn ? "otOut" : (m >= pmStart ? "pmOut" : "amOut");

    const doubled = last && last.k === k && last.kind === t.kind && m - last.m <= DOUBLE_TAP_MINUTES;
    if (slots[k] && !doubled) {
      notes.push(`extra tap ${tapText(t)} (${KIND_LABEL[t.kind]})`);
      return;
    }
    if (doubled) notes.push(`double tap ${disp(slots[k], true)} / ${tapText(t)}`);
    else if (t.kind === "out" && k === "otOut") notes.push(`tapped Out at ${tapText(t)}, used as OT out`);
    if (moved && !doubled) notes.push(`${SLOT_LABEL[k]} tapped after midnight (${shortDate(t.date)}, ${tapText(t)})`);
    slots[k] = t.time;
    last = { k, m, kind: t.kind };
  });
  if (slots.otOut && !slots.otIn) notes.push("No OT in on the bio log. Type your OT in yourself.");
  return { slots, notes, taps: list.map((x) => x.t) };
}

/* One employee's taps -> the period's days. `period` is { start, end } as ISO dates.
   An Out or OT out between midnight and the AM start, with no In before it that
   morning, closes the previous day — the same overnight rule the DTR applies — and
   always lands as OT out, since only overtime runs past midnight. */
export function placeTaps(taps, sched, period) {
  const amStart = toMin(sched.amStart);
  /* the same minute twice is one tap; an OT tap beats a plain one at that minute */
  const byMinute = new Map();
  (taps || []).forEach((t) => {
    const key = `${t.date} ${t.time}`;
    if (!byMinute.has(key)) byMinute.set(key, new Map());
    const kinds = byMinute.get(key);
    if (!kinds.has(t.kind)) kinds.set(t.kind, t);
  });
  const kept = [];
  byMinute.forEach((kinds) => {
    if (kinds.has("otOut")) kinds.delete("out");
    if (kinds.has("otIn")) kinds.delete("in");
    kinds.forEach((t) => kept.push(t));
  });

  const duty = new Map();
  kept.forEach((t) => {
    let date = t.date, m = toMin(t.time), moved = false;
    const outish = t.kind === "out" || t.kind === "otOut";
    const inEarlier = kept.some((o) => o.date === t.date && (o.kind === "in" || o.kind === "otIn") && toMin(o.time) < m);
    if (outish && m <= amStart && !inEarlier) { date = addDaysIso(t.date, -1); m += 1440; moved = true; }
    if (!duty.has(date)) duty.set(date, []);
    duty.get(date).push({ t, m, moved });
  });

  const days = {};
  datesBetween(period.start, period.end).forEach((date) => {
    const list = (duty.get(date) || []).sort((a, b) => a.m - b.m);
    if (list.length) days[date] = placeDay(list, sched);
  });
  /* taps on the first morning that close the day before the period: not this period's */
  const beforePeriod = (duty.get(addDaysIso(period.start, -1)) || []).filter((x) => x.moved).map((x) => x.t);
  return { days, beforePeriod };
}

/* What a saved upload keeps: the employee's taps on the period's dates, and the
   morning after it, where an overnight OT out of the last day can sit. */
export function tapsToKeep(taps, period, sched) {
  const after = addDaysIso(period.end, 1), amStart = toMin(sched.amStart);
  return (taps || []).filter((t) => (t.date >= period.start && t.date <= period.end)
    || (t.date === after && (t.kind === "out" || t.kind === "otOut") && toMin(t.time) <= amStart));
}

/* ---- comparing with the DTR ---- */

/* per box: "match", "diff", "bioOnly" (DTR empty), "dtrOnly" (bio empty), or "" */
export function compareSlots(rec, bioSlots) {
  const out = {};
  SLOT_KEYS.forEach((k) => {
    const mine = (rec && rec[k]) || "", theirs = (bioSlots && bioSlots[k]) || "";
    out[k] = !mine && !theirs ? "" : mine === theirs ? "match" : !mine ? "bioOnly" : !theirs ? "dtrOnly" : "diff";
  });
  return out;
}
/* the boxes "use bio logs" would change: a different time, or one the DTR lacks */
export const replaceableSlots = (status) => SLOT_KEYS.filter((k) => status[k] === "diff" || status[k] === "bioOnly");

/* How much of the period the file reaches. `fileTaps` is every tap in the file (its
   dates are what it covers); `employeeTaps` is this employee's. */
export const bioCoverage = (fileTaps, employeeTaps, period) =>
  coverageOfRange(fileRange(fileTaps), !!(employeeTaps && employeeTaps.length), period);

/* the same, from the dates a file spans — all a saved upload keeps of the file */
export function coverageOfRange(range, hasEmployeeTaps, period) {
  if (!range) return { state: "invalid" };
  if (!hasEmployeeTaps) return { state: "no-employee", range };
  if (range.last < period.start || range.first > period.end) return { state: "none", range };
  const uncovered = datesBetween(period.start, period.end).filter((d) => d < range.first || d > range.last);
  return { state: uncovered.length ? "partial" : "full", range, uncovered };
}

export function coverageMessage(cov, period, employeeId) {
  const want = rangeLabel(period.start, period.end);
  switch (cov.state) {
    case "invalid": return "This file doesn't look like a ZKTeco bio log.";
    case "no-employee": return `No bio logs for ID ${employeeId} in this file.`;
    case "none": return `This file covers ${rangeLabel(cov.range.first, cov.range.last)}. It doesn't cover ${want}.`;
    case "partial": {
      const gaps = [];
      cov.uncovered.forEach((d) => {
        const g = gaps[gaps.length - 1];
        if (g && addDaysIso(g[1], 1) === d) g[1] = d; else gaps.push([d, d]);
      });
      return `This file covers ${rangeLabel(cov.range.first, cov.range.last)}. `
        + `${gaps.map(([a, b]) => rangeLabel(a, b)).join(", ")} ${cov.uncovered.length === 1 ? "has" : "have"} no bio logs.`;
    }
    default: return `This file covers all of ${want}.`;
  }
}

/* ---- taking bio times into a DTR day ---- */

/* Copies the chosen boxes' bio times into `day`, in place, so it can run inside a
   save that re-reads and replays on conflict. The value it replaced is kept as
   `bioWas`, unless that box already came from the bio log — then the first, typed
   value stays the one on record. Returns the boxes it changed. */
export function applyBioTimes(day, bioSlots, keys) {
  const changed = [];
  (keys || []).forEach((k) => {
    const v = bioSlots && bioSlots[k];
    if (!v || day[k] === v) return;
    const prev = day[k];
    const fromBio = day.src && day.src[k] === "bio";
    if (prev && !fromBio) day.bioWas = { ...(day.bioWas || {}), [k]: prev };
    day[k] = v;
    changed.push(k);
  });
  return changed;
}

/* Why bio times may not go into this day, or null. `typedNote` is the accomplishment
   still being typed on the punch screen for this date. */
export function bioApplyIssue(day, bioSlots, keys, sched, typedNote) {
  const d = day || {};
  if (d.leave) return "This day is marked leave. Cancel leave to use bio logs.";
  if (d.holiday) return "This day is marked holiday. Cancel holiday to use bio logs.";
  const candidate = JSON.parse(JSON.stringify(d));
  const changed = applyBioTimes(candidate, bioSlots, keys);
  if (!changed.length) return "Nothing to change on this day.";
  const order = recordOrderIssue(candidate, sched.amStart);
  if (order) return order;
  if (changed.includes("pmOut") && pmOutNeedsAccomplishment("pmOut", candidate.pmOut, candidate, typedNote)) {
    return "Write your accomplishment first";
  }
  return null;
}

/* ---- download ---- */

/* The employee's taps for one period, in the device's own layout, so a download can
   be uploaded again. */
export function bioDownloadText(taps) {
  const fmt = (t) => {
    const [y, m, d] = t.date.split("-").map(Number);
    const [h, mi] = t.time.split(":").map(Number);
    const code = Object.keys(KIND_BY_CODE).find((c) => KIND_BY_CODE[c] === t.kind) || "0";
    return `${t.rawId || t.id}\t${m}/${d}/${y} ${h}:${p2(mi)}\t1\t${/^\d$/.test(t.code) ? t.code : code}\t1\t0`;
  };
  return [...(taps || [])]
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .map((t) => t.raw || fmt(t))
    .join("\r\n") + "\r\n";
}
