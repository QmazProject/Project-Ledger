/* Saved bio log uploads (public.dtr_bio_logs), one row per upload: one employee's taps
   for one payroll period — never the device file, which holds every employee.

   The table is append-only. Saving adds a row and the newest row is the one compared;
   older rows are history, to look at and download. Clearing marks the newest row
   cleared (the server stamps the time) and deletes nothing. These rows never touch a
   DTR record: only taking bio times into a day does, through the DTR's own save.

   The client is passed in, so the tests run against a fake and never against Supabase. */

export const BIO_LOG_TABLE = "dtr_bio_logs";
const COLUMNS = "id,employee_id,payroll_start,payroll_end,file_name,device_serial,file_first,file_last,taps,"
  + "uploaded_by_id,uploaded_by_name,created_at,cleared_at,cleared_by_id,cleared_by_name";

export const BIO_NOT_SET_UP = "Bio log saving isn't set up yet. Run the dtr_bio_logs migration on Supabase.";

/* the table is missing: the migration has not been run on this project */
export const bioStoreNotSetUp = (error) => !!error && (error.code === "42P01" || error.code === "PGRST205"
  || (/dtr_bio_logs/.test(error.message || "") && /does not exist|could not find|schema cache/i.test(error.message || "")));

const failure = (error, fallback) => new Error(bioStoreNotSetUp(error) ? BIO_NOT_SET_UP : (error && error.message) || fallback);

/* the row a save sends: who, which period, what file, and only these taps */
export function bioRowFor({ employee, actor, period, fileName, deviceSerial, range, taps }) {
  return {
    employee_id: String(employee.id),
    payroll_start: period.start,
    payroll_end: period.end,
    file_name: String(fileName || ""),
    device_serial: String(deviceSerial || ""),
    file_first: range ? range.first : null,
    file_last: range ? range.last : null,
    taps: (taps || []).map((t) => ({ id: t.id, rawId: t.rawId, date: t.date, time: t.time, kind: t.kind, code: t.code, raw: t.raw })),
    uploaded_by_id: String((actor && actor.id) || employee.id),
    uploaded_by_name: String((actor && actor.name) || employee.name || ""),
  };
}

/* the upload a period is compared against: the newest, unless it was cleared */
export const activeBioUpload = (items) => (items && items[0] && !items[0].cleared_at ? items[0] : null);

export function createBioLogStore(client) {
  return {
    /* newest first; { items, state: "ok" | "not-set-up" | "error", error } */
    async list(employeeId, period) {
      try {
        const { data, error } = await client.from(BIO_LOG_TABLE).select(COLUMNS)
          .eq("employee_id", String(employeeId))
          .eq("payroll_start", period.start)
          .eq("payroll_end", period.end)
          .order("created_at", { ascending: false });
        if (error) return { items: [], state: bioStoreNotSetUp(error) ? "not-set-up" : "error", error: error.message || "" };
        return { items: Array.isArray(data) ? data : [], state: "ok", error: "" };
      } catch (e) {
        return { items: [], state: "error", error: (e && e.message) || "Could not load saved bio logs." };
      }
    },
    async save(row) {
      const { data, error } = await client.from(BIO_LOG_TABLE).insert(row).select(COLUMNS).single();
      if (error || !data) throw failure(error, "Could not save the bio logs.");
      return data;
    },
    /* only a row not already cleared; the server sets cleared_at itself */
    async clear(id, by) {
      const { data, error } = await client.from(BIO_LOG_TABLE)
        .update({ cleared_at: new Date().toISOString(), cleared_by_id: String((by && by.id) || ""), cleared_by_name: String((by && by.name) || "") })
        .eq("id", id).is("cleared_at", null).select(COLUMNS);
      if (error) throw failure(error, "Could not clear the bio logs.");
      if (!Array.isArray(data) || !data.length) throw new Error("That upload was already cleared.");
      return data[0];
    },
  };
}
