import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  MASTER_START_YEAR, readMasterWorkbook, readCollectiblesWorkbook, assembleProjects,
  extendLegacyAssignments, resolvedEntry, importedChanges,
} from "./projectImport.js";

const workbook = (sheets) => {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return book;
};

const masterBook = () => workbook({
  "QMB PROJECTS": [
    ["Project ID", "Year", "District", "License", "Senior Engineer", "Category", "Location", "Contract Amount"],
    ["QMB-001", 2021, "OLD", "QMB", "Old Engineer", "Old", "Old", 1],
    ["QMB-001", 2022, "QMB NORTH", "QMB", "QMB Engineer", "Road", "Cebu", 10_000_000],
    ["QMB-001", 2025, "QMB SOUTH", "QMB", "QMB Engineer", "Bridge", "Davao", 20_000_000],
    ["QMB-ONLY", 2024, "WEST", "QMB", "Builder", "Building", "Manila", 5_000_000],
  ],
  "QM LICENSES": [
    ["Project ID", "Year", "District", "Contractors License", "Senior Engineer", "Project Category", "Location", "Project Status Based on Actual", "Contract Amount"],
    ["QMB-001", 2025, "LICENSE SOUTH", "QG Development Corporation", "License Engineer", "Port", "Iloilo", "Ongoing", 25_000_000],
    ["LIC-ONLY", 2023, "EAST", "QM Builders", "License Only", "Water", "Bohol", "Completed", 3_000_000],
  ],
});

test("master consolidation keeps 2022-current, separates years, and lets QM LICENSES win", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });

  assert.equal(MASTER_START_YEAR, 2022);
  assert.equal(dim.has("QMB-001 - 2021"), false);
  assert.equal(dim.has("QMB-001 - 2022"), true);
  assert.equal(dim.has("QMB-001 - 2025"), true);
  const shared = dim.get("QMB-001 - 2025");
  assert.equal(shared.district, "LICENSE SOUTH");
  assert.equal(shared.engineer, "LICENSE ENGINEER");
  assert.equal(shared.license, "QG DEVELOPMENT CORP.");
  assert.equal(shared.contract, 25_000_000);
  assert.equal(shared.inQmb, true);
  assert.equal(shared.inLicenses, true);
});

test("master-only projects stay visible and the overlap marker means QMB also contains the identity", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const rows = assembleProjects([], dim);

  assert.deepEqual(rows.map((row) => row.id), ["LIC-ONLY - 2023", "QMB-001 - 2022", "QMB-001 - 2025", "QMB-ONLY - 2024"]);
  const shared = rows.find((row) => row.id === "QMB-001 - 2025");
  assert.equal(shared.qmbOverlap, true);
  assert.equal(shared.collectionAvailable, false);
  assert.equal(shared.office, "NONE");
  assert.equal(shared.net, null);
  assert.equal(rows.find((row) => row.id === "LIC-ONLY - 2023").qmbOverlap, false);
});

test("yearless Collectibles attaches once to the latest matching master year", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const collectibles = workbook({ COLLECTIBLES: [
    ["Project ID", "Contract Amount", "Net Amount (Check Amount)", "Balance for Collection", "Status"],
    ["QMB-001", 30_000_000, 12_000_000, 18_000_000, "Ongoing"],
  ] });
  const { rows: collectionRows } = readCollectiblesWorkbook(collectibles);
  const rows = assembleProjects(collectionRows, dim);
  const old = rows.find((row) => row.id === "QMB-001 - 2022");
  const latest = rows.find((row) => row.id === "QMB-001 - 2025");

  assert.equal(old.collectionAvailable, false);
  assert.equal(old.net, null);
  assert.equal(latest.collectionAvailable, true);
  assert.equal(latest.net, 12_000_000);
  assert.equal(latest.contract, 30_000_000, "Collectibles remains the base contract when present");
});

test("a Collectibles Year column performs an exact Project ID + Year match", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const collectibles = workbook({ COLLECTIBLES: [
    ["Project ID", "Year", "Net Amount (Check Amount)"],
    ["QMB-001", 2022, 2_000_000],
    ["QMB-001", 2025, 5_000_000],
  ] });
  const { rows: collectionRows } = readCollectiblesWorkbook(collectibles);
  const rows = assembleProjects(collectionRows, dim);

  assert.equal(rows.find((row) => row.id === "QMB-001 - 2022").net, 2_000_000);
  assert.equal(rows.find((row) => row.id === "QMB-001 - 2025").net, 5_000_000);
});

test("legacy Project-ID-only entries stay assigned to the latest year once", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const rows = assembleProjects([], dim);
  const assignments = extendLegacyAssignments(new Map(), rows);
  const manual = new Map([["QMB-001", { values: { status: "SUSPENDED" } }]]);
  const old = rows.find((row) => row.id === "QMB-001 - 2022");
  const latest = rows.find((row) => row.id === "QMB-001 - 2025");

  assert.equal(resolvedEntry(manual, old, assignments), undefined);
  assert.equal(resolvedEntry(manual, latest, assignments).values.status, "SUSPENDED");
  const futureRows = rows.concat([{ ...latest, identity: "QMB-001 - 2026", id: "QMB-001 - 2026", year: 2026, isLatestYear: true }]);
  const retained = extendLegacyAssignments(assignments, futureRows);
  assert.equal(retained.get("QMB-001"), "QMB-001 - 2025", "a later import must not move migrated history again");
});

test("Excel audit diff records changed fields only", () => {
  const before = [{ id: "QMB-001 - 2025", district: "NORTH", license: "QM BUILDERS", contract: 10 }];
  const after = [{ id: "QMB-001 - 2025", district: "SOUTH", license: "QM BUILDERS", contract: 12 }];
  const changes = importedChanges(before, after);

  assert.deepEqual(changes.map((change) => change.field_key), ["district", "contract"]);
  assert.deepEqual(changes[0], {
    project_id: "QMB-001 - 2025", field_key: "district", column_name: "District",
    old_value: "NORTH", new_value: "SOUTH",
  });
  assert.equal(importedChanges([], [{ id: "NEW - 2025", district: "UNSPECIFIED", office: "NONE" }]).length, 0,
    "derived placeholders are not claimed as values supplied by Excel");
});

/* The Senior engineer can now be typed over in the panel. The override lives in
   project_manual_updates and is merged in only at render, so an import neither
   sees it nor can overwrite it — but the workbook's own value still changed,
   and the audit trail has to say so. This diff reads the imported rows alone,
   which is exactly what makes both halves of that true at once. */
test("a changed Senior engineer is audited from the workbook, override or not", () => {
  const before = [{ id: "QMB-001 - 2025", engineer: "R. CRUZ" }];
  const after = [{ id: "QMB-001 - 2025", engineer: "L. DELA PENA" }];

  assert.deepEqual(importedChanges(before, after), [{
    project_id: "QMB-001 - 2025", field_key: "engineer", column_name: "Senior engineer",
    old_value: "R. CRUZ", new_value: "L. DELA PENA",
  }]);
  assert.deepEqual(importedChanges(before, before), [],
    "a workbook that repeats the same engineer records nothing");
});

test("a changed SWA % is audited from the workbook, override or not", () => {
  const changes = importedChanges(
    [{ id: "QMB-001 - 2025", swa: 0.55 }],
    [{ id: "QMB-001 - 2025", swa: 0.62 }],
  );

  assert.deepEqual(changes, [{
    project_id: "QMB-001 - 2025", field_key: "swa", column_name: "SWA %",
    old_value: "0.55", new_value: "0.62",
  }], "recorded as the stored fraction; the panel renders it as a percentage");
});

/* The ID shown on screen dropped its year, but the ID everything joins on did
   not. These are the assertions that keep those two apart: `projectKey(r.id)`
   is project_targets.project_key, and `r.id` is what project_manual_updates
   rows were written under, so a well-meaning "the display already has it,
   reuse that" would silently orphan every hand-typed value and every target
   for a project whose base ID repeats across years. */
test("displayId drops the year for display while id keeps it for joining", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const rows = assembleProjects([], dim);
  const y2022 = rows.find((row) => row.id === "QMB-001 - 2022");
  const y2025 = rows.find((row) => row.id === "QMB-001 - 2025");

  assert.equal(y2022.displayId, "QMB-001", "the year is not shown");
  assert.equal(y2025.displayId, "QMB-001");
  assert.equal(y2022.id, "QMB-001 - 2022", "the join key still carries the year");
  assert.notEqual(y2022.id, y2025.id, "two years remain distinct rows to the database");
  assert.equal(y2022.year, 2022, "and the year is still available to print in a tooltip");
  assert.equal(y2025.year, 2025);
});
