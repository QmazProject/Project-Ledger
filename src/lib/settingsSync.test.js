/* Shared settings (`dtr:cfg`) saved from two admins' devices must not overwrite each
   other. Each device loads the settings (defaults filled in, as the app does), edits
   its screen copy, and saves through saveSettingsChanges; the store behaves like
   dtr_save_year. Nothing here touches Supabase. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSettings, saveSettingsChanges, mergeQueuedSettings, rebaseSettings,
  describeSettingsConflicts, scheduleIssue,
} from "./settingsSync.js";
import { orderIssue, periodOf } from "./dtrTime.js";

const SCHED_DEF = { amStart: "08:00", amEnd: "12:00", pmStart: "13:00", pmEnd: "17:00" };
const DEF = { co: "QM BUILDERS", dept: "HUMAN RESOURCE", title: "DAILY TIME RECORD (STAFF)", logo: "", sched: SCHED_DEF };
const clone = (v) => JSON.parse(JSON.stringify(v));

function cfgStore(stored) {
  const s = { payload: clone(stored), revision: 1, writes: 0 };
  s.write = async (payload, expected) => {
    if (expected !== s.revision) return { conflict: true, payload: clone(s.payload), revision: s.revision };
    s.writes++;
    s.payload = clone(payload);
    s.revision += 1;
    return { ok: true, revision: s.revision };
  };
  return s;
}

function admin(store) {
  const value = normalizeSettings(clone(store.payload), DEF);
  const d = { base: { value, revision: store.revision }, screen: clone(value), last: null };
  d.set = (fields) => { d.screen = { ...d.screen, ...fields }; };
  d.setSched = (fields) => { d.screen = { ...d.screen, sched: { ...d.screen.sched, ...fields } }; };
  d.save = async () => {
    const res = await saveSettingsChanges(d.base, d.screen, store.write, { defaults: DEF });
    d.last = res;
    if (res.state === "saved") {
      d.base = res.base;
      if (res.merged || res.conflicts.length) d.screen = rebaseSettings(res.value, res.submitted, d.screen);
    }
    return res;
  };
  return d;
}

const STORED = () => ({ co: "ABC", dept: "HR", title: "DTR", logo: "", sched: { ...SCHED_DEF }, logbookDept: "POD Office" });

/* 1 */
test("two admins editing different settings both survive", async () => {
  const store = cfgStore(STORED());
  const a = admin(store), b = admin(store);
  b.set({ co: "XYZ" });
  await b.save();
  a.setSched({ amStart: "07:30" });
  const res = await a.save();
  assert.equal(res.state, "saved");
  assert.equal(store.payload.co, "XYZ");
  assert.equal(store.payload.sched.amStart, "07:30");
  assert.equal(a.screen.co, "XYZ", "A's screen shows B's change");
  assert.equal(store.payload.logbookDept, "POD Office", "a key no longer used is carried through untouched");
});

/* 2 */
test("the same setting from two admins: the first stored value stays, the later one is warned", async () => {
  const store = cfgStore(STORED());
  const a = admin(store), b = admin(store);
  a.setSched({ amStart: "07:30" });
  await a.save();
  b.setSched({ amStart: "08:30" });
  const res = await b.save();
  assert.equal(store.payload.sched.amStart, "07:30");
  assert.equal(b.screen.sched.amStart, "07:30", "B's screen moves onto the stored value");
  assert.equal(describeSettingsConflicts(res.conflicts),
    "AM start was changed on another device first. The saved value 7:30 AM was kept. Review it before changing again.");
  assert.equal((await b.save()).state, "no-change", "the rejected value is not re-sent");
  assert.equal(store.revision, 2, "the losing save wrote nothing");
});

test("text settings conflict the same way, and several are summarised", async () => {
  const store = cfgStore(STORED());
  const a = admin(store), b = admin(store);
  a.set({ co: "First Co", title: "Form A" });
  await a.save();
  b.set({ co: "Second Co", title: "Form B" });
  const res = await b.save();
  assert.equal(store.payload.co, "First Co");
  assert.equal(describeSettingsConflicts(res.conflicts),
    "Company name, Form title were changed on another device first. The saved values were kept. Review them before changing again.");
});

/* 3 */
test("a schedule pair is never mixed from two admins", async () => {
  const store = cfgStore(STORED());
  const a = admin(store), b = admin(store);
  b.setSched({ amEnd: "12:30" });
  await b.save();
  a.setSched({ amStart: "07:30", amEnd: "11:30" });
  const res = await a.save();
  assert.deepEqual([store.payload.sched.amStart, store.payload.sched.amEnd], ["08:00", "12:30"], "B's pair, whole");
  assert.equal(res.conflicts[0].group, "sched.am");
});

test("changes to different pairs that would break the day's order keep the stored schedule", async () => {
  const store = cfgStore(STORED());
  const a = admin(store), b = admin(store);
  b.setSched({ pmStart: "12:30" });
  await b.save();
  a.setSched({ amEnd: "13:00" });
  const res = await a.save();
  assert.equal(scheduleIssue(store.payload.sched), null);
  assert.deepEqual(store.payload.sched, { ...SCHED_DEF, pmStart: "12:30" });
  assert.equal(res.conflicts[0].group, "sched.am");

  const store2 = cfgStore(STORED());
  const c = admin(store2), d = admin(store2);
  d.setSched({ pmEnd: "18:00" });
  await d.save();
  c.setSched({ amStart: "07:30" });
  await c.save();
  assert.deepEqual(store2.payload.sched, { amStart: "07:30", amEnd: "12:00", pmStart: "13:00", pmEnd: "18:00" }, "compatible pair changes both land");
});

/* 4 */
test("repeated refusals re-read and re-apply until the save lands", async () => {
  const store = cfgStore(STORED());
  const a = admin(store);
  a.set({ title: "New title" });
  let interrupts = 2;
  const racing = async (payload, expected) => {
    if (interrupts-- > 0) { store.payload[`note${interrupts}`] = "remote"; store.revision += 1; }
    return store.write(payload, expected);
  };
  const res = await saveSettingsChanges(a.base, a.screen, racing, { defaults: DEF });
  assert.equal(res.state, "saved");
  assert.equal(store.payload.title, "New title");
  assert.equal(store.payload.note0, "remote");
  assert.equal(store.payload.note1, "remote");
});

/* 5 */
test("retry exhaustion never forces a blind save", async () => {
  const store = cfgStore(STORED());
  const a = admin(store);
  a.set({ co: "Mine" });
  let calls = 0;
  const churning = async () => { calls++; return { conflict: true, payload: STORED(), revision: 50 + calls }; };
  const res = await saveSettingsChanges(a.base, a.screen, churning, { defaults: DEF });
  assert.equal(res.state, "conflict-retries-exhausted");
  assert.equal(calls, 4);
  assert.equal(store.payload.co, "ABC");
});

/* 6 */
test("loading settings writes nothing, even when defaults fill in missing keys", async () => {
  const store = cfgStore({ co: "ABC" }); /* an old row with no schedule stored */
  const a = admin(store);
  assert.equal((await a.save()).state, "no-change");
  assert.equal(store.writes, 0);
});

/* 7 */
test("a reconnect with no settings changes writes nothing", async () => {
  const store = cfgStore(STORED());
  const a = admin(store);
  const res = await mergeQueuedSettings(clone(a.screen), { value: clone(a.base.value), revision: a.base.revision }, store.write, { defaults: DEF });
  assert.equal(res.state, "no-change");
  assert.equal(store.writes, 0);
});

/* 8 */
test("old offline settings without a valid base are set aside, never uploaded", async () => {
  let writes = 0;
  const write = async () => { writes++; return { ok: true, revision: 9 }; };
  for (const kept of [null, { revision: 3 }, { value: "x", revision: 3 }]) {
    const res = await mergeQueuedSettings({ co: "Offline Co" }, kept, write, { defaults: DEF });
    assert.equal(res.state, "set-aside");
  }
  assert.equal(writes, 0);
});

test("queued offline settings with their base merge like any other save", async () => {
  const store = cfgStore(STORED());
  const a = admin(store);           /* loaded, then offline */
  const b = admin(store);
  b.set({ dept: "Payroll" });
  await b.save();
  a.setSched({ pmEnd: "17:30" });
  const res = await mergeQueuedSettings(a.screen, { value: a.base.value, revision: a.base.revision }, store.write, { defaults: DEF });
  assert.equal(res.state, "saved");
  assert.equal(store.payload.dept, "Payroll");
  assert.equal(store.payload.sched.pmEnd, "17:30");
});

/* 9 */
test("payroll cut-offs are fixed dates, untouched by any settings merge", async () => {
  const store = cfgStore(STORED());
  const a = admin(store), b = admin(store);
  b.set({ co: "XYZ" });
  await b.save();
  a.setSched({ amStart: "07:30" });
  await a.save();
  assert.deepEqual(Object.keys(store.payload).sort(), ["co", "dept", "logbookDept", "logo", "sched", "title"]);
  const p = periodOf(new Date(2026, 8, 30));
  assert.deepEqual([p.s.getDate(), p.e.getMonth(), p.e.getDate()], [28, 9, 12]);
});

/* 10 */
test("the merged AM start is what the overnight-OT cutoff reads", async () => {
  const store = cfgStore(STORED());
  const a = admin(store), b = admin(store);
  b.set({ co: "XYZ" });
  await b.save();
  a.setSched({ amStart: "07:30" });
  await a.save();
  const amStart = normalizeSettings(store.payload, DEF).sched.amStart;
  const day = { amIn: "08:00", amOut: "12:00", pmIn: "13:00", pmOut: "17:00", otIn: "18:00" };
  assert.equal(orderIssue(day, "otOut", "07:30", amStart), null);
  assert.equal(orderIssue(day, "otOut", "07:45", amStart), "OT out can't be later than the next scheduled AM start at 7:30 AM.");
});
