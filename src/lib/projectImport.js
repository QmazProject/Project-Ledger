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

const mergeMasterRecord = (existing, incoming, preferIncoming) => {
  const next = { ...(existing || {}), identity: incoming.identity, baseKey: incoming.baseKey,
    year: incoming.year, rawId: preferIncoming || !existing?.rawId ? incoming.rawId : existing.rawId,
    inQmb: Boolean(existing?.inQmb || incoming.source === "qmb_projects"),
    inLicenses: Boolean(existing?.inLicenses || incoming.source === "qm_licenses") };
  for (const field of ["district", "license", "engineer", "category", "location", "name", "status", "contract", "swa"])
    if (meaningful(incoming[field]) && (preferIncoming || !meaningful(next[field]))) next[field] = incoming[field];
  return next;
};

export function readMasterWorkbook(workbook, { currentYear = new Date().getFullYear() } = {}) {
  const dim = new Map();
  const log = [];
  const definitions = [
    { source: "qmb_projects", label: "QMB Projects", test: (name) => name.includes("QMB PROJECT") },
    { source: "qm_licenses", label: "QM Licenses", test: (name) => name.includes("QM LICENSE") },
  ];
  for (const definition of definitions) {
    const sheetName = workbook.SheetNames.find((name) => definition.test(normalizeText(name)));
    if (!sheetName) {
      log.push({ warn: true, text: `Sheet for ${definition.label} not found` });
      continue;
    }
    const result = readMasterSheet(workbook, sheetName, definition.source, currentYear);
    if (result.missingId) {
      log.push({ warn: true, text: `${sheetName}: no Project ID column` });
      continue;
    }
    for (const record of result.records) {
      const current = dim.get(record.identity);
      dim.set(record.identity, mergeMasterRecord(current, record, definition.source === "qm_licenses"));
    }
    log.push({ text: `${sheetName}: ${result.records.length} projects from ${MASTER_START_YEAR}-${currentYear} read` });
    if (result.skippedYear) log.push({ text: `${sheetName}: ${result.skippedYear} rows outside ${MASTER_START_YEAR}-${currentYear} skipped` });
  }
  return { dim, log };
}

export function readCollectiblesWorkbook(workbook) {
  const log = [];
  const sheetName = workbook.SheetNames.find((name) => normalizeText(name).includes("COLLECTIBLE"));
  if (!sheetName) return { rows: null, log: [{ warn: true, text: "No sheet named COLLECTIBLES found" }] };
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
  if (columns.id < 0) return { rows: null, log: [{ warn: true, text: `${sheetName}: no Project ID column` }] };

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

export function assembleProjects(collectionRows = [], masterDimensions = new Map()) {
  const master = normalizedMaster(masterDimensions);
  const byBase = new Map();
  for (const value of master.values()) {
    if (!byBase.has(value.baseKey)) byBase.set(value.baseKey, []);
    byBase.get(value.baseKey).push(value);
  }
  for (const list of byBase.values()) list.sort((a, b) => (b.year || 0) - (a.year || 0));

  const collections = new Map();
  for (const row of collectionRows || []) {
    const baseKey = row.baseKey || row.key || normalizeText(row.id);
    const candidates = byBase.get(baseKey) || [];
    const identity = row.year ? projectIdentity(baseKey, row.year)
      : candidates[0]?.identity || projectIdentity(baseKey, null);
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
