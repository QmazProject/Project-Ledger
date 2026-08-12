/* Reading a target's audit trail back as events.
 *
 * The audit table stores one row per changed field, and that granularity is
 * deliberate — the panel's per-cell history reads it that way. It is the wrong
 * shape to *read* a target's story in, though: one save of four fields is four
 * rows, and a creation is an event row plus one row for every value it was
 * created with. This module turns the rows back into the saves they came from,
 * without changing how they are stored.
 *
 * Pure on purpose: no React, no Supabase, no clock. Everything here is decided
 * by the rows passed in, so it can be tested directly.
 */

import { TARGET_HISTORY_FIELDS } from "./targets.js";

/* The event row a write function emits alongside its field rows. It carries the
 * action rather than a value, so it becomes the heading of a group and never a
 * listed field change. Must match the field_key written by
 * create_project_target and set_project_target_archived. */
export const EVENT_FIELD_KEY = "target";

/* Present tense on purpose: these label what happened, and the timestamp beside
 * them already says it is in the past. */
export const ACTION_LABEL = {
  create: "Created",
  update: "Updated",
  archive: "Archived",
  restore: "Restored",
};

/* Field order follows the modal's column order rather than the order rows come
 * back in, so a save always reads the same way as the form that produced it.
 * Anything unrecognised sorts after the known fields instead of being dropped —
 * an audit row is a historical fact, and hiding one because a column was later
 * renamed would be a lie by omission. */
const FIELD_ORDER = new Map(TARGET_HISTORY_FIELDS.map(([key], i) => [key, i]));
const fieldRank = (key) => (FIELD_ORDER.has(key) ? FIELD_ORDER.get(key) : TARGET_HISTORY_FIELDS.length);

const timeOf = (row) => {
  const t = Date.parse(row?.changed_at ?? "");
  return Number.isNaN(t) ? 0 : t;
};

/* Rows written before batch_id existed have none, so they are grouped by the
 * thing that actually identified a save at the time: one target, one instant,
 * one user. The old panel inserted a save's rows in a single statement, so they
 * share changed_at exactly. */
const groupKey = (row) =>
  row.batch_id
    ? `batch:${row.batch_id}`
    : `legacy:${row.target_id ?? ""}:${row.changed_at ?? ""}:${row.changed_by ?? ""}`;

/** Empty string, null and undefined all mean "no value" in the audit table;
 *  they are not distinguishable and should not pretend to be. */
export const isBlankValue = (v) => v === null || v === undefined || String(v).trim() === "";

/**
 * Groups audit rows into one entry per save, newest first.
 *
 * Returns `[{ key, batchId, targetId, targetScope, action, at, changedAt,
 *             user, source, fields: [{ fieldKey, label, from, to }] }]`.
 *
 * A group's action comes from its event row when there is one. Without an event
 * row — every legacy row, and every update — the action is taken from the field
 * rows, which the database sets to 'update'. It is never guessed.
 */
export function groupTargetHistory(rows) {
  const groups = new Map();

  for (const row of rows || []) {
    if (!row) continue;
    const key = groupKey(row);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        batchId: row.batch_id ?? null,
        targetId: row.target_id ?? null,
        targetScope: row.target_scope ?? null,
        action: null,
        at: timeOf(row),
        changedAt: row.changed_at ?? null,
        user: row.changed_by_username || "Unknown user",
        source: row.source ?? null,
        fields: [],
      };
      groups.set(key, group);
    }

    /* A batch spans several targets when one save touched several. The scope is
       kept per row for exactly that reason, so the group only claims one when
       every row agrees on it. */
    if (group.targetId !== (row.target_id ?? null)) group.targetId = null;
    if (group.targetScope !== (row.target_scope ?? null)) group.targetScope = null;
    /* The earliest row in a batch dates it: a group is one save, not a span. */
    const t = timeOf(row);
    if (t && (!group.at || t < group.at)) { group.at = t; group.changedAt = row.changed_at; }

    if (row.field_key === EVENT_FIELD_KEY) {
      group.action = row.action || group.action;
      continue;
    }
    if (!group.action && row.action) group.action = row.action;

    group.fields.push({
      fieldKey: row.field_key ?? null,
      /* column_name is the label as it was written at the time, which is what
         makes the history survive a column being renamed later. */
      label: row.column_name || row.field_key || "Field",
      from: row.old_value ?? null,
      to: row.new_value ?? null,
    });
  }

  const events = [...groups.values()];
  for (const event of events) {
    event.action = event.action || "update";
    event.fields.sort((a, b) => fieldRank(a.fieldKey) - fieldRank(b.fieldKey)
      || String(a.label).localeCompare(String(b.label)));
  }

  /* Newest first, matching every other history view here. Ties break on the key
     so the order is stable rather than dependent on insertion order. */
  events.sort((a, b) => b.at - a.at || String(a.key).localeCompare(String(b.key)));
  return events;
}

/** True when an event says something happened but lists no field change —
 *  an archive or a restore. The renderer shows the heading alone for these
 *  rather than an empty table. */
export const isEventOnly = (event) => !event.fields.length;

/** Human label for an action, falling back to the raw value rather than to
 *  "Unknown", so an action added later still reads as itself. */
export const actionLabel = (action) =>
  ACTION_LABEL[action] || (action ? String(action) : "Changed");
