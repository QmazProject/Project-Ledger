import test from "node:test";
import assert from "node:assert/strict";
import {
  groupTargetHistory, actionLabel, isEventOnly, isBlankValue, EVENT_FIELD_KEY,
} from "./targetHistory.js";

/* Rows are written exactly as the database functions in
   20260814000000_project_target_rpc.sql emit them, so a change to the SQL that
   these tests do not follow shows up as a failure here rather than as a blank
   history in the modal. */
const row = (over) => ({
  id: Math.random().toString(36).slice(2),
  project_id: "PR-001",
  target_id: "t1",
  target_scope: "Roadworks",
  column_name: "Target qty",
  field_key: "target_qty",
  old_value: null,
  new_value: "100",
  action: "update",
  source: "target_modal",
  batch_id: "b1",
  changed_by: "u1",
  changed_by_username: "Ana",
  changed_at: "2026-08-10T09:00:00.000Z",
  ...over,
});

/* create_project_target: one event row, then one row per non-null field. */
const creationRows = (over = {}) => [
  row({ field_key: EVENT_FIELD_KEY, column_name: "Target", action: "create",
        old_value: null, new_value: "Roadworks", ...over }),
  row({ field_key: "scope", column_name: "Scope", action: "create",
        old_value: null, new_value: "Roadworks", ...over }),
  row({ field_key: "target_qty", column_name: "Target qty", action: "create",
        old_value: null, new_value: "100", ...over }),
];

test("a creation reads as one event, not as edits from nothing", () => {
  const [event] = groupTargetHistory(creationRows());
  assert.equal(event.action, "create");
  assert.equal(event.fields.length, 2, "the event row is the heading, never a listed field");
  assert.deepEqual(event.fields.map((f) => f.fieldKey), ["scope", "target_qty"]);
  assert.equal(event.targetScope, "Roadworks");
  assert.equal(event.user, "Ana");
});

test("one save of several fields is one event", () => {
  const events = groupTargetHistory([
    row({ field_key: "unit", column_name: "Unit", old_value: "m", new_value: "km" }),
    row({ field_key: "target_qty", column_name: "Target qty", old_value: "100", new_value: "120" }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "update");
  assert.equal(events[0].fields.length, 2);
});

test("separate saves stay separate even at the same instant", () => {
  const events = groupTargetHistory([
    row({ batch_id: "b1", field_key: "unit", column_name: "Unit" }),
    row({ batch_id: "b2", field_key: "unit", column_name: "Unit" }),
  ]);
  assert.equal(events.length, 2, "batch_id decides the grouping, not the timestamp");
});

test("fields follow the modal's column order, not the order rows arrive in", () => {
  const events = groupTargetHistory([
    row({ field_key: "actual_output", column_name: "Actual output" }),
    row({ field_key: "actual_completion", column_name: "Actual completion" }),
    row({ field_key: "scope", column_name: "Scope" }),
    row({ field_key: "start_date", column_name: "Start date" }),
    row({ field_key: "target_qty", column_name: "Target qty" }),
  ]);
  assert.deepEqual(events[0].fields.map((f) => f.fieldKey),
    ["scope", "target_qty", "start_date", "actual_completion", "actual_output"]);
});

test("an unrecognised field is listed last rather than dropped", () => {
  const events = groupTargetHistory([
    row({ field_key: "actual_output", column_name: "Actual output" }),
    row({ field_key: "retired_column", column_name: "Retired column" }),
    row({ field_key: "scope", column_name: "Scope" }),
  ]);
  const keys = events[0].fields.map((f) => f.fieldKey);
  assert.deepEqual(keys, ["scope", "actual_output", "retired_column"]);
});

test("legacy rows with no batch group by target, instant and user", () => {
  const events = groupTargetHistory([
    row({ batch_id: null, source: "panel", field_key: "unit", column_name: "Unit",
          changed_at: "2026-07-01T08:00:00.000Z" }),
    row({ batch_id: null, source: "panel", field_key: "target_qty", column_name: "Target qty",
          changed_at: "2026-07-01T08:00:00.000Z" }),
    row({ batch_id: null, source: "panel", field_key: "unit", column_name: "Unit",
          changed_at: "2026-07-02T08:00:00.000Z" }),
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].changedAt, "2026-07-02T08:00:00.000Z", "newest first");
  assert.equal(events[1].fields.length, 2);
});

test("two users editing at the same instant are two events", () => {
  const events = groupTargetHistory([
    row({ batch_id: null, changed_by: "u1", changed_by_username: "Ana" }),
    row({ batch_id: null, changed_by: "u2", changed_by_username: "Ben" }),
  ]);
  assert.equal(events.length, 2);
});

test("archive and restore are headings with no field rows", () => {
  const events = groupTargetHistory([
    row({ batch_id: "b9", field_key: EVENT_FIELD_KEY, column_name: "Target", action: "archive",
          old_value: "Roadworks", new_value: null, changed_at: "2026-08-11T09:00:00.000Z" }),
    row({ batch_id: "b10", field_key: EVENT_FIELD_KEY, column_name: "Target", action: "restore",
          old_value: null, new_value: "Roadworks", changed_at: "2026-08-12T09:00:00.000Z" }),
  ]);
  assert.deepEqual(events.map((e) => e.action), ["restore", "archive"]);
  assert.ok(events.every(isEventOnly));
});

test("newest first", () => {
  const events = groupTargetHistory([
    row({ batch_id: "old", changed_at: "2026-01-01T00:00:00.000Z" }),
    row({ batch_id: "new", changed_at: "2026-09-09T00:00:00.000Z" }),
    row({ batch_id: "mid", changed_at: "2026-05-05T00:00:00.000Z" }),
  ]);
  assert.deepEqual(events.map((e) => e.batchId), ["new", "mid", "old"]);
});

test("a batch spanning several targets claims neither target nor scope", () => {
  const events = groupTargetHistory([
    row({ batch_id: "b1", target_id: "t1", target_scope: "Roadworks" }),
    row({ batch_id: "b1", target_id: "t2", target_scope: "Drainage" }),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].targetId, null);
  assert.equal(events[0].targetScope, null, "a shared save must not attribute one scope to both");
});

test("a batch is dated by its earliest row", () => {
  const events = groupTargetHistory([
    row({ batch_id: "b1", changed_at: "2026-08-10T09:00:02.000Z" }),
    row({ batch_id: "b1", changed_at: "2026-08-10T09:00:00.000Z" }),
  ]);
  assert.equal(events[0].changedAt, "2026-08-10T09:00:00.000Z");
});

test("an event with no action at all still renders as a change", () => {
  const events = groupTargetHistory([row({ action: null })]);
  assert.equal(events[0].action, "update", "the database writes 'update' for field rows; this is the floor, not a guess");
  assert.equal(actionLabel(events[0].action), "Updated");
});

test("an action added later reads as itself rather than as Unknown", () => {
  assert.equal(actionLabel("supersede"), "supersede");
  assert.equal(actionLabel(null), "Changed");
});

test("a missing username never renders as blank", () => {
  const events = groupTargetHistory([row({ changed_by_username: null })]);
  assert.equal(events[0].user, "Unknown user");
});

test("an unparseable timestamp does not throw or reorder everything", () => {
  const events = groupTargetHistory([
    row({ batch_id: "bad", changed_at: "not a date" }),
    row({ batch_id: "good", changed_at: "2026-08-10T09:00:00.000Z" }),
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].batchId, "good");
});

test("no rows, and junk in the list, are both survivable", () => {
  assert.deepEqual(groupTargetHistory([]), []);
  assert.deepEqual(groupTargetHistory(null), []);
  assert.equal(groupTargetHistory([null, undefined, row({})]).length, 1);
});

test("blank values are recognised however the column stored them", () => {
  assert.equal(isBlankValue(null), true);
  assert.equal(isBlankValue(undefined), true);
  assert.equal(isBlankValue(""), true);
  assert.equal(isBlankValue("   "), true);
  assert.equal(isBlankValue("0"), false, "zero is a value, not an absence");
});
