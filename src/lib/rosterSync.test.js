/* Stale roster saves must never drop newer roster data.

   Each "device" loads the shared roster, edits its own screen copy, and saves the way
   the app does (saveRosterChanges, then rebaseRoster when other devices' changes came
   in). The store below behaves like dtr_save_year: a write names the revision it was
   built from and is refused, with the current copy returned, when the row has moved.
   No test touches Supabase. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEmployee, normalizeRoster, diffRoster, saveRosterChanges, rebaseRoster, profileChanges,
} from "./rosterSync.js";
import { canonicalSite, groupStaffBySite } from "./logbookGroups.js";

const person = (id, name, extra = {}) => normalizeEmployee({ id, name, role: "viewer", ...extra });
const SEED = () => [person("A1", "Ana"), person("B2", "Ben"), person("C3", "Carlo")];

function fixtureStore(initial = SEED()) {
  const store = { payload: JSON.parse(JSON.stringify(initial)), revision: 1, writes: 0 };
  store.read = () => ({ roster: normalizeRoster(JSON.parse(JSON.stringify(store.payload))), revision: store.revision });
  store.write = async (payload, expected) => {
    if (expected !== store.revision) {
      return { conflict: true, payload: JSON.parse(JSON.stringify(store.payload)), revision: store.revision };
    }
    store.writes++;
    store.payload = JSON.parse(JSON.stringify(payload));
    store.revision += 1;
    return { ok: true, revision: store.revision };
  };
  return store;
}

/* one device: the base it last synced, and what is on its screen */
function device(store) {
  const d = { base: store.read(), last: null };
  d.screen = JSON.parse(JSON.stringify(d.base.roster));
  d.edit = (id, fields) => { d.screen = d.screen.map((e) => (e.id === id ? { ...e, ...fields } : e)); };
  d.save = async () => {
    const res = await saveRosterChanges(d.base, d.screen, store.write);
    d.last = res;
    if (res.state === "saved") {
      d.base = res.base;
      if (res.merged || res.conflicts.length || res.dropped.length) d.screen = rebaseRoster(res.roster, res.submitted, d.screen);
    }
    return res;
  };
  return d;
}

const stored = (store, id) => store.payload.find((e) => e.id === id);
const ids = (list) => list.map((e) => e.id);

/* ---- the reported bug ---- */
test("a stale Project site edit does not remove an employee another device added", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.screen.push(person("D4", "David"));
  assert.equal((await b.save()).state, "saved");

  a.edit("A1", { site: "Head Office" });
  const res = await a.save();
  assert.equal(res.state, "saved");
  assert.deepEqual(ids(store.payload), ["A1", "B2", "C3", "D4"], "David must not disappear");
  assert.equal(stored(store, "A1").site, "Head Office");
  assert.deepEqual(ids(a.screen), ["A1", "B2", "C3", "D4"], "and device A now shows David");
});

test("a stale Sunday change does not remove another user's newer change", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.edit("B2", { sundayPeriods: ["2026-09-13"], site: "Bulacan Site" });
  await b.save();
  a.edit("A1", { sundayPeriods: ["2026-09-28"] });
  await a.save();
  assert.deepEqual(stored(store, "B2").sundayPeriods, ["2026-09-13"]);
  assert.equal(stored(store, "B2").site, "Bulacan Site");
  assert.deepEqual(stored(store, "A1").sundayPeriods, ["2026-09-28"]);
});

test("Sunday cut-offs added to one employee from two devices are both kept", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.edit("A1", { sundayPeriods: ["2026-09-13"] });
  await b.save();
  a.edit("A1", { sundayPeriods: ["2026-09-28"] });
  const res = await a.save();
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(stored(store, "A1").sundayPeriods, ["2026-09-13", "2026-09-28"]);
});

test("a stale passcode update does not remove another user's newer change", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.edit("C3", { position: "Foreman" });
  b.screen.push(person("D4", "David"));
  await b.save();
  a.edit("A1", { pinHash: "hashA", pinSalt: "saltA", pinIter: 210000 });
  await a.save();
  assert.equal(stored(store, "C3").position, "Foreman");
  assert.ok(stored(store, "D4"));
  assert.deepEqual([stored(store, "A1").pinHash, stored(store, "A1").pinSalt], ["hashA", "saltA"]);
});

test("two devices changing different fields of the same employee both survive", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.edit("A1", { pinHash: "hashB", pinSalt: "saltB", pinIter: 210000 });
  await b.save();
  a.edit("A1", { site: "Head Office" });
  await a.save();
  const ana = stored(store, "A1");
  assert.equal(ana.site, "Head Office");
  assert.deepEqual([ana.pinHash, ana.pinSalt, ana.pinIter], ["hashB", "saltB", 210000]);
});

/* ---- the same field from two devices ---- */
test("same-field edits: the first stored wins, the later one is reported and not written", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.edit("A1", { site: "South Site" });
  await b.save();
  a.edit("A1", { site: "North Site" });
  const res = await a.save();
  assert.equal(stored(store, "A1").site, "South Site", "B's earlier change is not overwritten");
  assert.equal(res.conflicts.length, 1);
  assert.deepEqual(res.conflicts[0].fields, ["site"]);
  assert.deepEqual(res.conflicts[0].kept, { site: "South Site" });
  assert.deepEqual(res.conflicts[0].wanted, { site: "North Site" });
  assert.equal(a.screen.find((e) => e.id === "A1").site, "South Site", "device A now shows the stored value");
  assert.equal(store.revision, 2, "losing every change writes nothing — no empty revision bump");
  const again = await a.save();
  assert.equal(again.state, "no-change", "the rejected value is not quietly sent on the next save");
  assert.equal(stored(store, "A1").site, "South Site");
});

test("two passcode changes to one employee never mix one's hash with the other's salt", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.edit("A1", { pinHash: "hashB", pinSalt: "saltB", pinIter: 210000 });
  await b.save();
  a.edit("A1", { pinHash: "hashA", pinSalt: "saltA", pinIter: 210000 });
  const res = await a.save();
  const ana = stored(store, "A1");
  assert.deepEqual([ana.pinHash, ana.pinSalt], ["hashB", "saltB"]);
  assert.deepEqual(res.conflicts[0].fields, ["pinHash", "pinSalt", "pinIter"]);
});

/* ---- adds and deletes ---- */
test("one device adds an employee while another edits an existing one", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  a.screen.push(person("E5", "Eve"));
  await a.save();
  b.edit("B2", { position: "Engineer" });
  await b.save();
  assert.deepEqual(ids(store.payload), ["A1", "B2", "C3", "E5"]);
  assert.equal(stored(store, "B2").position, "Engineer");
});

test("one device deletes an employee while another saves a different one", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  a.screen = a.screen.filter((e) => e.id !== "C3");
  await a.save();
  b.edit("B2", { site: "Bulacan Site" });
  await b.save();
  assert.deepEqual(ids(store.payload), ["A1", "B2"], "the stale device does not bring Carlo back");
  assert.equal(stored(store, "B2").site, "Bulacan Site");

  const store2 = fixtureStore();
  const c = device(store2), d = device(store2);
  c.edit("B2", { site: "Bulacan Site" });
  await c.save();
  d.screen = d.screen.filter((e) => e.id !== "C3");
  await d.save();
  assert.deepEqual(ids(store2.payload), ["A1", "B2"]);
  assert.equal(stored(store2, "B2").site, "Bulacan Site", "the delete does not undo the other edit");
});

test("an edit to an employee deleted on another device does not recreate them", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.screen = b.screen.filter((e) => e.id !== "C3");
  await b.save();
  a.edit("C3", { site: "Head Office", sundayPeriods: ["2026-09-28"] });
  const res = await a.save();
  assert.equal(stored(store, "C3"), undefined);
  assert.deepEqual(res.dropped.map((d) => d.id), ["C3"]);
  assert.equal(a.screen.find((e) => e.id === "C3"), undefined);
});

test("renaming an ID another device has just taken keeps the employee instead of deleting them", async () => {
  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.screen.push(person("X9", "Xavier"));
  await b.save();
  a.edit("C3", { id: "X9" });
  const res = await a.save();
  assert.equal(stored(store, "C3").name, "Carlo", "Carlo is not lost");
  assert.equal(stored(store, "X9").name, "Xavier");
  assert.deepEqual(res.conflicts[0].fields, ["id"]);

  const fresh = fixtureStore();
  const c = device(fresh);
  c.edit("C3", { id: "C7" });
  await c.save();
  assert.deepEqual(ids(fresh.payload), ["A1", "B2", "C7"], "an ordinary ID edit stays in place");
});

/* ---- project sites ---- */
test("project-site canonicalization and department grouping survive a merged save", async () => {
  assert.equal(canonicalSite("  head   office ", [person("B2", "Ben", { site: "Head Office" })], "A1"), "Head Office");
  assert.equal(canonicalSite("New Site", [person("B2", "Ben", { site: "Head Office" })], "A1"), "New Site");

  const store = fixtureStore();
  const a = device(store), b = device(store);
  b.edit("B2", { site: "Head Office" });
  await b.save();
  /* A cannot see B's spelling yet, so it keeps its own */
  a.edit("A1", { site: canonicalSite("head office ", a.screen, "A1") });
  await a.save();
  const groups = groupStaffBySite(store.payload);
  const head = groups.find((g) => g.staff.some((e) => e.id === "A1"));
  assert.deepEqual(ids(head.staff), ["A1", "B2"], "both land in one department");
  /* once merged, a site typed on A takes the spelling that department is listed under */
  assert.equal(canonicalSite("HEAD OFFICE", a.screen, "C3"), head.label);
  b.edit("C3", { site: "Head Office" });
  await b.save();
  /* a device picks up other devices' changes on its next save or reload */
  const reloaded = device(store);
  assert.equal(groupStaffBySite(reloaded.screen).find((g) => g.staff.some((e) => e.id === "A1")).label, "Head Office");
  assert.equal(canonicalSite("head office", reloaded.screen, "D4"), "Head Office", "the majority spelling wins");
});

/* ---- failure handling ---- */
test("a save that cannot reach storage leaves the base alone, so the retry merges the same way", async () => {
  const store = fixtureStore();
  const a = device(store);
  a.edit("A1", { site: "Head Office" });
  const offline = await saveRosterChanges(a.base, a.screen, async () => { throw new Error("network down"); });
  assert.equal(offline.state, "offline");
  assert.equal(offline.base, a.base);

  const b = device(store);
  b.screen.push(person("D4", "David"));
  await b.save();
  await a.save();
  assert.deepEqual(ids(store.payload), ["A1", "B2", "C3", "D4"]);
  assert.equal(stored(store, "A1").site, "Head Office");
});

test("a row that keeps moving gives up after bounded retries instead of forcing the write", async () => {
  const store = fixtureStore();
  const a = device(store);
  a.edit("A1", { site: "Head Office" });
  let calls = 0;
  const churning = async () => { calls++; return { conflict: true, payload: SEED(), revision: 100 + calls }; };
  const res = await saveRosterChanges(a.base, a.screen, churning);
  assert.equal(res.state, "conflict-retries-exhausted");
  assert.equal(calls, 4);
  assert.equal(res.base, a.base);
});

test("an offline base of unknown revision fetches the current copy before writing", async () => {
  const store = fixtureStore();
  const b = device(store);
  b.screen.push(person("D4", "David"));
  await b.save();
  const res = await saveRosterChanges({ roster: SEED(), revision: -1 }, [...SEED().slice(0, 2)], store.write);
  assert.equal(res.state, "saved");
  assert.deepEqual(ids(store.payload), ["A1", "B2", "D4"], "only this device's delete of Carlo is applied");
});

test("nothing is written when nothing changed", async () => {
  const store = fixtureStore();
  const a = device(store);
  a.edit("A1", { name: " Ana " });
  assert.equal((await a.save()).state, "no-change");
  assert.equal(store.writes, 0);
});

/* ---- the screen after a merge ---- */
test("edits made while a save was in flight, and blank rows, survive the rebase", () => {
  const submitted = SEED();
  const result = [...SEED(), person("D4", "David")];
  const now = [...SEED().map((e) => (e.id === "B2" ? { ...e, position: "Typed meanwhile" } : e)),
    { id: "", name: "", role: "viewer" }];
  const next = rebaseRoster(result, submitted, now);
  assert.deepEqual(ids(next), ["A1", "B2", "C3", "D4", ""]);
  assert.equal(next.find((e) => e.id === "B2").position, "Typed meanwhile");
});

/* ---- the profile table ---- */
test("profile sync touches only the employees this save changed", () => {
  const base = SEED();
  const current = [...SEED().map((e) => (e.id === "A1" ? { ...e, role: "admin" } : e)).filter((e) => e.id !== "C3"),
    person("E5", "Eve")];
  const ops = diffRoster(base, current);
  const merged = [...current, person("D4", "David")]; /* David came from another device */
  const changes = profileChanges(ops, merged);
  assert.deepEqual(changes.upsert.map((p) => p.employee_id).sort(), ["A1", "E5"]);
  assert.deepEqual(changes.remove, ["C3"]);
  assert.ok(!changes.remove.includes("D4"), "another device's new employee is never deleted");
});

test("normalizeEmployee writes the same shape the roster save always has", () => {
  const e = { id: " 0055 ", name: " Ana ", position: " Eng ", site: " HO ", photo: "p", signature: "s",
    signatureEnabled: true, signatureOnLogbook: "yes", signatureX: "3", signatureY: null, signatureScale: 0,
    role: "boss", pinHash: "h", pinSalt: "s", pinIter: "210000", sundayPeriods: [20260913], extra: "dropped" };
  const old = { id: (e.id || "").trim(), name: (e.name || "").trim(), position: (e.position || "").trim(), site: (e.site || "").trim(), photo: e.photo || "", signature: e.signature || "", signatureEnabled: e.signatureEnabled === true, signatureOnLogbook: e.signatureOnLogbook === true, signatureX: Number(e.signatureX) || 0, signatureY: Number(e.signatureY) || 0, signatureScale: Number(e.signatureScale) || 1, role: e.role === "admin" ? "admin" : "viewer",
    pinHash: e.pinHash || "", pinSalt: e.pinSalt || "", pinIter: Number(e.pinIter) || 0,
    sundayPeriods: Array.isArray(e.sundayPeriods) ? e.sundayPeriods.map(String) : [] };
  assert.deepEqual(normalizeEmployee(e), old);
});
