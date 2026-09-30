/* Overnight overtime: OT that ends after midnight belongs to the duty date it
   started on, counts across midnight, and may run only to the next scheduled AM
   start. The storage cases run against an in-memory fixture — never Supabase. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  otMinutes, otOutIsNextDay, orderIssue, recordOrderIssue, parseTime,
  openOvernightOtDate, nextPunchSlot, previousIsoDate, landingPunchDate,
  periodOf, dayHasEntries, periodStartsWithEntries,
} from "./dtrTime.js";
import { createRecordStore, logKey } from "./dtrStore.js";

const AM_START = "08:00";
const FULL_DAY = { amIn: "08:00", amOut: "12:00", pmIn: "13:00", pmOut: "17:00", otIn: "18:00" };

/* The same whole-year row shape as dtr_storage_dtr (see dtrStore.test.js). */
function fixtureBackend(rows = {}) {
  const store = new Map(Object.entries(rows).map(([k, v]) => [k, { payload: v, revision: 1 }]));
  const b = {
    saved: [],
    async read(key) {
      const row = store.get(key);
      return row ? { payload: JSON.parse(JSON.stringify(row.payload)), revision: row.revision }
                 : { payload: {}, revision: 0 };
    },
    async saveDay(key, dateStr, day, expectedRevision) {
      const row = store.get(key) || { payload: {}, revision: 0 };
      if (row.revision !== expectedRevision) return { ok: false, conflict: true, payload: row.payload, revision: row.revision };
      store.set(key, { payload: { ...row.payload, [dateStr]: JSON.parse(JSON.stringify(day)) }, revision: row.revision + 1 });
      b.saved.push({ key, dateStr });
      return { ok: true, revision: row.revision + 1 };
    },
    peek: (key) => store.get(key)?.payload,
  };
  return b;
}

/* ---- totals ---- */
test("6:00 PM -> 12:00 AM is 6:00 of overtime", () => {
  assert.equal(otMinutes({ otIn: "18:00", otOut: "00:00" }), 360);
  assert.equal(otOutIsNextDay("18:00", "00:00"), true);
});

test("6:00 PM -> 2:00 AM is 8:00 of overtime", () => {
  assert.equal(otMinutes({ otIn: "18:00", otOut: "02:00" }), 480);
});

test("same-day overtime counts as it always has", () => {
  assert.equal(otMinutes({ otIn: "18:00", otOut: "20:30" }), 150);
  assert.equal(otMinutes({ otIn: "18:00", otOut: "18:00" }), 0);
  assert.equal(otMinutes({ otIn: "18:00" }), 0);
  assert.equal(otOutIsNextDay("18:00", "20:30"), false);
});

/* ---- the cutoff ---- */
test("OT out exactly at the next scheduled AM start is accepted (inclusive cutoff)", () => {
  assert.equal(orderIssue(FULL_DAY, "otOut", "08:00", AM_START), null);
  assert.equal(otMinutes({ otIn: "18:00", otOut: "08:00" }), 14 * 60);
});

test("OT out after the next scheduled AM start is rejected, naming the configured start", () => {
  assert.equal(orderIssue(FULL_DAY, "otOut", "08:01", AM_START),
    "OT out can't be later than the next scheduled AM start at 8:00 AM.");
  /* the schedule comes from Settings, not a fixed hour */
  assert.equal(orderIssue(FULL_DAY, "otOut", "07:45", "07:30"),
    "OT out can't be later than the next scheduled AM start at 7:30 AM.");
  assert.equal(orderIssue(FULL_DAY, "otOut", "07:30", "07:30"), null);
});

test("an OT in moved past a stored OT out that would then breach the cutoff is still rejected", () => {
  const day = { ...FULL_DAY, otIn: "18:00", otOut: "20:00" };
  assert.equal(orderIssue(day, "otIn", "21:00", AM_START), "OT in can't be later than OT out (8:00 PM)");
  /* but a stored overnight OT out does not block a valid OT in edit */
  assert.equal(orderIssue({ ...day, otOut: "00:30" }, "otIn", "19:00", AM_START), null);
});

test("a full day with overnight overtime validates as a whole", () => {
  assert.equal(recordOrderIssue({ ...FULL_DAY, otOut: "00:00" }, AM_START), null);
  /* manual entry of OT out reports the cutoff, not the OT in before it */
  assert.equal(recordOrderIssue({ ...FULL_DAY, otOut: "09:00" }, AM_START, "otOut"),
    "OT out can't be later than the next scheduled AM start at 8:00 AM.");
  assert.equal(recordOrderIssue({ ...FULL_DAY, otIn: "21:00", otOut: "20:00" }, AM_START, "otIn"),
    "OT in can't be later than OT out (8:00 PM)");
  /* AM/PM edits keep the original check order and wording */
  assert.equal(recordOrderIssue({ amIn: "08:00", amOut: "07:00" }, AM_START, "amOut"),
    "AM in can't be later than AM out (7:00 AM)");
});

/* ---- nothing else about ordering moved ---- */
test("AM and PM ordering rules are unchanged", () => {
  assert.equal(orderIssue({ amIn: "08:00" }, "amOut", "07:00", AM_START), "AM out can't be earlier than AM in (8:00 AM)");
  assert.equal(orderIssue({ pmIn: "13:00" }, "pmOut", "12:30", AM_START), "PM out can't be earlier than PM in (1:00 PM)");
  assert.equal(orderIssue({ pmOut: "17:00" }, "pmIn", "18:00", AM_START), "PM in can't be later than PM out (5:00 PM)");
  assert.equal(orderIssue({ pmOut: "17:00" }, "otIn", "16:00", AM_START), "OT in can't be earlier than PM out (5:00 PM)");
  /* without an OT in there is no overnight pair: OT out before PM out is still wrong */
  assert.equal(orderIssue({ pmOut: "17:00" }, "otOut", "00:00", AM_START), "OT out can't be earlier than PM out (5:00 PM)");
});

/* ---- typing a time ---- */
test("bare 12 or 12:00 in OT out after a PM OT in is midnight", () => {
  assert.equal(parseTime("12:00", "PM", "otOut", "18:00"), "00:00");
  assert.equal(parseTime("12", "PM", "otOut", "18:00"), "00:00");
  assert.equal(parseTime("12:30", "PM", "otOut", "18:00"), "00:30");
  /* an explicit meridian is read as written */
  assert.equal(parseTime("12:00 PM", "PM", "otOut", "18:00"), "12:00");
  assert.equal(parseTime("12:00 AM", "PM", "otOut", "18:00"), "00:00");
});

test("other fields, and OT out with no PM OT in, parse as before", () => {
  assert.equal(parseTime("12:00", "PM", "otOut"), "12:00");
  assert.equal(parseTime("12:00", "PM", "otOut", "11:00"), "12:00");
  assert.equal(parseTime("12:00", "PM", "pmOut", "18:00"), "12:00");
  assert.equal(parseTime("12", "AM", "amOut"), "12:00");
  assert.equal(parseTime("5:06", "PM", "pmOut"), "17:06");
  assert.equal(parseTime("2:00", "PM", "otOut", "18:00"), "14:00");
  assert.equal(parseTime("2:00 AM", "PM", "otOut", "18:00"), "02:00");
});

/* ---- the live punch after midnight ---- */
test("yesterday's unfinished overtime stays open until the next AM start, then closes", () => {
  const recs = { "2026-09-28": { ...FULL_DAY } };
  const recOf = (ds) => recs[ds] || {};
  assert.equal(openOvernightOtDate("2026-09-29", recOf, "00:05", AM_START), "2026-09-28");
  assert.equal(openOvernightOtDate("2026-09-29", recOf, "08:00", AM_START), "2026-09-28");
  assert.equal(openOvernightOtDate("2026-09-29", recOf, "08:01", AM_START), null);
  assert.equal(openOvernightOtDate("2026-09-29", recOf, "05:00", "04:30"), null);
});

test("no unfinished overtime yesterday leaves today's Time In alone", () => {
  const closed = { "2026-09-28": { ...FULL_DAY, otOut: "21:00" } };
  const noOt = { "2026-09-28": { amIn: "08:00", pmOut: "17:00" } };
  const onLeave = { "2026-09-28": { leave: true, otIn: "18:00" } };
  for (const recs of [closed, noOt, onLeave, {}]) {
    assert.equal(openOvernightOtDate("2026-09-29", (ds) => recs[ds] || {}, "07:00", AM_START), null);
  }
  assert.equal(nextPunchSlot({}, false).k, "amIn");
});

test("previousIsoDate crosses month and year on the calendar", () => {
  assert.equal(previousIsoDate("2027-01-01"), "2026-12-31");
  assert.equal(previousIsoDate("2026-03-01"), "2026-02-28");
  assert.equal(previousIsoDate("2026-09-29"), "2026-09-28");
});

/* ---- what is stored ---- */
test("a live punch after midnight closes yesterday's OT and creates no AM in today", async () => {
  const ID = "006178";
  const be = fixtureBackend({ [logKey(ID, 2026)]: { "2026-09-28": { ...FULL_DAY } } });
  const store = createRecordStore(be);
  await store.ensureYear(ID, 2026);

  const target = openOvernightOtDate("2026-09-29", (ds) => store.peekDay(ID, ds), "00:00", AM_START) || "2026-09-29";
  const slot = nextPunchSlot(store.peekDay(ID, target), target !== "2026-09-29");
  assert.equal(target, "2026-09-28");
  assert.equal(slot.k, "otOut");
  assert.equal(orderIssue(store.peekDay(ID, target), slot.k, "00:00", AM_START), null);
  await store.writeDay(ID, target, (d) => { d[slot.k] = "00:00"; });

  const row = be.peek(logKey(ID, 2026));
  assert.equal(row["2026-09-28"].otOut, "00:00");
  assert.equal(row["2026-09-28"].amIn, "08:00", "the rest of Monday is kept");
  assert.equal(row["2026-09-29"], undefined, "Tuesday gets no AM in");
  assert.equal(otMinutes(row["2026-09-28"]), 360);
});

test("Dec 31 OT in -> Jan 1 OT out stays on Dec 31's record in the 2026 row", async () => {
  const ID = "006178";
  const be = fixtureBackend({ [logKey(ID, 2026)]: { "2026-12-31": { otIn: "18:00" }, "2026-12-30": { amIn: "08:00" } } });
  const store = createRecordStore(be);
  /* the app reads last year's row before looking at Dec 31 (landingPunchDate) */
  await store.ensureYear(ID, 2027);
  await store.ensureYear(ID, 2026);

  const target = openOvernightOtDate("2027-01-01", (ds) => store.peekDay(ID, ds), "00:00", AM_START);
  assert.equal(target, "2026-12-31");
  await store.writeDay(ID, target, (d) => { d.otOut = "00:00"; });

  assert.deepEqual(be.saved, [{ key: logKey(ID, 2026), dateStr: "2026-12-31" }]);
  assert.equal(be.peek(logKey(ID, 2026))["2026-12-31"].otOut, "00:00");
  assert.equal(be.peek(logKey(ID, 2026))["2026-12-30"].amIn, "08:00", "the rest of the year is kept");
  assert.equal(be.peek(logKey(ID, 2027)), undefined, "no 2027 row is created");
  assert.equal(otMinutes(be.peek(logKey(ID, 2026))["2026-12-31"]), 360);
});

test("landingPunchDate reads last year's row on Jan 1 and opens today when nothing is open", async () => {
  const ID = "006178";
  const be = fixtureBackend({ [logKey(ID, 2026)]: { "2026-12-31": { otIn: "18:00" } } });
  const store = createRecordStore(be);
  const loadYear = (y) => store.ensureYear(ID, y);
  assert.equal(await landingPunchDate("2027-01-01", "00:10", AM_START, loadYear), "2026-12-31");
  assert.equal(store.isLoaded(logKey(ID, 2026)), true);
  assert.equal(store.isLoaded(logKey(ID, 2027)), true);
  assert.equal(await landingPunchDate("2027-01-01", "08:05", AM_START, loadYear), "2027-01-01");
  assert.equal(await landingPunchDate("2027-01-02", "00:10", AM_START, loadYear), "2027-01-02");
  assert.equal(be.saved.length, 0, "choosing a date writes nothing");
});

/* ---- payroll period markers ---- */
test("payroll periods still run 28 -> 12 and 13 -> 27", () => {
  const span = (d) => { const p = periodOf(d); return [p.s.toDateString(), p.e.toDateString()]; };
  assert.deepEqual(span(new Date(2026, 8, 13)), [new Date(2026, 8, 13).toDateString(), new Date(2026, 8, 27).toDateString()]);
  assert.deepEqual(span(new Date(2026, 8, 28)), [new Date(2026, 8, 28).toDateString(), new Date(2026, 9, 12).toDateString()]);
  assert.deepEqual(span(new Date(2027, 0, 5)), [new Date(2026, 11, 28).toDateString(), new Date(2027, 0, 12).toDateString()]);
});

test("a day has entries only when something was actually recorded", () => {
  assert.equal(dayHasEntries({ amIn: "08:00" }), true);
  assert.equal(dayHasEntries({ otOut: "00:00" }), true);
  assert.equal(dayHasEntries({ leave: true }), true);
  assert.equal(dayHasEntries({ holiday: true }), true);
  assert.equal(dayHasEntries({ note: "site visit" }), true);
  assert.equal(dayHasEntries({ note: "   " }), false);
  /* totals stamped on load are not entries */
  assert.equal(dayHasEntries({ dayMinutes: 0, otMinutes: 0, dayCredit: "0.00", totalsAt: "2026-09-01T00:00:00Z" }), false);
  assert.equal(dayHasEntries(undefined), false);
});

test("period markers come from filled-in days in any year's row", () => {
  const y2026 = {
    "2026-09-15": { amIn: "08:00" },            // Sep 13 - 27
    "2026-09-29": { note: "" },                  // Sep 28 - Oct 12: blank, not marked
    "2026-12-30": { dayMinutes: 0 },             // stamped only, not marked
  };
  const y2027 = { "2027-01-05": { leave: true } }; // Dec 28, 2026 - Jan 12, 2027
  const starts = periodStartsWithEntries([y2026, y2027, undefined]);
  assert.deepEqual([...starts].sort(), ["2026-09-13", "2026-12-28"]);
});
