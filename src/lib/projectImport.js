export const MASTER_START_YEAR = 2022;

export const normalizeText = (value) => String(value ?? "")
  .toUpperCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();

export const cleanText = (value) => value === null || value === undefined
  ? "" : String(value).replace(/\s+/g, " ").trim();

export function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[()]/g, "").replace(/[^0-9.-]/g, "");
  if (!text || text === "-" || text === ".") return null;
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return null;
  return /^\(/.test(String(value)) ? -parsed : parsed;
}

const LICENSE_NAMES = {
  "QM BUIDERS": "QM BUILDERS", QMB: "QM BUILDERS", "QM BUILDER": "QM BUILDERS",
  "QG DEVELOPMENT CORPORATION": "QG DEVELOPMENT CORP.",
  "ADAMANT DEVELOPMENT CORPORATION": "ADAMANT DEVELOPMENT CORP.",
};

const normalizeLicense = (value) => {
  const normalized = normalizeText(value);
  return LICENSE_NAMES[normalized] || normalized;
};

const normalizeStatus = (value) => normalizeText(value)
  .replace("ON-GOING", "ONGOING").replace("ON GOING", "ONGOING");

export const projectIdentity = (projectId, year) => {
  const id = normalizeText(projectId);
  return year ? `${id} - ${year}` : id;
};

export const displayProjectId = (projectId, year) => {
  const id = cleanText(projectId);
  return year ? `${id} - ${year}` : id;
};

/* ---------------- the one thing here that needs SheetJS ----------------
   Everything else in this module is plain data work, so importing xlsx at the
   top of the file dragged ~441 kB (125 kB gzipped) of parser into the startup
   chunk for every sign-in — including the majority of sign-ins that never touch
   a workbook. Worse, the static import silently defeated the dynamic import()
   in ProjectLedger: rolldown reported INEFFECTIVE_DYNAMIC_IMPORT and kept the
   library in the main chunk anyway.

   So the sheet reader is handed in instead. loadXlsx() registers it the moment
   the library finishes downloading, which is necessarily before any workbook
   object can exist to be read.
---------------------------------------------------------------------- */

let sheetToRows = null;

/* Called with XLSX.utils.sheet_to_json once the library is loaded. */
export function setWorkbookSheetReader(reader) {
  sheetToRows = typeof reader === "function" ? reader : null;
}

const sheetGrid = (workbook, name) => {
  /* Deliberately a throw and not an empty grid. An empty grid reads as "this
     workbook contained no projects", which merges as a dataset-wide deletion —
     exactly the silent-wipe failure the readiness rules exist to prevent. */
  if (!sheetToRows) throw new Error("Excel tools are not loaded yet — setWorkbookSheetReader was never called.");
  return sheetToRows(workbook.Sheets[name], { header: 1, raw: true, defval: "" });
};

const headerRow = (rows) => {
  for (let index = 0; index < Math.min(12, rows.length); index++)
    if ((rows[index] || []).some((cell) => normalizeText(cell).includes("PROJECT ID"))) return index;
  return 0;
};

const findColumn = (headers, exact = [], partial = []) => {
  for (const candidate of exact) {
    const index = headers.indexOf(normalizeText(candidate));
    if (index >= 0) return index;
  }
  for (const candidate of partial) {
    const terms = (Array.isArray(candidate) ? candidate : [candidate]).map(normalizeText);
    const index = headers.findIndex((header) => terms.every((term) => header.includes(term)));
    if (index >= 0) return index;
  }
  return -1;
};

const meaningful = (value) => value !== "" && value !== null && value !== undefined && value !== "-";

/* A workbook is identified by its sheet tab names and nothing else — never by
   the file name. One list answers both "can this file be read at all?" for the
   uploader and "which tab do I read?" here, so the guidance shown to the user
   can never drift from what the parser actually accepts. */
export const IMPORT_SHEET_RULES = [
  { key: "qmb_projects", label: "QMB PROJECTS", match: "QMB PROJECT" },
  { key: "qm_licenses", label: "QM LICENSES", match: "QM LICENSE" },
  { key: "collectibles", label: "COLLECTIBLES", match: "COLLECTIBLE" },
];

const ruleFor = (key) => IMPORT_SHEET_RULES.find((rule) => rule.key === key);
const matchesRule = (rule, sheetName) => normalizeText(sheetName).includes(rule.match);

export const findSheetName = (workbook, key) =>
  (workbook?.SheetNames || []).find((name) => matchesRule(ruleFor(key), name));

export function classifyWorkbookSheets(workbook) {
  const sheetNames = workbook?.SheetNames || [];
  const matched = {};
  for (const rule of IMPORT_SHEET_RULES) {
    const name = sheetNames.find((sheet) => matchesRule(rule, sheet));
    if (name) matched[rule.key] = name;
  }
  return {
    sheetNames, matched,
    unmatched: sheetNames.filter((sheet) => !IMPORT_SHEET_RULES.some((rule) => matchesRule(rule, sheet))),
    hasCollectibles: Boolean(matched.collectibles),
    hasMaster: Boolean(matched.qmb_projects || matched.qm_licenses),
    recognized: Object.keys(matched).length > 0,
  };
}

const sheetList = (names, limit = 8) => !names.length ? "(no sheets)"
  : names.length > limit ? `${names.slice(0, limit).join(", ")} … +${names.length - limit} more`
  : names.join(", ");

/* Rejecting a file silently is the worst outcome here: the upload appears to
   work, the ledger does not change, and nothing says why. Say what was found,
   what is accepted, and what to rename. */
export function unrecognizedWorkbookLog(fileName, sheetNames = []) {
  const labels = IMPORT_SHEET_RULES.map((rule) => rule.label).join(", ");
  const matches = IMPORT_SHEET_RULES.map((rule) => `"${rule.match}"`).join(", ");
  return [
    { warn: true, text: `${fileName}: no readable sheet — nothing from this file was imported and the ledger is unchanged` },
    { warn: true, text: `${fileName} has ${sheetNames.length} sheet tab${sheetNames.length === 1 ? "" : "s"}: ${sheetList(sheetNames)}` },
    { text: `Accepted sheet tab names: ${labels}. The file name itself is never checked — only the tab names inside it.` },
    { text: `A tab is accepted when its name contains ${matches}, so "QMB PROJECTS 2026" or "COLLECTIBLES AS OF JUNE" also work.` },
    { text: `Rename the sheet tab at the bottom of Excel (right-click › Rename), save the file, then upload it again.` },
    { text: `Each accepted tab still needs a PROJECT ID column, and ${ruleFor("qmb_projects").label} / ${ruleFor("qm_licenses").label} also need YEAR, within its first 12 rows.` },
  ];
}

function readMasterSheet(workbook, sheetName, source, currentYear) {
  const rows = sheetGrid(workbook, sheetName);
  const headerIndex = headerRow(rows);
  const headers = (rows[headerIndex] || []).map(normalizeText);
  const columns = {
    id: findColumn(headers, ["PROJECT ID"], ["PROJECT ID"]),
    year: findColumn(headers, ["YEAR", "PROJECT YEAR"], ["YEAR"]),
    district: findColumn(headers, ["DISTRICT"], ["DISTRICT"]),
    location: findColumn(headers, ["LOCATION"], ["LOCATION"]),
    category: findColumn(headers, ["PROJECT CATEGORY"], ["CATEGORY"]),
    engineer: findColumn(headers, ["SENIOR ENGINEER"], [["SENIOR", "ENGINEER"]]),
    name: findColumn(headers, ["PROJECT NAME"], ["PROJECT NAME"]),
    contract: findColumn(headers, ["CONTRACT AMOUNT/ REVISED", "CONTRACT AMOUNT", "CONTRACT COST"], ["CONTRACT AMOUNT"]),
    license: source === "qm_licenses"
      ? findColumn(headers, ["CONTRACTORS LICENSE"], [["CONTRACTOR", "LICENSE"]])
      : findColumn(headers, ["LICENSE"], ["LICENSE"]),
    status: findColumn(headers, ["PROJECT STATUS BASED ON ACTUAL", "STATUS"], [["PROJECT", "STATUS"]]),
    swa: findColumn(headers, ["SWA %"], ["SWA"]),
  };
  if (columns.id < 0) return { records: [], missingId: true, skippedYear: 0 };

  const records = [];
  let skippedYear = 0;
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    const rawId = cleanText(row[columns.id]);
    const baseKey = normalizeText(rawId);
    if (!baseKey || baseKey === "TOTAL") continue;
    const numericYear = numberOrNull(row[columns.year]);
    const year = numericYear === null ? null : Math.round(numericYear);
    if (!year || year < MASTER_START_YEAR || year > currentYear) {
      skippedYear++;
      continue;
    }
    const text = (column, transform = cleanText) => column < 0 ? "" : transform(row[column]);
    records.push({
      identity: projectIdentity(baseKey, year), baseKey, rawId, year, source,
      district: text(columns.district, normalizeText),
      license: text(columns.license, normalizeLicense),
      engineer: text(columns.engineer, normalizeText),
      category: text(columns.category, normalizeText),
      location: text(columns.location, normalizeText),
      name: text(columns.name, cleanText),
      status: text(columns.status, normalizeStatus),
      contract: columns.contract < 0 ? null : numberOrNull(row[columns.contract]),
      swa: columns.swa < 0 ? null : numberOrNull(row[columns.swa]),
    });
  }
  return { records, missingId: false, skippedYear };
}

const MASTER_FIELDS = ["district", "license", "engineer", "category", "location", "name", "status", "contract", "swa"];

const mergeMasterRecord = (existing, incoming, preferIncoming) => {
  const next = { ...(existing || {}), identity: incoming.identity, baseKey: incoming.baseKey,
    year: incoming.year, rawId: preferIncoming || !existing?.rawId ? incoming.rawId : existing.rawId,
    inQmb: Boolean(existing?.inQmb || incoming.source === "qmb_projects"),
    inLicenses: Boolean(existing?.inLicenses || incoming.source === "qm_licenses") };
  for (const field of MASTER_FIELDS)
    if (meaningful(incoming[field]) && (preferIncoming || !meaningful(next[field]))) next[field] = incoming[field];
  return next;
};

/* One project-year already in the ledger, refreshed from a newer workbook.
   Distinct from mergeMasterRecord above, which combines the two sheets of a
   single workbook and reads `source` off a raw row: by the time a record
   reaches here it has already been through that step and carries inQmb /
   inLicenses instead of a source, so reusing it would silently clear both. */
const refreshMasterRecord = (existing, incoming) => {
  /* `manualValues` are hand-typed and outrank the workbook on screen, but they
     are NOT written into the fields below and never mask them. This is the same
     separation Status, Contract and Remarks have always had, and it is what
     makes both halves of the requirement possible at once: the workbook's own
     value keeps moving here, so a change to it is still a change and still
     produces an "Excel updated" audit row, while the panel goes on showing what
     the person typed. Freezing the typed value into the field would show the
     right thing and destroy the workbook's history — the audit would have
     nothing to compare and would fall silent. */
  const handEntered = existing.manualValues || null;
  const next = { ...incoming,
    inQmb: Boolean(existing.inQmb || incoming.inQmb),
    inLicenses: Boolean(existing.inLicenses || incoming.inLicenses),
    manualEntry: Boolean(existing.manualEntry),
    ...(handEntered ? { manualValues: handEntered } : {}) };

  let kept = 0;
  for (const field of MASTER_FIELDS) {
    /* Counted where the workbook now disagrees with what somebody typed, so the
       import log can say the value on screen is not the one just imported. */
    if (handEntered && meaningful(handEntered[field]) && meaningful(incoming[field])
        && String(incoming[field]) !== String(handEntered[field])) kept++;
    /* A blank cell is not a value. The newer workbook wins every field it
       actually supplies, and leaves the rest as they were, so a sheet that omits
       a column cannot wipe that column for every project it happens to list. */
    if (!meaningful(next[field]) && meaningful(existing[field])) next[field] = existing[field];
  }
  return { record: next, kept };
};

/** Fold a freshly read workbook into the projects the ledger already holds.
 *
 *  An import used to replace the master map outright. That made every upload a
 *  reset: a workbook listing only the current year removed every project the
 *  previous workbook had supplied, and removed them silently, because a row
 *  that ceases to exist has not "changed" and so produces no audit entry. An
 *  upload is an update, not a replacement. What the new workbook names is
 *  refreshed; what it does not name is left exactly as it was.
 *
 *  Consequence, stated because it is the price of the above: a project can no
 *  longer be removed by uploading a workbook without it. Restoring an earlier
 *  dataset from "Previous data" still replaces wholesale and is the way back.
 */
export function mergeMasterDimensions(existing, incoming) {
  const dim = new Map(existing instanceof Map ? existing : []);
  let added = 0, updated = 0, keptManual = 0;
  for (const [identity, record] of incoming instanceof Map ? incoming : []) {
    const current = dim.get(identity);
    if (current) {
      const { record: merged, kept } = refreshMasterRecord(current, record);
      dim.set(identity, merged);
      keptManual += kept;
      updated++;
    } else { dim.set(identity, record); added++; }
  }
  return { dim, added, updated, keptManual, retained: dim.size - added - updated };
}

/* Collectibles rows are keyed the same way whether they have just been parsed
   or have come back out of the saved dataset, which stores them verbatim. */
const collectionKey = (row) => row?.sourceKey
  || projectIdentity(row?.baseKey || row?.key || row?.id, row?.year);

/** The same fold for the money side.
 *
 *  Replaces a matched row whole rather than field by field, deliberately: a
 *  Collectibles row is one coherent statement of a project's position, and a
 *  new gross beside a retained old net would be a figure that was never true on
 *  any date. Projects the new sheet does not mention keep their last statement.
 */
export function mergeCollectionRows(existing, incoming) {
  const rows = new Map();
  for (const row of existing || []) rows.set(collectionKey(row), row);
  let added = 0, updated = 0;
  for (const row of incoming || []) {
    const key = collectionKey(row);
    if (rows.has(key)) updated++; else added++;
    rows.set(key, row);
  }
  return { rows: [...rows.values()], added, updated, retained: rows.size - added - updated };
}

export function readMasterWorkbook(workbook, { currentYear = new Date().getFullYear() } = {}) {
  const dim = new Map();
  const log = [];
  for (const key of ["qmb_projects", "qm_licenses"]) {
    const rule = ruleFor(key);
    const sheetName = findSheetName(workbook, key);
    if (!sheetName) {
      log.push({ warn: true, text: `No ${rule.label} sheet tab in this file — that half was not read` });
      continue;
    }
    const result = readMasterSheet(workbook, sheetName, key, currentYear);
    if (result.missingId) {
      log.push({ warn: true, text: `${sheetName}: no PROJECT ID column found in its first 12 rows — nothing read from this tab` });
      continue;
    }
    for (const record of result.records) {
      const current = dim.get(record.identity);
      dim.set(record.identity, mergeMasterRecord(current, record, key === "qm_licenses"));
    }
    log.push({ text: `${sheetName}: ${result.records.length} projects from ${MASTER_START_YEAR}-${currentYear} read` });
    if (result.skippedYear) log.push({ text: `${sheetName}: ${result.skippedYear} rows outside ${MASTER_START_YEAR}-${currentYear} skipped` });
  }
  return { dim, log };
}

export function readCollectiblesWorkbook(workbook) {
  const log = [];
  const sheetName = findSheetName(workbook, "collectibles");
  if (!sheetName) return { rows: null, log: [{ warn: true, text: "No COLLECTIBLES sheet tab in this file — collections were not read" }] };
  const rows = sheetGrid(workbook, sheetName);
  const headerIndex = headerRow(rows);
  const headers = (rows[headerIndex] || []).map(normalizeText);
  const columns = {
    id: findColumn(headers, ["PROJECT ID#", "PROJECT ID"], ["PROJECT ID"]),
    year: findColumn(headers, ["YEAR", "PROJECT YEAR"], ["YEAR"]),
    office: findColumn(headers, ["IMPLEMENTING OFFICE"], ["IMPLEMENTING"]),
    contract: findColumn(headers, ["CONTRACT AMOUNT"], ["CONTRACT AMOUNT"]),
    billpct: findColumn(headers, ["BILLING %"], ["BILLING"]),
    gross: findColumn(headers, ["GROSS AMOUNT"], []),
    net: findColumn(headers, ["NET AMOUNT (CHECK AMOUNT)"], [["NET AMOUNT", "CHECK"]]),
    cg: findColumn(headers, ["COLLECTIBLE GROSS AMOUNT"], [["COLLECTIBLE", "GROSS"]]),
    cc: findColumn(headers, ["COLLECTIBLE CASH BAL"], [["COLLECTIBLE", "CASH"]]),
    cr: findColumn(headers, ["COLLECTIBLE RETENTION"], [["COLLECTIBLE", "RETENTION"]]),
    bal: findColumn(headers, [], [["BALANCE FOR COLLECTION"]]),
    netbal: findColumn(headers, [], [["NET BAL", "COLLECTION"]]),
    status: findColumn(headers, ["STATUS"], ["STATUS"]),
    remarks: findColumn(headers, ["REMARKS"], ["REMARKS"]),
  };
  if (columns.id < 0) return { rows: null, log: [{ warn: true, text: `${sheetName}: no PROJECT ID column found in its first 12 rows — nothing read from this tab` }] };

  const output = [];
  const seen = new Set();
  const numeric = (row, column) => column < 0 ? null : numberOrNull(row[column]);
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    const rawId = cleanText(row[columns.id]);
    const baseKey = normalizeText(rawId);
    if (!baseKey) continue;
    const numericYear = numeric(row, columns.year);
    const year = numericYear === null ? null : Math.round(numericYear);
    const sourceKey = projectIdentity(baseKey, year);
    if (seen.has(sourceKey)) continue;
    seen.add(sourceKey);
    output.push({
      key: baseKey, baseKey, sourceKey, id: rawId, year,
      office: cleanText(row[columns.office]) || "UNSPECIFIED",
      status: normalizeStatus(row[columns.status]), remarks: cleanText(row[columns.remarks]),
      contract: numeric(row, columns.contract), billpct: numeric(row, columns.billpct),
      gross: numeric(row, columns.gross), net: numeric(row, columns.net),
      cg: numeric(row, columns.cg), cc: numeric(row, columns.cc), cr: numeric(row, columns.cr),
      bal: numeric(row, columns.bal), netbal: numeric(row, columns.netbal),
    });
  }
  log.push({ text: `${sheetName}: ${output.length} projects read` });
  const missing = Object.entries(columns).filter(([key, index]) => key !== "year" && index < 0).map(([key]) => key);
  if (missing.length) log.push({ warn: true, text: `Columns not matched: ${missing.join(", ")}` });
  return { rows: output, log };
}

const normalizedMaster = (dim) => {
  const normalized = new Map();
  for (const [storedKey, value] of dim instanceof Map ? dim.entries() : []) {
    const baseKey = value?.baseKey || normalizeText(value?.rawId || storedKey);
    const identity = value?.identity || projectIdentity(baseKey, value?.year);
    normalized.set(identity, { ...value, identity, baseKey, rawId: value?.rawId || cleanText(storedKey) });
  }
  return normalized;
};

/* Master records grouped by base ID, newest year first. Extracted so that the
   rule deciding which project a yearless Collectibles row belongs to is written
   once: removing a project has to drop exactly the rows assembling it would
   have attached, and a second copy of this arithmetic would eventually disagree
   with the first. */
const indexMasterByBase = (master) => {
  const byBase = new Map();
  for (const value of master.values()) {
    if (!byBase.has(value.baseKey)) byBase.set(value.baseKey, []);
    byBase.get(value.baseKey).push(value);
  }
  for (const list of byBase.values()) list.sort((a, b) => (b.year || 0) - (a.year || 0));
  return byBase;
};

/* A Collectibles row carrying a year names its project outright. One without a
   year attaches to that base ID's newest master year, which is why this needs
   the master index and not just the row. */
const assignedCollectionIdentity = (row, byBase) => {
  const baseKey = row.baseKey || row.key || normalizeText(row.id);
  const candidates = byBase.get(baseKey) || [];
  return row.year ? projectIdentity(baseKey, row.year)
    : candidates[0]?.identity || projectIdentity(baseKey, null);
};

export function assembleProjects(collectionRows = [], masterDimensions = new Map()) {
  const master = normalizedMaster(masterDimensions);
  const byBase = indexMasterByBase(master);

  const collections = new Map();
  for (const row of collectionRows || []) {
    const identity = assignedCollectionIdentity(row, byBase);
    const baseKey = row.baseKey || row.key || normalizeText(row.id);
    if (!collections.has(identity)) collections.set(identity, { ...row, baseKey, assignedIdentity: identity });
  }

  const identities = new Set([...master.keys(), ...collections.keys()]);
  const latestByBase = new Map();
  for (const [baseKey, list] of byBase) if (list[0]) latestByBase.set(baseKey, list[0].identity);

  return [...identities].map((identity) => {
    const dimension = master.get(identity) || {};
    const collection = collections.get(identity);
    const baseKey = dimension.baseKey || collection?.baseKey || normalizeText(identity);
    const year = dimension.year || collection?.year || null;
    const rawId = dimension.rawId || collection?.id || baseKey;
    const row = {
      /* `id` carries the year and must keep carrying it: it is not a label, it
         is the join key. `projectKey(r.id)` produces project_targets.project_key,
         it is what `project_manual_updates.project_id` was written under, and it
         keys the drafts map and every audit row. Stripping the year from it
         would orphan every hand-typed value and every target in the database.
         `displayId` is the year-free spelling, and is for rendering only. */
      identity, baseKey, rawId, year, id: displayProjectId(rawId, year),
      displayId: cleanText(rawId),
      /* Carried through, not applied here: assembleProjects must keep producing
         the workbook's own view, because that is what the Excel audit diff
         compares. The overlay happens at render. */
      manualValues: dimension.manualValues || null,
      isLatestYear: latestByBase.get(baseKey) === identity,
      inQmb: Boolean(dimension.inQmb), inLicenses: Boolean(dimension.inLicenses),
      qmbOverlap: Boolean(dimension.inQmb && dimension.inLicenses),
      collectionAvailable: Boolean(collection),
      name: dimension.name || "",
      district: dimension.district || "UNSPECIFIED",
      license: dimension.license || "UNSPECIFIED",
      engineer: dimension.engineer || "UNASSIGNED",
      category: dimension.category || "UNSPECIFIED",
      location: dimension.location || "UNSPECIFIED",
      status: collection?.status || dimension.status || "UNSPECIFIED",
      swa: dimension.swa ?? null,
      office: collection?.office || "NONE",
      yearStr: year ? String(year) : "UNSPECIFIED",
      contract: collection?.contract ?? dimension.contract ?? null,
      billpct: collection?.billpct ?? null, gross: collection?.gross ?? null, net: collection?.net ?? null,
      cg: collection?.cg ?? null, cc: collection?.cc ?? null, cr: collection?.cr ?? null,
      bal: collection?.bal ?? null, netbal: collection?.netbal ?? null,
      remarks: collection?.remarks || "",
    };
    row._hay = [row.id, row.name, row.district, row.license, row.engineer, row.category,
      row.location, row.status, row.office, row.remarks].join(" ").toLowerCase();
    return row;
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** Remove one project from the imported dataset.
 *
 *  The counterpart to an additive import. Because imports no longer remove
 *  anything, a Project ID that was wrong in the workbook can only leave the
 *  ledger through here — the workbook can be corrected, but correcting it can
 *  no longer take the bad row with it.
 *
 *  Drops the master entry, every Collectibles row that assembles onto it, and
 *  any legacy assignment pointing at it. The Collectibles rows are matched by
 *  the identity `assembleProjects` would give them rather than by their own
 *  key, so a yearless row attached to this project goes with it instead of
 *  being left behind to resurrect the project as a collection-only row.
 *
 *  Pure: returns a new store and does not touch the one passed in.
 */
export function removeProjectFromStore(store, identity) {
  const master = normalizedMaster(store?.dim instanceof Map ? store.dim : new Map());
  const byBase = indexMasterByBase(master);

  const dim = new Map(store?.dim instanceof Map ? store.dim : []);
  const removedMaster = dim.delete(identity);

  const before = Array.isArray(store?.coll) ? store.coll : [];
  const coll = before.filter((row) => assignedCollectionIdentity(row, byBase) !== identity);

  const legacy = new Map();
  for (const [baseKey, assigned] of store?.legacy instanceof Map ? store.legacy : [])
    if (assigned !== identity) legacy.set(baseKey, assigned);

  return {
    store: { ...store, dim, coll, legacy },
    removedMaster,
    removedCollections: before.length - coll.length,
  };
}

/* The data-source label is the one-line answer to "where did what I am looking
   at come from", shown in the header and stored on every restore point. Each
   hand-made change appends to it, so without a limit it grows for as long as the
   ledger is used — a paragraph in the header, and a copy of that paragraph in
   every version row. Bounded here instead: the import it came from, a count of
   older changes, and the most recent few spelled out. */
const NOTE_SEPARATOR = " • ";
const EARLIER = /^\+(\d+) earlier changes?$/;

export function appendDatasetNote(label, note, keep = 3) {
  const [base, ...existing] = String(label ?? "").split(NOTE_SEPARATOR);
  let dropped = 0;
  const notes = [];
  for (const entry of existing) {
    const summary = EARLIER.exec(entry);
    if (summary) dropped += Number(summary[1]);
    else notes.push(entry);
  }
  notes.push(note);
  dropped += Math.max(0, notes.length - keep);
  return [base, ...(dropped ? [`+${dropped} earlier change${dropped === 1 ? "" : "s"}`] : []), ...notes.slice(-keep)]
    .join(NOTE_SEPARATOR);
}

/** A project typed in by hand rather than read from a workbook.
 *
 *  Built through the same normalisers the readers use — same uppercasing, same
 *  licence spellings, same identity — so a typed project and an imported one are
 *  the same kind of thing. If they were not, a later workbook naming this
 *  project would not match it and would add a second row beside it.
 *
 *  `swa` is expected as the stored fraction (0.101 for 10.1%), not as the
 *  percentage anybody types; converting is the caller's job because the panel
 *  already owns that conversion.
 *
 *  Returns { ok: false, error } rather than throwing: every caller here is a
 *  form, and a form wants the sentence to print.
 */
export function buildManualProject(input, { currentYear = new Date().getFullYear() } = {}) {
  const rawId = cleanText(input?.projectId);
  const baseKey = normalizeText(rawId);
  if (!baseKey) return { ok: false, error: "Project ID is required." };

  const numericYear = numberOrNull(input?.year);
  const year = numericYear === null ? null : Math.round(numericYear);
  if (!year) return { ok: false, error: "Year is required." };
  /* The same window the readers accept. A year outside it would produce a row
     no workbook could ever have supplied, and which a re-import would never
     refresh — visible, unmatched and unexplained. */
  if (year < MASTER_START_YEAR || year > currentYear) {
    return { ok: false, error: `Year must be between ${MASTER_START_YEAR} and ${currentYear}, the range an import accepts.` };
  }

  const contract = numberOrNull(input?.contract);
  if (contract !== null && contract < 0) return { ok: false, error: "Contract amount cannot be negative." };
  const swa = numberOrNull(input?.swa);
  if (swa !== null && swa < 0) return { ok: false, error: "SWA % cannot be negative." };

  const typed = {
    district: normalizeText(input?.district),
    license: normalizeLicense(input?.license),
    engineer: normalizeText(input?.engineer),
    category: normalizeText(input?.category),
    location: normalizeText(input?.location),
    name: cleanText(input?.name),
    status: normalizeStatus(input?.status),
    contract, swa,
  };
  /* Only the columns actually filled in. A blank one is not recorded, so the
     workbook stays free to supply it — which is what lets the form ask for two
     required fields and mean it. */
  const manualValues = {};
  for (const field of MASTER_FIELDS) if (meaningful(typed[field])) manualValues[field] = typed[field];

  return {
    ok: true,
    identity: projectIdentity(baseKey, year),
    manualFields: Object.keys(manualValues),
    record: {
      identity: projectIdentity(baseKey, year), baseKey, rawId, year,
      /* In neither workbook sheet, because it came from neither. The overlap
         marker reads these, and claiming otherwise would tell an admin the
         value had been reconciled against QM Licenses when nothing had. */
      inQmb: false, inLicenses: false,
      manualEntry: true,
      /* Deliberately NOT copied into district/name/... on this record. Those
         fields belong to the workbook and must stay empty until one supplies
         them, so that when one does it registers as a change and is audited.
         What the user typed lives here and is applied over the top at render,
         exactly as project_manual_updates values are. */
      ...(Object.keys(manualValues).length ? { manualValues } : {}),
    },
  };
}

/** Puts a hand-entered project into the imported dataset.
 *
 *  Refuses an identity that already exists rather than overwriting it: the ID
 *  and year together are what every target, audit row and manual value is filed
 *  under, so replacing one silently would re-point all of it at values nobody
 *  reconciled.
 */
export function addProjectToStore(store, record) {
  const dim = new Map(store?.dim instanceof Map ? store.dim : []);
  if (dim.has(record.identity)) {
    return { ok: false, error: `${displayProjectId(record.rawId, record.year)} already exists in the ledger. Edit it instead, or delete it first.` };
  }
  dim.set(record.identity, record);
  return { ok: true, store: { ...store, dim } };
}

/** Project IDs that appear on more than one row.
 *
 *  The ID column shows the year-free spelling, so a project running in 2022 and
 *  again in 2025 renders the same text twice and looks like a duplicate — and a
 *  genuinely mistyped ID looks exactly the same. Only the years tell them
 *  apart, which is why each group carries them.
 *
 *  Grouped on `baseKey`, the normalised form, so IDs differing only by case or
 *  by an apostrophe are still recognised as the same ID. That is the whole
 *  point: those are the duplicates nobody spots by eye.
 */
export function duplicateProjectIds(rows) {
  const byBase = new Map();
  for (const row of rows || []) {
    const key = row?.baseKey || normalizeText(row?.displayId || row?.id);
    if (!key) continue;
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(row);
  }

  const groups = [];
  const identities = new Set();
  for (const [baseKey, list] of byBase) {
    if (list.length < 2) continue;
    for (const row of list) identities.add(row.identity);
    groups.push({
      baseKey,
      displayId: list[0].displayId || list[0].id || baseKey,
      count: list.length,
      years: list.map((row) => row.year).sort((a, b) => (a || 0) - (b || 0)),
      /* Same ID, same year, twice over cannot come from the workbook readers —
         they key on ID and year — so it means two spellings normalised to one.
         Worth separating: it is the case that is always wrong. */
      repeatedYear: new Set(list.map((row) => row.year)).size !== list.length,
      identities: list.map((row) => row.identity),
    });
  }
  groups.sort((a, b) => b.count - a.count || a.displayId.localeCompare(b.displayId));
  return { groups, identities, rowCount: identities.size };
}

export function extendLegacyAssignments(existing, rows) {
  const next = new Map(existing instanceof Map ? existing : []);
  for (const row of rows || [])
    if (row.year && row.isLatestYear && !next.has(row.baseKey)) next.set(row.baseKey, row.identity);
  return next;
}

export function resolvedEntry(map, row, legacyAssignments) {
  if (!(map instanceof Map)) return undefined;
  const exact = map.get(normalizeText(row.id));
  if (exact !== undefined) return exact;
  if (legacyAssignments instanceof Map && legacyAssignments.get(row.baseKey) === row.identity)
    return map.get(row.baseKey);
  return undefined;
}

export const IMPORT_AUDIT_FIELDS = [
  /* Project name is audited because a workbook renaming a project is exactly
     the change somebody needs to find later, and on a hand-created project the
     typed name stays on screen — so this row is the only trace that the
     workbook ever said anything different. */
  ["name", "Project name"],
  ["district", "District"], ["license", "License"], ["engineer", "Senior engineer"],
  ["category", "Category"], ["location", "Location"], ["status", "Status"],
  ["contract", "Contract"], ["swa", "SWA %"], ["office", "Implementing office"],
  ["billpct", "Billed %"], ["net", "Collected (net)"], ["cg", "Balance works"],
  ["cr", "Retention"], ["bal", "Balance for collection"], ["netbal", "Net balance"],
];

const comparable = (value) => value === undefined || value === null || value === "" ? null : String(value);
const DERIVED_PLACEHOLDERS = new Set(["UNSPECIFIED", "UNASSIGNED", "NONE"]);

export function importedChanges(previousRows, nextRows) {
  const before = new Map((previousRows || []).map((row) => [normalizeText(row.id), row]));
  const changes = [];
  for (const row of nextRows || []) {
    const old = before.get(normalizeText(row.id));
    for (const [fieldKey, label] of IMPORT_AUDIT_FIELDS) {
      const oldValue = comparable(old?.[fieldKey]);
      const newValue = comparable(row[fieldKey]);
      if (oldValue === newValue || (!old && (newValue === null || DERIVED_PLACEHOLDERS.has(newValue)))) continue;
      changes.push({ project_id: row.id, field_key: fieldKey, column_name: label,
        old_value: oldValue, new_value: newValue });
    }
  }
  return changes;
}
