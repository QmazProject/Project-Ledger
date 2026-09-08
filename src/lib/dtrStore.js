/* The DTR record store: the one place that decides when a year may be written.

   `dtr_storage_dtr` keeps ONE ROW PER EMPLOYEE-YEAR, and that row's payload holds
   every date of the year. A write built from an unread or stale copy therefore does
   not lose a field — it loses the year. On 2026-09-08 that erased employee 006178's
   records, which had to be recovered from a backup. See docs/data-safety.md.

   The rules below exist because of that incident:
     - "cached" and "read back from storage" are separate facts, tracked separately;
     - a read that fails leaves the year UNLOADED and never invents an empty one;
     - a write that changes nothing is not sent;
     - writes name a single date, so a stale client cannot reach the other dates;
     - a save carries the revision it was built from, and a losing race re-reads and
       re-applies rather than overwriting.

   The backend is injected so every one of those paths is exercised against
   fixtures. Nothing here may be tested against production data. */

export const logKey = (id, year) => `dtr:log:${id}:${year}`;
export const yearOf = (dateStr) => Number(String(dateStr).slice(0, 4));

/* Day records are flat maps of short strings/numbers, so this is comparison enough
   to answer "did the edit actually change anything". */
export function sameDay(a, b) {
  const x = a || {};
  const y = b || {};
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) {
    const av = x[k];
    const bv = y[k];
    if (av && typeof av === "object") {
      if (!bv || typeof bv !== "object" || !sameDay(av, bv)) return false;
    } else if (av !== bv) return false;
  }
  return true;
}

const clone = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

/* An edit is only real if the box's contents differ from what was rendered into it.
   A cell that looked blank because its record had not arrived yet has typed ===
   rendered, and must never be mistaken for the user clearing the field. */
export const isUntouched = (rendered, typed) => String(rendered ?? "") === String(typed ?? "");

export const MAX_SAVE_ATTEMPTS = 4;

/**
 * backend must provide:
 *   read(key)  -> { payload, revision }   (throws on failure — never returns empty
 *                                          to mean "unknown")
 *   saveDay(key, dateStr, day, expectedRevision)
 *              -> { ok: true, revision }
 *               | { ok: false, conflict: true, payload, revision }
 */
export function createRecordStore(backend) {
  const cache = new Map(); //   key -> { payload, revision }
  const loaded = new Set(); //  keys genuinely read back from storage
  const inflight = new Map(); // key -> in-progress read

  const isLoaded = (key) => loaded.has(key);

  const put = (key, payload, revision) => {
    const held = cache.get(key);
    /* A read that resolves late must not undo a newer write that landed while it
       was in the air. */
    if (held && revision < held.revision) return held;
    const entry = { payload, revision };
    cache.set(key, entry);
    loaded.add(key);
    return entry;
  };

  async function ensureYear(id, year) {
    const key = logKey(id, year);
    if (loaded.has(key)) return cache.get(key).payload;
    if (inflight.has(key)) { await inflight.get(key); return cache.get(key)?.payload; }
    const p = (async () => {
      /* Fail closed. If the read throws, the year stays unloaded and uncached, so
         the next write re-reads instead of building on a year nobody has seen. */
      const res = await backend.read(key);
      put(key, res && res.payload ? res.payload : {}, res ? res.revision ?? 0 : 0);
    })();
    inflight.set(key, p);
    try { await p; } finally { inflight.delete(key); }
    return cache.get(key)?.payload;
  }

  /* Read-only view. Returns {} for a year nobody has loaded, which is why callers
     must never build a write from this — writeDay loads first. */
  const peekDay = (id, dateStr) => {
    const key = logKey(id, yearOf(dateStr));
    return (cache.get(key)?.payload || {})[dateStr] || {};
  };

  const revisionOf = (id, year) => cache.get(logKey(id, year))?.revision ?? null;

  /**
   * Apply `mutate` to one date and persist just that date.
   * Returns { written, reason, attempts, day }.
   */
  async function writeDay(id, dateStr, mutate) {
    const year = yearOf(dateStr);
    const key = logKey(id, year);

    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      /* Always against a year that has actually been read. */
      await ensureYear(id, year);
      const held = cache.get(key);
      if (!held) return { written: false, reason: "unloaded", attempts: attempt };

      const before = held.payload[dateStr] || {};
      const draft = clone(before);
      mutate(draft);

      if (sameDay(before, draft)) return { written: false, reason: "no-change", attempts: attempt, day: before };

      const res = await backend.saveDay(key, dateStr, draft, held.revision);
      if (res && res.ok) {
        const payload = { ...held.payload, [dateStr]: draft };
        put(key, payload, res.revision ?? held.revision + 1);
        return { written: true, reason: "saved", attempts: attempt, day: draft };
      }

      /* Somebody else moved the row on. Take their copy and re-apply this edit to
         it — never send ours over the top. */
      if (res && res.conflict) {
        cache.set(key, { payload: res.payload || {}, revision: res.revision ?? 0 });
        loaded.add(key);
        continue;
      }
      return { written: false, reason: "rejected", attempts: attempt };
    }
    return { written: false, reason: "conflict-retries-exhausted", attempts: MAX_SAVE_ATTEMPTS };
  }

  /* Only for tests and diagnostics. */
  const snapshot = () => ({ loaded: [...loaded], keys: [...cache.keys()] });

  return { ensureYear, writeDay, peekDay, isLoaded, revisionOf, snapshot };
}
