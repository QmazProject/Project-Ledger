/* Saved bio log uploads, against an in-memory stand-in for the dtr_bio_logs table —
   never Supabase. It enforces what the migration does: rows are only ever added or
   marked cleared, never deleted, and a cleared row cannot be cleared again. */

import test from "node:test";
import assert from "node:assert/strict";
import { createBioLogStore, bioRowFor, activeBioUpload, bioStoreNotSetUp, BIO_NOT_SET_UP } from "./bioLogStore.js";

function fakeClient({ missing = false } = {}) {
  const rows = [];
  let clock = 0;
  const calls = [];
  const missingError = { code: "PGRST205", message: "Could not find the table 'public.dtr_bio_logs' in the schema cache" };
  function query(table) {
    const filters = [];
    let op = "select", payload = null, order = null, single = false;
    const run = () => {
      calls.push(op);
      if (missing) return { data: null, error: missingError };
      if (op === "insert") {
        const row = { id: `r${rows.length + 1}`, created_at: `t${++clock}`, cleared_at: null, cleared_by_id: "", cleared_by_name: "", ...payload };
        rows.push(row);
        return { data: single ? { ...row } : [{ ...row }], error: null };
      }
      let hit = rows.filter((r) => filters.every(([k, v, how]) => (how === "is" ? r[k] === v : r[k] === v)));
      if (op === "update") {
        hit.forEach((r) => { r.cleared_at = `t${++clock}`; r.cleared_by_id = payload.cleared_by_id; r.cleared_by_name = payload.cleared_by_name; });
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (order) hit = [...hit].sort((a, b) => (order.ascending ? 1 : -1) * a[order.col].localeCompare(b[order.col], undefined, { numeric: true }));
      return { data: hit.map((r) => ({ ...r })), error: null };
    };
    const b = {
      select() { return b; },
      insert(p) { op = "insert"; payload = p; return b; },
      update(p) { op = "update"; payload = p; return b; },
      delete() { throw new Error("rows are never deleted"); },
      eq(k, v) { filters.push([k, v, "eq"]); return b; },
      is(k, v) { filters.push([k, v, "is"]); return b; },
      order(col, o) { order = { col, ascending: o.ascending }; return b; },
      single() { single = true; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    assert.equal(table, "dtr_bio_logs");
    return b;
  }
  return { from: query, rows, calls };
}

const SEP = { start: "2026-09-13", end: "2026-09-27" };
const OCT = { start: "2026-09-28", end: "2026-10-12" };
const emp = { id: "006571", name: "Test Person" };
const tap = (date, time, kind) => ({ id: "6571", rawId: "6571", date, time, kind, code: kind === "in" ? "0" : "1", raw: `6571\t${date} ${time}` });

test("a save sends one employee's taps for one period, and nothing else", () => {
  const row = bioRowFor({
    employee: emp, period: SEP, fileName: "A3B7233860061_attlogs.dat", deviceSerial: "A3B7233860061",
    range: { first: "2026-08-28", last: "2026-09-28" },
    taps: [{ ...tap("2026-09-15", "07:51", "in"), extra: "dropped" }],
  });
  assert.deepEqual(row, {
    employee_id: "006571", payroll_start: "2026-09-13", payroll_end: "2026-09-27",
    file_name: "A3B7233860061_attlogs.dat", device_serial: "A3B7233860061",
    file_first: "2026-08-28", file_last: "2026-09-28",
    taps: [tap("2026-09-15", "07:51", "in")],
    uploaded_by_id: "006571", uploaded_by_name: "Test Person",
  });
});

test("saves are history: newest first, each period on its own, the newest compared", async () => {
  const client = fakeClient();
  const store = createBioLogStore(client);
  await store.save(bioRowFor({ employee: emp, period: SEP, fileName: "first.dat", taps: [tap("2026-09-15", "07:51", "in")] }));
  await store.save(bioRowFor({ employee: emp, period: OCT, fileName: "october.dat", taps: [] }));
  await store.save(bioRowFor({ employee: emp, period: SEP, fileName: "second.dat", taps: [tap("2026-09-15", "07:49", "in")] }));
  const sep = await store.list("006571", SEP);
  assert.equal(sep.state, "ok");
  assert.deepEqual(sep.items.map((r) => r.file_name), ["second.dat", "first.dat"]);
  assert.equal(activeBioUpload(sep.items).file_name, "second.dat");
  assert.deepEqual((await store.list("006571", OCT)).items.map((r) => r.file_name), ["october.dat"]);
  assert.deepEqual((await store.list("007080", SEP)).items, [], "another employee sees none of it");
});

test("clearing marks the newest upload cleared, keeps it in history, and happens once", async () => {
  const client = fakeClient();
  const store = createBioLogStore(client);
  const saved = await store.save(bioRowFor({ employee: emp, period: SEP, fileName: "a.dat", taps: [] }));
  const cleared = await store.clear(saved.id, emp);
  assert.ok(cleared.cleared_at);
  assert.equal(cleared.cleared_by_id, "006571");
  const { items } = await store.list("006571", SEP);
  assert.equal(items.length, 1, "nothing was deleted");
  assert.equal(activeBioUpload(items), null, "a cleared upload is not compared");
  await assert.rejects(store.clear(saved.id, emp), /already cleared/);
  assert.ok(!client.calls.includes("delete"));
});

test("before the migration is run, saving says so and listing reports it", async () => {
  const store = createBioLogStore(fakeClient({ missing: true }));
  assert.equal((await store.list("006571", SEP)).state, "not-set-up");
  await assert.rejects(store.save(bioRowFor({ employee: emp, period: SEP, taps: [] })), { message: BIO_NOT_SET_UP });
  assert.equal(bioStoreNotSetUp({ code: "42P01", message: "relation \"public.dtr_bio_logs\" does not exist" }), true);
  assert.equal(bioStoreNotSetUp({ code: "23505", message: "duplicate key" }), false);
});
