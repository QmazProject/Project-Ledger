/* Offline DTR edits merged on reconnect must never overwrite newer cloud data.

   Each case: a device reads a year (its base), goes offline and edits its copy, another
   device saves meanwhile, then the offline device reconnects through the same merge the
   app runs (mergeQueuedYear). The store behaves like dtr_save_year — a write names the
   revision it was built from and is refused, with the current row, when the row moved.
   Nothing here touches Supabase. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  dayContent, diffYear, saveYearChanges, mergeQueuedYear, describeYearConflicts,
} from "./dtrYearSync.js";
import { otMinutes, recordOrderIssue } from "./dtrTime.js";
import { logKey } from "./dtrStore.js";

const AM_START = "08:00";
const ID = "A1";
const K26 = logKey(ID, 2026), K27 = logKey(ID, 2027);
const clone = (v) => JSON.parse(JSON.stringify(v));
/* what the app does to every day the merge changes, and the rule it must still satisfy */
const hooks = {
  finalizeDay: (d) => { d.otMinutes = otMinutes(d); },
  validateDay: (d) => recordOrderIssue(d, AM_START),
};
const REGULAR = { amIn: "08:00", amOut: "12:00", pmIn: "13:00", pmOut: "17:00", src: { amIn: "punch", amOut: "punch", pmIn: "punch", pmOut: "punch" } };

function yearStore(rows) {
  const store = new Map(Object.entries(rows).map(([k, v]) => [k, { payload: clone(v), revision: 1 }]));
  const s = {
    writes: [],
    read: (k) => ({ value: clone((store.get(k) || { payload: {} }).payload), revision: (store.get(k) || { revision: 0 }).revision }),
    row: (k) => (store.get(k) || {}).payload,
    write: (k) => async (payload, expected) => {
      const row = store.get(k) || { payload: {}, revision: 0 };
      if (row.revision !== expected) return { conflict: true, payload: clone(row.payload), revision: row.revision };
      store.set(k, { payload: clone(payload), revision: row.revision + 1 });
      s.writes.push(k);
      return { ok: true, revision: row.revision + 1 };
    },
    /* another device's accepted save to one date */
    remoteEdit: async (k, date, fields) => {
      const cur = s.read(k);
      cur.value[date] = { ...(cur.value[date] || {}), ...fields };
      Object.keys(fields).forEach((f) => { if (fields[f] === undefined) delete cur.value[date][f]; });
      const res = await s.write(k)(cur.value, cur.revision);
      assert.ok(res.ok);
    },
  };
  return s;
}

/* a device that loaded `k`, then lost its connection */
function offlineDevice(store, k) {
  const base = store.read(k);
  const d = { base, local: clone(base.value) };
  d.edit = (date, fields) => {
    d.local[date] = { ...(d.local[date] || {}), ...fields };
    Object.keys(fields).forEach((f) => { if (fields[f] === undefined) delete d.local[date][f]; });
  };
  d.reconnect = () => mergeQueuedYear(d.local, { value: d.base.value, revision: d.base.revision }, store.write(k), hooks);
  return d;
}

const seed = () => ({ [K26]: { "2026-09-15": { ...REGULAR }, "2026-09-14": { ...REGULAR, note: "survey" } } });

/* 1 */
test("a stale offline edit does not remove a newer change on a different day", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-15", { pmOut: "17:20" });
  a.edit("2026-09-16", { amIn: "07:55" });
  const res = await a.reconnect();
  assert.equal(res.state, "saved");
  assert.equal(store.row(K26)["2026-09-15"].pmOut, "17:20", "B's Sep 15 PM Out survives");
  assert.equal(store.row(K26)["2026-09-16"].amIn, "07:55", "A's Sep 16 AM In arrives");
});

/* 2 */
test("different fields of the same day from two devices both survive", async () => {
  const store = yearStore({ [K26]: { "2026-09-15": { ...REGULAR, otIn: "18:00" } } });
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-15", { note: "Site inventory" });
  a.edit("2026-09-15", { otOut: "00:30" });
  await a.reconnect();
  const day = store.row(K26)["2026-09-15"];
  assert.equal(day.note, "Site inventory");
  assert.equal(day.otOut, "00:30");
  assert.equal(day.otMinutes, 390, "totals recalculated on the merged day");
});

/* 3 */
test("the same punch changed on both sides keeps the first stored value and warns", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-15", { pmOut: "17:30" });
  a.edit("2026-09-15", { pmOut: "17:00", src: { ...REGULAR.src, pmOut: "edited" } });
  const res = await a.reconnect();
  assert.equal(store.row(K26)["2026-09-15"].pmOut, "17:30", "B's value is not overwritten");
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].group, "slot:pmOut");
  assert.equal(describeYearConflicts(res.conflicts),
    "September 15 PM Out was changed on another device while you were offline. The saved value was kept. Please review it before editing again.");
  assert.equal(store.writes.length, 1, "nothing left to write, so nothing is written");
});

test("many conflicts are summarised in one message", () => {
  const conflicts = ["slot:amIn", "slot:pmOut", "field:note", "slot:otIn"].map((group, i) => ({ date: `2026-09-1${i + 1}`, group }));
  assert.equal(describeYearConflicts(conflicts),
    "4 offline changes were not applied because they were changed on another device (September 11 AM In, September 12 PM Out, September 13 accomplishment, …). The saved values were kept. Please review them before editing again.");
});

/* 4 */
test("an offline clear does not erase a value another device changed since", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-14", { note: "survey, revised" });
  a.edit("2026-09-14", { note: undefined });
  const res = await a.reconnect();
  assert.equal(store.row(K26)["2026-09-14"].note, "survey, revised");
  assert.equal(res.conflicts[0].group, "field:note");

  /* but a deliberate clear of a value nobody else touched is applied */
  const store2 = yearStore(seed());
  const b = offlineDevice(store2, K26);
  b.edit("2026-09-14", { note: undefined });
  await b.reconnect();
  assert.equal(store2.row(K26)["2026-09-14"].note, undefined);
});

/* 5 */
test("an offline accomplishment and a remote punch on the same day both survive", async () => {
  const store = yearStore({ [K26]: { "2026-09-17": { amIn: "08:00" } } });
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-17", { amOut: "12:00" });
  a.edit("2026-09-17", { note: "Checked rebar delivery" });
  await a.reconnect();
  assert.deepEqual(dayContent(store.row(K26)["2026-09-17"]), { amIn: "08:00", amOut: "12:00", note: "Checked rebar delivery" });
});

/* 6 */
test("offline overnight OT stays on the duty date, counts 6:00 and respects the cutoff", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-14", { note: "survey done" });
  a.edit("2026-09-15", { otIn: "18:00", otOut: "00:00" });
  await a.reconnect();
  const day = store.row(K26)["2026-09-15"];
  assert.equal(day.otOut, "00:00");
  assert.equal(day.otMinutes, 360);
  assert.equal(store.row(K26)["2026-09-16"], undefined, "no AM In appears on the next day");

  const store2 = yearStore(seed());
  const b = offlineDevice(store2, K26);
  b.edit("2026-09-15", { otIn: "18:00", otOut: "09:00" }); /* past the 8:00 AM cutoff */
  const res = await b.reconnect();
  assert.equal(store2.row(K26)["2026-09-15"].otOut, undefined, "an invalid overnight OT is not stored");
  assert.equal(res.conflicts[0].group, "times");
});

/* 7 */
test("Dec 31 -> Jan 1 overnight OT made offline stays on Dec 31's 2026 row", async () => {
  const store = yearStore({ [K26]: { "2026-12-31": { ...REGULAR } }, [K27]: {} });
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K27, "2027-01-01", { amIn: "08:05" }); /* the new year row moves on elsewhere */
  await store.remoteEdit(K26, "2026-12-30", { note: "year-end count" });
  a.edit("2026-12-31", { otIn: "18:00", otOut: "00:00" });
  await a.reconnect();
  assert.equal(store.row(K26)["2026-12-31"].otOut, "00:00");
  assert.equal(store.row(K26)["2026-12-31"].otMinutes, 360);
  assert.equal(store.row(K26)["2026-12-30"].note, "year-end count");
  assert.deepEqual(store.row(K27), { "2027-01-01": { amIn: "08:05" } }, "the 2027 row is untouched by A");
  assert.ok(!store.writes.slice(2).includes(K27), "A never writes the 2027 row");
});

/* 8 */
test("a stale offline year cannot overwrite a newly added day", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-20", { leave: true });
  a.edit("2026-09-16", { amIn: "07:55" });
  await a.reconnect();
  assert.equal(store.row(K26)["2026-09-20"].leave, true);
  assert.equal(store.row(K26)["2026-09-16"].amIn, "07:55");
});

test("a leave mark and a punch on the same day never merge into a leave day with punches", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  await store.remoteEdit(K26, "2026-09-15", { otIn: "18:00" });
  a.edit("2026-09-15", { leave: true, amIn: undefined, amOut: undefined, pmIn: undefined, pmOut: undefined, src: {} });
  const res = await a.reconnect();
  const day = store.row(K26)["2026-09-15"];
  assert.equal(day.leave, undefined, "the stored day keeps its punches");
  assert.equal(day.otIn, "18:00");
  assert.equal(res.conflicts[0].group, "day");
});

/* 9 */
test("repeated refusals re-read and re-apply until the save lands", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  a.edit("2026-09-16", { amIn: "07:55" });
  let interrupts = 2;
  const racing = async (payload, expected) => {
    if (interrupts-- > 0) await store.remoteEdit(K26, `2026-09-2${interrupts}`, { note: `remote ${interrupts}` });
    return store.write(K26)(payload, expected);
  };
  const res = await saveYearChanges({ value: a.base.value, revision: a.base.revision }, a.local, racing, hooks);
  assert.equal(res.state, "saved");
  assert.equal(store.row(K26)["2026-09-21"].note, "remote 1");
  assert.equal(store.row(K26)["2026-09-20"].note, "remote 0");
  assert.equal(store.row(K26)["2026-09-16"].amIn, "07:55");
});

/* 10 */
test("retry exhaustion never forces a blind save", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  a.edit("2026-09-16", { amIn: "07:55" });
  let calls = 0;
  const churning = async () => { calls++; return { conflict: true, payload: clone(seed()[K26]), revision: 100 + calls }; };
  const res = await mergeQueuedYear(a.local, a.base, churning, hooks);
  assert.equal(res.state, "conflict-retries-exhausted");
  assert.equal(calls, 4);
  assert.equal(store.row(K26)["2026-09-16"], undefined);
});

test("an unreachable store leaves the change queued, with its base unchanged", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  a.edit("2026-09-16", { amIn: "07:55" });
  const res = await mergeQueuedYear(a.local, a.base, async () => { throw new Error("offline"); }, hooks);
  assert.equal(res.state, "offline");
  assert.equal(res.base.revision, a.base.revision);
});

/* 11 */
test("old queued data without a merge base is set aside, never uploaded", async () => {
  let writes = 0;
  const write = async () => { writes++; return { ok: true, revision: 9 }; };
  for (const kept of [null, {}, { value: null, revision: 1 }, { value: {}, revision: "x" }]) {
    const res = await mergeQueuedYear({ "2026-09-16": { amIn: "07:55" } }, kept, write, hooks);
    assert.equal(res.state, "set-aside");
  }
  assert.equal(writes, 0);
});

/* 12 */
test("no write happens when nothing actually changed", async () => {
  const store = yearStore(seed());
  const a = offlineDevice(store, K26);
  a.edit("2026-09-14", { note: "survey" });                 /* same value */
  a.edit("2026-09-18", { note: "   " });                     /* a blank note opened on a new date */
  a.local["2026-09-15"].dayMinutes = 999;                    /* a recalculated total */
  assert.deepEqual(diffYear(a.base.value, a.local), []);
  const res = await a.reconnect();
  assert.equal(res.state, "no-change");
  assert.equal(store.writes.length, 0);
});
