/* Regression tests for the 2026-09-08 data-loss incident (employee 006178).

   Every case below is a way the old code could destroy a year of DTR/logbook
   records. They run against an in-memory fixture backend — never Supabase, never
   production. See docs/data-safety.md. */

import test from "node:test";
import assert from "node:assert/strict";
import { createRecordStore, logKey, sameDay, isUntouched, MAX_SAVE_ATTEMPTS } from "./dtrStore.js";

/* The year employee 006178 actually had before it was erased. */
const SEED = () => ({
  "2026-09-07": { amIn: "07:55", amOut: "12:00", pmIn: "13:00", pmOut: "17:05" },
  "2026-09-08": { amIn: "07:58", amOut: "12:01" },
  "2026-09-09": { amIn: "08:02" },
});

/** In-memory stand-in for dtr_storage_dtr, with the same whole-row shape. */
function fixtureBackend(rows = {}, opts = {}) {
  const store = new Map(Object.entries(rows).map(([k, v]) => [k, { payload: v, revision: 1 }]));
  const b = {
    reads: 0, writes: 0, saved: [], failNextRead: opts.failNextRead || 0,
    async read(key) {
      b.reads++;
      if (b.failNextRead > 0) { b.failNextRead--; throw new Error("network down"); }
      if (opts.readDelay) await new Promise((r) => setTimeout(r, opts.readDelay));
      const row = store.get(key);
      return row ? { payload: JSON.parse(JSON.stringify(row.payload)), revision: row.revision }
                 : { payload: {}, revision: 0 };
    },
    async saveDay(key, dateStr, day, expectedRevision) {
      b.writes++;
      const row = store.get(key) || { payload: {}, revision: 0 };
      if (row.revision !== expectedRevision) {
        return { ok: false, conflict: true, payload: JSON.parse(JSON.stringify(row.payload)), revision: row.revision };
      }
      /* Date-level: only this key of the payload is touched, exactly as the
         dtr_save_day RPC does it. */
      const payload = { ...row.payload, [dateStr]: JSON.parse(JSON.stringify(day)) };
      const revision = row.revision + 1;
      store.set(key, { payload, revision });
      b.saved.push({ key, dateStr, revision });
      return { ok: true, revision };
    },
    peek: (key) => store.get(key)?.payload,
    rowRevision: (key) => store.get(key)?.revision,
  };
  return b;
}

const KEY = logKey("006178", 2026);
const OTHER = logKey("005582", 2026);

/* ---- case 1: still loading, user tabs through an untouched field ---- */
test("a blur on a field the user never touched writes nothing", async () => {
  const be = fixtureBackend({ [KEY]: SEED() }, { readDelay: 30 });
  const store = createRecordStore(be);
  store.ensureYear("006178", 2026); // load in flight, cell renders blank

  const rendered = store.peekDay("006178", "2026-09-07").amIn || ""; // "" — not loaded yet
  const typed = rendered; // user tabbed past, typed nothing
  assert.equal(isUntouched(rendered, typed), true, "an untouched box must be recognised as untouched");

  if (!isUntouched(rendered, typed)) await store.writeDay("006178", "2026-09-07", () => {});
  assert.equal(be.writes, 0, "zero writes");
  assert.deepEqual(be.peek(KEY), SEED(), "the stored year is untouched");
});

/* ---- case 2: write racing the load — the incident itself ---- */
test("a write that starts before the load finishes waits for the stored year and preserves it", async () => {
  const be = fixtureBackend({ [KEY]: SEED() }, { readDelay: 30 });
  const store = createRecordStore(be);
  store.ensureYear("006178", 2026); // in flight

  /* This is the 006178 sequence: an edit lands while the year is still arriving. */
  const res = await store.writeDay("006178", "2026-09-07", (d) => { d.otIn = "18:00"; });
  assert.equal(res.written, true);

  const stored = be.peek(KEY);
  assert.equal(stored["2026-09-07"].amIn, "07:55", "the existing punch survived");
  assert.equal(stored["2026-09-07"].otIn, "18:00", "and the edit applied");
  assert.deepEqual(stored["2026-09-08"], SEED()["2026-09-08"], "other dates untouched");
  assert.deepEqual(stored["2026-09-09"], SEED()["2026-09-09"], "other dates untouched");
});

/* ---- case 3: unchanged field ---- */
test("re-saving the same value writes nothing", async () => {
  const be = fixtureBackend({ [KEY]: SEED() });
  const store = createRecordStore(be);
  await store.ensureYear("006178", 2026);
  const res = await store.writeDay("006178", "2026-09-07", (d) => { d.amIn = "07:55"; });
  assert.equal(res.written, false);
  assert.equal(res.reason, "no-change");
  assert.equal(be.writes, 0);
});

/* ---- case 4: an intentional clear touches only what was cleared ---- */
test("clearing a loaded field changes only that field, and only that date", async () => {
  const be = fixtureBackend({ [KEY]: SEED() });
  const store = createRecordStore(be);
  await store.ensureYear("006178", 2026);
  const res = await store.writeDay("006178", "2026-09-07", (d) => { delete d.amIn; });
  assert.equal(res.written, true);

  const stored = be.peek(KEY);
  assert.equal("amIn" in stored["2026-09-07"], false, "the cleared field is gone");
  assert.equal(stored["2026-09-07"].pmOut, "17:05", "its siblings remain");
  assert.deepEqual(stored["2026-09-08"], SEED()["2026-09-08"], "other dates remain");
  assert.deepEqual(stored["2026-09-09"], SEED()["2026-09-09"], "other dates remain");
});

/* ---- case 5: cross-employee isolation ---- */
test("editing one employee never touches another employee's year", async () => {
  const be = fixtureBackend({ [KEY]: SEED(), [OTHER]: SEED() });
  const store = createRecordStore(be);
  await store.ensureYear("006178", 2026);
  await store.writeDay("006178", "2026-09-07", (d) => { d.amIn = "06:00"; });
  assert.deepEqual(be.peek(OTHER), SEED(), "the other employee's year is byte-for-byte unchanged");
  assert.equal(be.saved.every((s) => s.key === KEY), true, "no write was addressed to another key");
});

/* ---- case 6: switching employee/year mid-flight ---- */
test("a read that lands late cannot overwrite the record selected since", async () => {
  const be = fixtureBackend({ [KEY]: SEED(), [OTHER]: SEED() }, { readDelay: 40 });
  const store = createRecordStore(be);
  const slow = store.ensureYear("006178", 2026); // user opens 006178...
  await store.ensureYear("005582", 2026);        // ...then switches to 005582
  await store.writeDay("005582", "2026-09-08", (d) => { d.pmOut = "17:30" });
  await slow;                                     // the first read finally lands

  assert.equal(be.peek(OTHER)["2026-09-08"].pmOut, "17:30", "the newly selected record kept its edit");
  assert.equal(store.peekDay("005582", "2026-09-08").pmOut, "17:30", "and the cache was not clobbered");
  assert.deepEqual(be.peek(KEY), SEED(), "the abandoned record was not written at all");
});

/* ---- case 7: two edits close together ---- */
test("a stale copy of the year cannot overwrite a newer one — it re-reads and merges", async () => {
  const be = fixtureBackend({ [KEY]: SEED() });
  const tabA = createRecordStore(be);
  const tabB = createRecordStore(be);
  await tabA.ensureYear("006178", 2026);
  await tabB.ensureYear("006178", 2026); // both hold revision 1

  await tabA.writeDay("006178", "2026-09-07", (d) => { d.otIn = "18:00"; }); // revision 2
  const res = await tabB.writeDay("006178", "2026-09-08", (d) => { d.pmOut = "17:10"; });

  assert.equal(res.written, true);
  assert.ok(res.attempts > 1, "B had to re-read after losing the race");
  const stored = be.peek(KEY);
  assert.equal(stored["2026-09-07"].otIn, "18:00", "A's edit survived B's save");
  assert.equal(stored["2026-09-08"].pmOut, "17:10", "and B's edit landed");
  assert.equal(stored["2026-09-07"].amIn, "07:55", "nothing else moved");
});

test("a conflicting edit that is already satisfied by the newer copy writes nothing further", async () => {
  const be = fixtureBackend({ [KEY]: SEED() });
  const tabA = createRecordStore(be);
  const tabB = createRecordStore(be);
  await tabA.ensureYear("006178", 2026);
  await tabB.ensureYear("006178", 2026);
  await tabA.writeDay("006178", "2026-09-07", (d) => { d.otIn = "18:00"; });
  const res = await tabB.writeDay("006178", "2026-09-07", (d) => { d.otIn = "18:00"; });
  assert.equal(res.written, false, "after re-reading, B's edit is a no-op");
  assert.equal(res.reason, "no-change");
});

/* ---- case 8: read failure must fail closed ---- */
test("a failed read never invents an empty year and never saves one", async () => {
  const be = fixtureBackend({ [KEY]: SEED() }, { failNextRead: 1 });
  const store = createRecordStore(be);
  await assert.rejects(() => store.writeDay("006178", "2026-09-07", (d) => { d.amIn = "09:00"; }), /network down/);
  assert.equal(be.writes, 0, "no write was attempted");
  assert.equal(store.isLoaded(KEY), false, "the year is still considered unread");
  assert.deepEqual(be.peek(KEY), SEED(), "the stored year is intact");
});

test("after a failed read the next attempt re-reads rather than building on nothing", async () => {
  const be = fixtureBackend({ [KEY]: SEED() }, { failNextRead: 1 });
  const store = createRecordStore(be);
  await assert.rejects(() => store.ensureYear("006178", 2026));
  const res = await store.writeDay("006178", "2026-09-07", (d) => { d.otOut = "19:00"; });
  assert.equal(res.written, true);
  assert.equal(be.peek(KEY)["2026-09-07"].amIn, "07:55", "the real year was fetched on the retry");
});

/* ---- the incident, replayed end to end ---- */
test("replaying the exact 006178 sequence can no longer erase the year", async () => {
  const be = fixtureBackend({ [KEY]: SEED() }, { readDelay: 25 });
  const store = createRecordStore(be);

  /* 1. the logbook opens and starts loading every employee */
  store.ensureYear("006178", 2026);
  /* 2. cells render blank because nothing has arrived */
  const rendered = store.peekDay("006178", "2026-09-07").amIn || "";
  assert.equal(rendered, "", "the box really is blank at this moment — the trap");
  /* 3. the user tabs across the row, touching nothing */
  for (const slot of ["amIn", "amOut", "pmIn", "pmOut"]) {
    const shown = store.peekDay("006178", "2026-09-07")[slot] || "";
    if (!isUntouched(shown, shown)) await store.writeDay("006178", "2026-09-07", () => {});
  }
  /* 4. and the belt-and-braces half: even with the UI guard bypassed entirely,
        a write aimed at the still-loading year must read it back first rather
        than build one from nothing. This is the half that actually failed in
        production. */
  const res = await store.writeDay("006178", "2026-09-07", (d) => { d.amIn = "07:55"; });
  assert.equal(res.written, false, "re-sending what was already stored is a no-op");
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(be.writes, 0, "not one write was sent");
  assert.deepEqual(be.peek(KEY), SEED(), "the year is exactly as it was");
  assert.equal(be.rowRevision(KEY), 1, "the row was never even bumped");
});

/* ---- supporting behaviour ---- */
test("sameDay tells a real edit from a no-op", () => {
  assert.equal(sameDay({ a: "1" }, { a: "1" }), true);
  assert.equal(sameDay({ a: "1" }, { a: "2" }), false);
  assert.equal(sameDay({ a: "1" }, {}), false);
  assert.equal(sameDay({}, {}), true);
  assert.equal(sameDay({ src: { amIn: "punch" } }, { src: { amIn: "punch" } }), true);
  assert.equal(sameDay({ src: { amIn: "punch" } }, { src: { amIn: "manual" } }), false);
});

test("isUntouched compares what was rendered with what was typed", () => {
  assert.equal(isUntouched("", ""), true, "blank box, nothing typed");
  assert.equal(isUntouched("7:55", "7:55"), true, "value shown, nothing changed");
  assert.equal(isUntouched("7:55", ""), false, "user genuinely cleared it");
  assert.equal(isUntouched("", "8:00"), false, "user genuinely typed one");
});

test("a year is only reported loaded once it has really been read", async () => {
  const be = fixtureBackend({ [KEY]: SEED() }, { readDelay: 20 });
  const store = createRecordStore(be);
  assert.equal(store.isLoaded(KEY), false, "not loaded before the read");
  const p = store.ensureYear("006178", 2026);
  assert.equal(store.isLoaded(KEY), false, "still not loaded while in flight");
  await p;
  assert.equal(store.isLoaded(KEY), true);
});

test("concurrent callers share one read instead of racing", async () => {
  const be = fixtureBackend({ [KEY]: SEED() }, { readDelay: 20 });
  const store = createRecordStore(be);
  await Promise.all([
    store.ensureYear("006178", 2026), store.ensureYear("006178", 2026), store.ensureYear("006178", 2026),
  ]);
  assert.equal(be.reads, 1);
});

test("endless conflict gives up instead of forcing a write through", async () => {
  const be = fixtureBackend({ [KEY]: SEED() });
  /* a row that moves on under us every single time */
  const original = be.saveDay;
  be.saveDay = async (key) => {
    const cur = be.peek(key);
    return { ok: false, conflict: true, payload: cur, revision: Math.floor(Math.random() * 1e6) + 10 };
  };
  const store = createRecordStore(be);
  await store.ensureYear("006178", 2026);
  const res = await store.writeDay("006178", "2026-09-07", (d) => { d.otIn = "18:00"; });
  be.saveDay = original;
  assert.equal(res.written, false);
  assert.equal(res.reason, "conflict-retries-exhausted");
  assert.equal(res.attempts, MAX_SAVE_ATTEMPTS);
  assert.deepEqual(be.peek(KEY), SEED(), "and it left the stored year alone");
});
