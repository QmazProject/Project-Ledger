# DTR data safety

This document exists because on **2026-09-08 a year of a real employee's time records
was destroyed in production** by a frontend bug. Recovery required standing up a
temporary Supabase recovery project and restoring employee `006178` from a backup.

Read the storage model before touching anything that writes DTR data.

---

## 1. The storage model, and why one mistake is total

`public.dtr_storage_dtr` keeps **one row per employee-year**:

| column | meaning |
|---|---|
| `storage_key` | `dtr:log:<employee id>:<year>` — primary key |
| `payload` | **every date of that year**, as `{"2026-09-07": {...}, "2026-09-08": {...}}` |
| `revision` | optimistic-locking counter (added 2026-09-08) |
| `updated_at` | last write |

Three properties combine to make a single bad write catastrophic:

1. **The row is the whole year.** Historically the client sent the entire payload on
   every save. A save built from an empty or stale copy did not lose a field — it
   lost the year.
2. **There was no history.** `dtr_storage_dtr` had no journal, no versioning, no
   soft delete. An upsert was final, recoverable only from a platform backup.
3. **The device copy follows the cloud.** `sGet` writes the cloud payload into
   `localStorage` on every read, so a bad cloud write takes the offline copy with it.
   There is no second copy to fall back on.

The same row backs **both** the DTR sheet and the Staff Logbook. Wiping it empties
both, which is exactly how the incident presented.

## 2. What happened on 2026-09-08

The Staff Logbook renders an editable input for **every employee on the roster**, and
each employee-year loads asynchronously. The failing sequence:

1. The logbook opens; `ensureLog` begins fetching each employee's year.
2. Cells render **blank**, because no data has arrived yet.
3. The user tabs or clicks past one of those cells. The blur handler fires and calls
   `writeRec` **before the fetch returns**.
4. `writeRec` did `logsRef.current[k] = logsRef.current[k] || {}` — creating the year
   as an empty object.
5. That satisfied `ensureLog`'s "already loaded?" test, so the real year was **never
   fetched**.
6. `sSet` then upserted the empty object over the stored year.

### Root cause

Not the missing `await`. The cache used **one fact to answer two different questions**:

> "is there an entry in `logsRef`?" was standing in for both *do we have this in
> memory* and *have we read what is stored*.

A write could manufacture the first and thereby fake the second. Any design that
infers "loaded" from "present in cache" has this bug latent in it.

### Contributing cause

The feature had been verified extensively — page counts, millimetre geometry, column
widths, wrap detection, print headers, sort order across three paper sizes — and
**not one of those tests exercised a write**. Thorough verification in the dimension
that had tooling made the work feel checked while the destructive dimension went
untested. See §6.

## 3. Safeguards now in place

### Client — `src/lib/dtrStore.js`

Deliberately plain JavaScript, not JSX, so `npm test` (`node --test src/lib/`) can
reach it. The logic that failed used to live inside `dtr-system.jsx`, which the test
runner cannot import — that is *why* it was untested.

- **`loaded` is an explicit `Set`**, separate from the cache. Presence in the cache
  no longer implies anything about storage.
- **Reads fail closed.** A read error leaves the year unloaded and uncached. An empty
  year is never invented to stand in for an unknown one.
- **Writes load first.** `writeDay` awaits `ensureYear` before touching anything.
- **No-op writes are dropped.** If the mutation changes nothing, nothing is sent.
- **Writes name a single date.**
- **Conflicts re-read and re-apply**, never overwrite. Bounded retries; on exhaustion
  it gives up rather than forcing the write through.
- **Late reads cannot clobber newer state** — a lower revision never replaces a higher.

### UI — `DTR System/dtr-system.jsx`

- The blur handler compares against **what was rendered into the box**
  (`value === defaultValue`), so a cell that only looked blank because its record had
  not loaded cannot be mistaken for the user clearing the field.
- `writeRec` refuses to touch a year that is not in `loadedYears`.

### Database — `supabase/migrations/20260908000000_dtr_storage_safety.sql`

Applied at the database level **because a frontend bug is what caused the incident**,
so the frontend cannot be the only line of defence.

- `dtr_storage_dtr_history` — `history_id`, `storage_key`, `old_payload`,
  `new_payload`, `old_revision`, `new_revision`, `changed_at`, `changed_by`,
  `operation`. Written by an `AFTER UPDATE OR DELETE` trigger, so **the previous
  payload is captured no matter what the client does**. RLS allows `select` only;
  there is no insert/update/delete policy, so the journal cannot be forged or erased
  by a client — only the `SECURITY DEFINER` trigger writes it.
- `dtr_save_day(key, date, day, expected_revision)` — `jsonb_set`s **one date** and
  bumps `revision`, only if `expected_revision` still matches. A stale client
  physically cannot reach the other dates in the year. On mismatch it returns the
  current payload and revision so the caller can merge.
- `dtr_remove_day(...)` — same protections, for dropping a single date.
- `dtr_restore_key(key, history_id)` — recovery. Not granted to `anon`; recovery is a
  deliberate act from the SQL editor.

### Shared rows and offline edits — merge, never overwrite (2026-09-30)

Every row in `dtr_storage_dtr` is now written only through `dtr_save_year` with the
revision the change was built on. Nothing sends a device's whole copy blind any more.

- **Three-way merge.** A save diffs *base* (the copy this device last synced) against
  *local* (its edits) and applies only those changes to the *latest* stored row. Same
  field changed differently on both sides → the stored value (first accepted) is kept
  and the user is told; it is never re-sent. Bounded retries; exhaustion leaves the
  change queued, never forced. Shared loop: `src/lib/mergeSave.js`.
- **Roster** (`dtr:roster`) — per employee, per field: `src/lib/rosterSync.js`.
- **Settings** (`dtr:cfg`) — per setting; the AM pair and the PM pair of the schedule are
  atomic, and a merged schedule must still run in order: `src/lib/settingsSync.js`.
- **Offline DTR years** — per date, per field; a punch and its source mark are one
  value; a day whose leave/holiday status changed on either side is one value; totals
  are recalculated, never merged; a merged day that breaks the ordering / overnight-OT
  rules keeps the stored day: `src/lib/dtrYearSync.js`.
- **Offline queue.** A row that cannot be saved is kept on the device (`dtr.local.<key>`)
  with the copy it was edited from (`dtr.local.<key>:base`) and listed in `dtr.pending`.
  Reconnect merges it (`flushPending`). A queued row with no base (from an older
  version) is never uploaded: it is kept as `dtr.local.<key>:unsynced-backup` for review.
- **No writes on load.** Loading a year re-stamps totals on screen only; a save that
  changes nothing is not sent.

## 4. Recovery runbook

If DTR or logbook data looks wrong or missing:

```sql
-- 1. What happened to this key, most recent first
select history_id, operation, changed_at, changed_by,
       (select count(*) from jsonb_object_keys(old_payload)) as dates_before,
       (select count(*) from jsonb_object_keys(new_payload)) as dates_after
from public.dtr_storage_dtr_history
where storage_key = 'dtr:log:006178:2026'
order by changed_at desc
limit 20;

-- 2. Anything that lost dates is a suspect
select history_id, storage_key, changed_at,
       (select count(*) from jsonb_object_keys(old_payload)) as before,
       (select count(*) from jsonb_object_keys(new_payload)) as after
from public.dtr_storage_dtr_history
where storage_key like 'dtr:log:%'
  and (select count(*) from jsonb_object_keys(coalesce(new_payload,'{}'::jsonb)))
    < (select count(*) from jsonb_object_keys(coalesce(old_payload,'{}'::jsonb)))
order by changed_at desc;

-- 3. Inspect the payload you intend to restore before restoring it
select old_payload from public.dtr_storage_dtr_history where history_id = 1234;

-- 4. Restore. The restore is itself journalled, so it can be undone in turn.
select public.dtr_restore_key('dtr:log:006178:2026', 1234);
```

## 5. Pre-flight checklist — any feature that writes persistent data

Answer all of these **in writing** before calling such a feature complete. Rendering
tests and screenshots do not count.

1. **What does it read?**
2. **What does it write?** Which keys, which rows, whose records.
3. **How much does one incorrect write destroy?** For a store that saves whole
   aggregates, the answer is *everything in that aggregate*. Know the blast radius
   before shipping, not after.
4. **What happens if async loading has not completed?** Can a control be interacted
   with before its data arrives? What does the handler send then?
5. **What happens with stale or concurrent writes?** Two tabs, two devices, a slow
   response landing after a fast one.
6. **How is the change rolled back?** If it corrupts data, what is the recovery path
   and has it been tried?
7. **Which named automated test proves each destructive path is safe?** Cite the
   test. "It looked right" is not evidence.

Specific traps this codebase has already fallen into:

- A write aimed at a record **other than the signed-in user's**. `ensureLog`
  historically ran only for `me.id`; any surface touching other people's records must
  load them first.
- A change handler firing on a control the user **never touched**.
- Inferring "loaded" from "present in cache".

## 6. Testing rules

- **Never exercise destructive persistence against production.** The DTR's
  `.env.local` holds live Supabase credentials.
- Use injected fixtures. `dtrStore.test.js` supplies an in-memory backend; no test in
  this repository touches Supabase.
- Verify the **complete cycle**: read → edit → save → reload, and assert on what is
  *stored*, not only on what is displayed.
- When you fix a data-loss bug, **prove the test would have caught it** by running it
  against a reconstruction of the broken code. A test that passes on both versions
  proves nothing about the bug.

## 7. Related

- `src/lib/dtrStore.js`, `src/lib/dtrStore.test.js`
- `supabase/migrations/20260908000000_dtr_storage_safety.sql`
- `supabase/verification/20260908_dtr_storage_safety_verification.sql`
- `DTR System/dtr-system.jsx` — `ensureLog`, `writeRec`, `loadedYears`
