import * as XLSX from "xlsx";

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

const sheetGrid = (workbook, name) => XLSX.utils.sheet_to_json(workbook.Sheets[name], {
  header: 1, raw: true, defval: "",
});

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
  const next = { ...incoming,
    inQmb: Boolean(existing.inQmb || incoming.inQmb),
    inLicenses: Boolean(existing.inLicenses || incoming.inLicenses) };
  /* A blank cell is not a value. The newer workbook wins every field it
     actually supplies, and leaves the rest as they were, so a sheet that omits
     a column cannot wipe that column for every project it happens to list. */
  for (const field of MASTER_FIELDS)
    if (!meaningful(next[field]) && meaningful(existing[field])) next[field] = existing[field];
  return next;
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
  let added = 0, updated = 0;
  for (const [identity, record] of incoming instanceof Map ? incoming : []) {
    const current = dim.get(identity);
    if (current) { dim.set(identity, refreshMasterRecord(current, record)); updated++; }
    else { dim.set(identity, record); added++; }
  }
  return { dim, added, updated, retained: dim.size - added - updated };
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
