import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  MASTER_START_YEAR, normalizeText, readMasterWorkbook, readCollectiblesWorkbook, assembleProjects,
  extendLegacyAssignments, resolvedEntry, importedChanges,
  IMPORT_SHEET_RULES, classifyWorkbookSheets, unrecognizedWorkbookLog,
  mergeMasterDimensions, mergeCollectionRows, removeProjectFromStore, duplicateProjectIds,
  buildManualProject, addProjectToStore, appendDatasetNote, setWorkbookSheetReader,
} from "./projectImport.js";

/* projectImport does not import xlsx itself — that static import used to drag
   the whole parser into the browser startup chunk. In the app loadXlsx()
   registers this; here the test file plays that part, once, up front. */
setWorkbookSheetReader(XLSX.utils.sheet_to_json);

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

/* A workbook is accepted on its sheet tab names alone. The file name is never
   read, and a file with no recognised tab must be rejected with instructions
   rather than silently doing nothing. */
test("sheet tabs are matched by name fragment, and the file name is irrelevant", () => {
  const named = classifyWorkbookSheets(workbook({
    "QMB PROJECTS 2026": [["Project ID"]],
    "qm licenses (final)": [["Project ID"]],
    "Sheet1": [[]],
  }));

  assert.equal(named.recognized, true);
  assert.equal(named.hasMaster, true);
  assert.equal(named.hasCollectibles, false, "no COLLECTIBLES tab in this file");
  assert.equal(named.matched.qmb_projects, "QMB PROJECTS 2026", "trailing year still matches");
  assert.equal(named.matched.qm_licenses, "qm licenses (final)", "case and suffix are ignored");
  assert.deepEqual(named.unmatched, ["Sheet1"]);
});

test("a workbook with none of the three tabs is not recognised", () => {
  const stranger = classifyWorkbookSheets(workbook({ "Sheet1": [["Project ID", "Year"]], "Summary": [[]] }));

  assert.equal(stranger.recognized, false);
  assert.equal(stranger.hasMaster, false);
  assert.equal(stranger.hasCollectibles, false);
  assert.deepEqual(stranger.matched, {}, "a PROJECT ID column cannot rescue a tab with the wrong name");
  assert.deepEqual(classifyWorkbookSheets(undefined).sheetNames, [], "a missing workbook is not a crash");
});

test("the rejection message names every accepted tab and what the user should rename", () => {
  const lines = unrecognizedWorkbookLog("BUDGET 2026.xlsx", ["Sheet1", "Summary"]);
  const all = lines.map((line) => line.text).join("\n");

  assert.equal(lines[0].warn, true, "the first line reads as a failure, not a note");
  for (const rule of IMPORT_SHEET_RULES) assert.ok(all.includes(rule.label), `names ${rule.label}`);
  assert.ok(all.includes("BUDGET 2026.xlsx"), "says which file was rejected");
  assert.ok(all.includes("Sheet1, Summary"), "says which tabs it actually found");
  assert.ok(all.includes("ledger is unchanged"), "says nothing was overwritten");
  assert.ok(all.includes("file name itself is never checked"), "corrects the file-name assumption");
  assert.ok(all.includes("PROJECT ID"), "states the column still required after renaming");
});

test("a recognised tab with no PROJECT ID column says so instead of reporting zero projects", () => {
  const { log } = readMasterWorkbook(workbook({ "QMB PROJECTS": [["Name", "Year"], ["Road", 2025]] }), { currentYear: 2026 });
  const collectibles = readCollectiblesWorkbook(workbook({ "COLLECTIBLES": [["Office", "Status"]] }));

  assert.ok(log.some((line) => line.warn && line.text.includes("no PROJECT ID column")));
  assert.ok(log.some((line) => line.warn && line.text.includes("No QM LICENSES sheet tab")), "the absent half is reported too");
  assert.equal(collectibles.rows, null);
  assert.ok(collectibles.log[0].warn && collectibles.log[0].text.includes("no PROJECT ID column"));
});

/* An upload used to replace the master map outright, so a workbook covering
   one year deleted every project the previous workbook had supplied - silently,
   because a row that stops existing produces no audit entry. These pin the
   fold-in behaviour that replaced it. */
const laterBook = () => workbook({
  "QMB PROJECTS": [
    ["Project ID", "Year", "District", "License", "Senior Engineer", "Category", "Location", "Contract Amount"],
    ["QMB-001", 2025, "REVISED SOUTH", "QMB", "", "Bridge", "Davao", 21_000_000],
    ["BRAND-NEW", 2026, "NORTH", "QMB", "New Engineer", "Road", "Cebu", 7_000_000],
  ],
});

test("a later upload adds and updates without removing what it does not list", () => {
  const { dim: first } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { dim: second } = readMasterWorkbook(laterBook(), { currentYear: 2026 });
  const { dim, added, updated, retained } = mergeMasterDimensions(first, second);

  assert.equal(added, 1, "BRAND-NEW - 2026");
  assert.equal(updated, 1, "QMB-001 - 2025 appears in both");
  assert.equal(retained, first.size - 1, "everything else the new workbook never mentioned");

  assert.equal(dim.has("QMB-ONLY - 2024"), true, "absent from the new workbook, still in the ledger");
  assert.equal(dim.has("LIC-ONLY - 2023"), true);
  assert.equal(dim.has("QMB-001 - 2022"), true, "an earlier year of an updated project survives too");
  assert.equal(dim.get("QMB-ONLY - 2024").district, "WEST", "and keeps its values untouched");
  assert.equal(dim.has("BRAND-NEW - 2026"), true);
});

test("the newer workbook wins every field it supplies, and blanks overwrite nothing", () => {
  const { dim: first } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { dim: second } = readMasterWorkbook(laterBook(), { currentYear: 2026 });
  const { dim } = mergeMasterDimensions(first, second);
  const updatedRow = dim.get("QMB-001 - 2025");

  assert.equal(updatedRow.district, "REVISED SOUTH", "the new value replaces the old one");
  assert.equal(updatedRow.contract, 21_000_000);
  assert.equal(updatedRow.engineer, "LICENSE ENGINEER",
    "the new sheet left Senior Engineer blank, so the known value stands rather than being erased");
  assert.equal(updatedRow.inLicenses, true,
    "sheet membership learned from the first upload is not forgotten by the second");
});

test("merging is repeatable and order-independent for disjoint uploads", () => {
  const { dim: first } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { dim: second } = readMasterWorkbook(laterBook(), { currentYear: 2026 });

  const once = mergeMasterDimensions(first, second);
  const twice = mergeMasterDimensions(once.dim, second);
  assert.equal(twice.added, 0, "re-uploading the same workbook adds nothing");
  assert.equal(twice.dim.size, once.dim.size, "and removes nothing");

  assert.equal(mergeMasterDimensions(new Map(), second).dim.size, 2,
    "an empty ledger takes the whole workbook");
});

test("collectibles rows fold in the same way, replacing a matched row whole", () => {
  const before = [
    { sourceKey: "QMB-001 - 2025", baseKey: "QMB-001", id: "QMB-001", year: 2025, net: 5_000_000, gross: 9_000_000 },
    { sourceKey: "OLD-ONE - 2024", baseKey: "OLD-ONE", id: "OLD-ONE", year: 2024, net: 1_000_000 },
  ];
  const incoming = [
    { sourceKey: "QMB-001 - 2025", baseKey: "QMB-001", id: "QMB-001", year: 2025, net: 6_500_000 },
    { sourceKey: "NEW-ONE - 2026", baseKey: "NEW-ONE", id: "NEW-ONE", year: 2026, net: 2_000_000 },
  ];
  const { rows, added, updated, retained } = mergeCollectionRows(before, incoming);

  assert.deepEqual([added, updated, retained], [1, 1, 1]);
  const matched = rows.find((row) => row.sourceKey === "QMB-001 - 2025");
  assert.equal(matched.net, 6_500_000);
  assert.equal(matched.gross, undefined,
    "replaced whole: a new net beside a retained old gross was never true on any date");
  assert.equal(rows.find((row) => row.sourceKey === "OLD-ONE - 2024").net, 1_000_000, "kept");
  assert.equal(rows.length, 3);
});

test("a retained project produces no audit entry, and an updated one does", () => {
  const { dim: first } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { dim: second } = readMasterWorkbook(laterBook(), { currentYear: 2026 });
  const before = assembleProjects([], first);
  const after = assembleProjects([], mergeMasterDimensions(first, second).dim);
  const changes = importedChanges(before, after);

  assert.equal(changes.some((c) => c.project_id === "QMB-ONLY - 2024"), false,
    "a project nobody touched records nothing");
  /* Every field the later workbook supplied, and no others. Note what this
     says about precedence: QM LICENSES outranks QMB PROJECTS *within one
     upload*, but a later upload outranks an earlier one, so these values came
     from a QMB PROJECTS sheet and still replaced ones read from QM LICENSES.
     Engineer and status are absent because the later sheet left them blank. */
  assert.deepEqual(
    changes.filter((c) => c.project_id === "QMB-001 - 2025").map((c) => c.field_key).sort(),
    ["category", "contract", "district", "license", "location"],
    "only the fields the new workbook actually supplied a value for",
  );
  assert.equal(changes.some((c) => c.project_id === "QMB-001 - 2025" && c.field_key === "engineer"), false,
    "a blank cell changed nothing, so it is not recorded as a change");
});

/* Imports no longer remove anything, so a Project ID that was wrong in the
   workbook can only leave through removeProjectFromStore. These pin what it
   takes with it and, more importantly, what it leaves alone. */
test("removing a project drops its master entry and nothing else", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { store, removedMaster } = removeProjectFromStore({ dim, coll: [], legacy: new Map() }, "QMB-ONLY - 2024");

  assert.equal(removedMaster, true);
  assert.equal(store.dim.has("QMB-ONLY - 2024"), false);
  assert.equal(store.dim.size, dim.size - 1);
  assert.equal(dim.has("QMB-ONLY - 2024"), true, "the store passed in is not mutated");
  assert.deepEqual(
    assembleProjects([], store.dim).map((row) => row.id),
    ["LIC-ONLY - 2023", "QMB-001 - 2022", "QMB-001 - 2025"],
  );
});

test("a yearless Collectibles row goes with the project it attached to", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  /* No year, so assembleProjects attaches it to QMB-001's newest year, 2025.
     Matching on the row's own key would leave it behind, and the project would
     come straight back as a collection-only row. */
  const coll = [
    { key: "QMB-001", baseKey: "QMB-001", id: "QMB-001", year: null, net: 12_000_000 },
    { sourceKey: "LIC-ONLY - 2023", baseKey: "LIC-ONLY", id: "LIC-ONLY", year: 2023, net: 3_000_000 },
  ];
  assert.equal(assembleProjects(coll, dim).find((r) => r.id === "QMB-001 - 2025").net, 12_000_000,
    "it really did attach to 2025");

  const { store, removedCollections } = removeProjectFromStore({ dim, coll, legacy: new Map() }, "QMB-001 - 2025");

  assert.equal(removedCollections, 1);
  assert.equal(store.coll.length, 1);
  assert.equal(store.coll[0].baseKey, "LIC-ONLY", "the other project's money is untouched");
  const rows = assembleProjects(store.coll, store.dim);
  assert.equal(rows.some((row) => row.id === "QMB-001 - 2025"), false, "and it does not return as a collection-only row");
  assert.equal(rows.some((row) => row.id === "QMB-001 - 2022"), true, "the project's other year survives");
});

test("removing a project clears a legacy assignment pointing at it", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const legacy = new Map([["QMB-001", "QMB-001 - 2025"], ["LIC-ONLY", "LIC-ONLY - 2023"]]);
  const { store } = removeProjectFromStore({ dim, coll: [], legacy }, "QMB-001 - 2025");

  assert.equal(store.legacy.has("QMB-001"), false,
    "a stale assignment would re-adopt the old history if the ID were imported again");
  assert.equal(store.legacy.get("LIC-ONLY"), "LIC-ONLY - 2023", "other assignments stand");
});

test("removing a project that is not there changes nothing and does not throw", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { store, removedMaster, removedCollections } = removeProjectFromStore(
    { dim, coll: [], legacy: new Map() }, "NOT-A-PROJECT - 2099");

  assert.equal(removedMaster, false);
  assert.equal(removedCollections, 0);
  assert.equal(store.dim.size, dim.size);
  assert.equal(removeProjectFromStore(undefined, "X - 2025").store.dim.size, 0, "an absent store is not a crash");
});

/* The ID column shows the year-free spelling, so the same project in two years
   renders identical text — indistinguishable by eye from a mistyped ID. This is
   what the admin duplicate view reads. */
test("duplicate Project IDs group by normalised base ID and carry their years", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { groups, identities, rowCount } = duplicateProjectIds(assembleProjects([], dim));

  assert.equal(groups.length, 1, "only QMB-001 appears twice");
  assert.equal(groups[0].displayId, "QMB-001");
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].years, [2022, 2025], "sorted, so the pair reads in order");
  assert.equal(groups[0].repeatedYear, false, "two different years is legitimate, not an error");
  assert.equal(rowCount, 2);
  assert.deepEqual([...identities].sort(), ["QMB-001 - 2022", "QMB-001 - 2025"]);
  assert.equal(identities.has("QMB-ONLY - 2024"), false, "a unique ID is not in the set");
});

test("case and apostrophe differences are still the same Project ID", () => {
  /* The exact failure the normalised key exists for: three spellings that look
     different in the column but are one ID, which nobody spots by eye. */
  const rows = [
    { identity: "QMB-001 - 2025", baseKey: "QMB-001", displayId: "QMB-001", year: 2025 },
    { identity: "qmb-001 - 2024", baseKey: normalizeText("qmb-001"), displayId: "qmb-001", year: 2024 },
    { identity: "OTHER - 2025", baseKey: "OTHER", displayId: "OTHER", year: 2025 },
  ];
  const { groups } = duplicateProjectIds(rows);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2, "QMB-001 and qmb-001 are one ID");
  assert.equal(groups[0].baseKey, "QMB-001");
});

test("the same ID twice in one year is flagged separately", () => {
  const rows = [
    { identity: "QMB-001 - 2025", baseKey: "QMB-001", displayId: "QMB-001", year: 2025 },
    { identity: "QMB-001", baseKey: "QMB-001", displayId: "QMB-001", year: 2025 },
  ];
  const { groups } = duplicateProjectIds(rows);

  assert.equal(groups[0].repeatedYear, true,
    "the readers key on ID and year, so one year twice means two spellings collapsed into one");
});

test("no duplicates, and no rows, are both answered without throwing", () => {
  const unique = duplicateProjectIds([
    { identity: "A - 2025", baseKey: "A", displayId: "A", year: 2025 },
    { identity: "B - 2025", baseKey: "B", displayId: "B", year: 2025 },
  ]);
  assert.deepEqual(unique.groups, []);
  assert.equal(unique.rowCount, 0);
  assert.equal(duplicateProjectIds([]).groups.length, 0);
  assert.equal(duplicateProjectIds(undefined).groups.length, 0);
});

/* Imports add and update but never invent, so a project not yet in any workbook
   had no way into the ledger. These pin the hand-entry path — above all that a
   typed project is indistinguishable from an imported one afterwards, because
   otherwise a later workbook naming it would add a second row beside it. */
test("a hand-entered project is normalised exactly like an imported one", () => {
  const built = buildManualProject({
    projectId: " 26hd0023 ", year: "2026", name: "Barangay road  concreting",
    district: "qmb north", license: "QM Buiders", engineer: "j. santos",
    category: "road", location: "cebu", status: "on-going", contract: "12500000", swa: 0.101,
  }, { currentYear: 2026 });

  assert.equal(built.ok, true);
  assert.equal(built.identity, "26HD0023 - 2026", "same identity a workbook row would produce");
  /* The two spellings are kept apart exactly as they are for an imported row:
     `rawId` is what gets shown, so it keeps the case that was typed, while
     `baseKey` is what everything matches on and is normalised. That is what
     makes a typed "26hd0023" and a workbook's "26HD0023" one project. */
  assert.equal(built.record.rawId, "26hd0023", "displayed as typed, whitespace trimmed");
  assert.equal(built.record.baseKey, "26HD0023", "matched in the canonical form");
  /* The typed values live in `manualValues`, beside the workbook's fields and
     never inside them, so the workbook's own value stays free to change and be
     audited while the typed one is what the panel shows. */
  const typed = built.record.manualValues;
  assert.equal(typed.district, "QMB NORTH");
  assert.equal(typed.license, "QM BUILDERS", "the same misspelling the readers repair");
  assert.equal(typed.engineer, "J. SANTOS");
  assert.equal(typed.status, "ONGOING", "on-going and ongoing are one status");
  assert.equal(typed.name, "Barangay road concreting", "name keeps its case, loses double spaces");
  assert.equal(typed.contract, 12_500_000);
  assert.equal(typed.swa, 0.101, "stored as the fraction, as the workbook supplies it");
  assert.equal(built.record.district, undefined,
    "the workbook's own field is untouched, so a workbook supplying it later registers as a change");
  assert.equal(built.record.inQmb, false);
  assert.equal(built.record.inLicenses, false);
  assert.equal(built.record.manualEntry, true);
});

test("Project ID and Year are required, and the year matches what an import accepts", () => {
  const at = { currentYear: 2026 };
  assert.match(buildManualProject({ projectId: "  ", year: "2026" }, at).error, /Project ID is required/);
  assert.match(buildManualProject({ projectId: "A", year: "" }, at).error, /Year is required/);
  assert.match(buildManualProject({ projectId: "A", year: "2021" }, at).error, /between 2022 and 2026/);
  assert.match(buildManualProject({ projectId: "A", year: "2027" }, at).error, /between 2022 and 2026/);
  assert.match(buildManualProject({ projectId: "A", year: "2026", contract: "-5" }, at).error, /cannot be negative/);
  assert.equal(buildManualProject({ projectId: "A", year: "2022" }, at).ok, true);
  assert.equal(buildManualProject({ projectId: "A", year: "2026" }, at).ok, true);
});

test("adding a project leaves the ledger otherwise untouched, and refuses a clash", () => {
  const { dim } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const built = buildManualProject({ projectId: "NEW-1", year: "2026", district: "north" }, { currentYear: 2026 });
  const added = addProjectToStore({ dim, coll: [], legacy: new Map() }, built.record);

  assert.equal(added.ok, true);
  assert.equal(added.store.dim.size, dim.size + 1);
  assert.equal(dim.has("NEW-1 - 2026"), false, "the store passed in is not mutated");
  const rows = assembleProjects(added.store.coll, added.store.dim);
  const row = rows.find((r) => r.id === "NEW-1 - 2026");
  /* assembleProjects deliberately reports the workbook's view — the typed value
     is carried alongside and applied by the panel at render, which is what keeps
     the Excel audit diff comparing workbook values to workbook values. */
  assert.equal(row.district, "UNSPECIFIED", "nothing imported has set this yet");
  assert.equal(row.manualValues.district, "NORTH", "and the typed value travels with the row");
  assert.equal(row.collectionAvailable, false, "no collectibles row, so no money is implied");
  assert.equal(row.qmbOverlap, false);

  const clash = buildManualProject({ projectId: "QMB-001", year: "2025" }, { currentYear: 2026 });
  const refused = addProjectToStore({ dim, coll: [], legacy: new Map() }, clash.record);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /already exists/);
});

test("a later workbook updates a hand-entered project rather than duplicating it", () => {
  /* The whole reason buildManualProject reuses the readers' normalisers. */
  const built = buildManualProject({ projectId: "qmb-new", year: "2025", district: "north" }, { currentYear: 2026 });
  const typed = new Map([[built.identity, built.record]]);
  const workbook2 = new Map([["QMB-NEW - 2025", {
    identity: "QMB-NEW - 2025", baseKey: "QMB-NEW", rawId: "QMB-NEW", year: 2025,
    inQmb: true, inLicenses: false, district: "SOUTH", contract: 9_000_000,
  }]]);
  const { dim, added, updated } = mergeMasterDimensions(typed, workbook2);

  assert.equal(added, 0, "the workbook matched the typed project instead of adding a second row");
  assert.equal(updated, 1);
  assert.equal(dim.size, 1);
  /* Matching is the point of this test; who wins each column is the next one's.
     District was typed on the form, so it is held; contract was left blank, so
     the workbook supplies it. */
  assert.equal(dim.get("QMB-NEW - 2025").district, "SOUTH",
    "the workbook's field moves freely; the typed value hides it at render, it does not freeze it");
  assert.equal(dim.get("QMB-NEW - 2025").manualValues.district, "NORTH", "and still outranks it on screen");
  assert.equal(dim.get("QMB-NEW - 2025").contract, 9_000_000);
  assert.equal(dim.get("QMB-NEW - 2025").inQmb, true);
});

/* A value somebody typed outranks the workbook permanently, per project and per
   column. A column they left blank is not protected and the workbook fills it
   normally — that is what keeps "only two required fields" honest. */
test("an import cannot overwrite a hand-entered column, but fills the blank ones", () => {
  const built = buildManualProject({
    projectId: "HAND-1", year: "2025", district: "TYPED NORTH", engineer: "J. SANTOS",
  }, { currentYear: 2026 });
  assert.deepEqual(built.manualFields, ["district", "engineer"],
    "only the columns actually filled in are held");

  const typed = new Map([[built.identity, built.record]]);
  const workbook = new Map([["HAND-1 - 2025", {
    identity: "HAND-1 - 2025", baseKey: "HAND-1", rawId: "HAND-1", year: 2025,
    inQmb: true, inLicenses: false,
    district: "WORKBOOK SOUTH", engineer: "SOMEBODY ELSE",
    category: "ROAD", contract: 4_000_000,
  }]]);
  const { dim, keptManual } = mergeMasterDimensions(typed, workbook);
  const row = dim.get("HAND-1 - 2025");

  assert.equal(row.manualValues.district, "TYPED NORTH", "what the panel shows");
  assert.equal(row.manualValues.engineer, "J. SANTOS");
  assert.equal(row.district, "WORKBOOK SOUTH", "what the workbook says, kept so the change can be audited");
  assert.equal(row.category, "ROAD", "left blank on the form, so nothing hides the workbook here");
  assert.equal(row.contract, 4_000_000);
  assert.equal(keptManual, 2, "reported, so the import log can say the workbook disagreed");
  assert.deepEqual(Object.keys(row.manualValues), ["district", "engineer"], "the overlay survives the import");
  assert.equal(row.inQmb, true, "sheet membership is still learned from the workbook");
});

test("protection is permanent across repeated imports", () => {
  const built = buildManualProject({ projectId: "HAND-2", year: "2025", status: "SUSPENDED" }, { currentYear: 2026 });
  const workbook = new Map([["HAND-2 - 2025", {
    identity: "HAND-2 - 2025", baseKey: "HAND-2", rawId: "HAND-2", year: 2025, status: "ONGOING",
  }]]);

  let dim = new Map([[built.identity, built.record]]);
  for (let pass = 0; pass < 3; pass++) dim = mergeMasterDimensions(dim, workbook).dim;

  assert.equal(dim.get("HAND-2 - 2025").manualValues.status, "SUSPENDED",
    "a third import must not wear the hand-entered value down");
  assert.equal(dim.get("HAND-2 - 2025").status, "ONGOING", "while the workbook's own value is still tracked");
});

test("a workbook agreeing with a hand-entered value is not counted as a disagreement", () => {
  const built = buildManualProject({ projectId: "HAND-3", year: "2025", district: "NORTH" }, { currentYear: 2026 });
  const workbook = new Map([["HAND-3 - 2025", {
    identity: "HAND-3 - 2025", baseKey: "HAND-3", rawId: "HAND-3", year: 2025, district: "NORTH",
  }]]);
  const { keptManual } = mergeMasterDimensions(new Map([[built.identity, built.record]]), workbook);

  assert.equal(keptManual, 0, "nothing was overridden, so the log must not claim it was");
});

test("an ordinary imported project is unaffected by the protection rule", () => {
  const { dim: first } = readMasterWorkbook(masterBook(), { currentYear: 2026 });
  const { dim: second } = readMasterWorkbook(laterBook(), { currentYear: 2026 });
  const { dim, keptManual } = mergeMasterDimensions(first, second);

  assert.equal(keptManual, 0, "no hand-entered columns exist, so nothing is held back");
  assert.equal(dim.get("QMB-001 - 2025").district, "REVISED SOUTH", "the newer workbook still wins");
});

/* The requirement in full, in one test: a hand-created project keeps its typed
   name on screen for ever, AND the workbook's different name is still recorded
   in that column's audit trail as an Excel update. Both, at the same time —
   which is only possible because the typed value overlays the workbook's field
   rather than replacing it. */
test("a workbook renaming a hand-created project is audited even though the typed name stays", () => {
  const built = buildManualProject({
    projectId: "12345", year: "2026", name: "Balao National High School", district: "NORTH",
  }, { currentYear: 2026 });
  const before = assembleProjects([], new Map([[built.identity, built.record]]));

  const workbookSays = new Map([["12345 - 2026", {
    identity: "12345 - 2026", baseKey: "12345", rawId: "12345", year: 2026, inQmb: true,
    name: "BALAO NAT'L HS - PHASE 2", district: "SOUTH", contract: 8_000_000,
  }]]);
  const { dim, keptManual } = mergeMasterDimensions(new Map([[built.identity, built.record]]), workbookSays);
  const after = assembleProjects([], dim);

  /* What the panel will show: the typed values, unchanged. */
  const row = after.find((r) => r.id === "12345 - 2026");
  assert.equal(row.manualValues.name, "Balao National High School");
  assert.equal(row.manualValues.district, "NORTH");
  assert.equal(keptManual, 2, "the workbook disagreed on two held columns");

  /* What the audit will record: the workbook's values, traceable. */
  const changes = importedChanges(before, after);
  const byField = Object.fromEntries(changes.map((c) => [c.field_key, c]));
  assert.equal(byField.name.new_value, "BALAO NAT'L HS - PHASE 2",
    "the name the workbook supplied is recorded even though it is not displayed");
  assert.equal(byField.name.column_name, "Project name");
  assert.equal(byField.district.new_value, "SOUTH");
  assert.equal(byField.contract.new_value, "8000000", "a column nobody typed is simply imported");
});

test("the same Project ID in a different year is a separate project, not an update", () => {
  /* 12345 typed for 2026; the workbook brings 12345 for 2027. Identity carries
     the year, so the 2026 row and its typed values are untouched. */
  const built = buildManualProject({ projectId: "12345", year: "2026", name: "Balao NHS" }, { currentYear: 2026 });
  const nextYear = new Map([["12345 - 2027", {
    identity: "12345 - 2027", baseKey: "12345", rawId: "12345", year: 2027, name: "BALAO NHS", inQmb: true,
  }]]);
  const { dim, added, updated, keptManual } = mergeMasterDimensions(new Map([[built.identity, built.record]]), nextYear);

  assert.deepEqual([added, updated, keptManual], [1, 0, 0]);
  assert.equal(dim.get("12345 - 2026").manualValues.name, "Balao NHS", "the typed year is untouched");
  assert.equal(dim.get("12345 - 2027").manualValues, undefined, "the new year is purely imported");
  assert.equal(duplicateProjectIds(assembleProjects([], dim)).groups.length, 1,
    "and the admin duplicate view shows 12345 twice, which is exactly right");
});

test("the data-source label records recent changes without growing without limit", () => {
  let label = "Imported master · 2026 PROJECT LISTINGS.xlsx";
  label = appendDatasetNote(label, "26HD0023 - 2026 deleted");
  label = appendDatasetNote(label, "12345 - 2026 added");
  label = appendDatasetNote(label, "12345 - 2025 added");
  assert.equal(label,
    "Imported master · 2026 PROJECT LISTINGS.xlsx • 26HD0023 - 2026 deleted • 12345 - 2026 added • 12345 - 2025 added",
    "up to three changes are spelled out");

  for (let i = 0; i < 40; i++) label = appendDatasetNote(label, `EXTRA-${i} - 2026 added`);
  const parts = label.split(" • ");
  assert.equal(parts.length, 5, "base, one summary, three recent — however many changes have happened");
  assert.equal(parts[0], "Imported master · 2026 PROJECT LISTINGS.xlsx", "the import it came from is never lost");
  assert.equal(parts[1], "+40 earlier changes", "and the rest are counted rather than listed");
  assert.equal(parts[4], "EXTRA-39 - 2026 added", "the most recent change is always shown");

  /* A fresh import replaces the label outright, so the notes start again. */
  assert.equal(appendDatasetNote("Imported master · NEW.xlsx", "A - 2026 added"),
    "Imported master · NEW.xlsx • A - 2026 added");
});

/* The sheet reader is injected rather than statically imported, so there is a
   window in which it could be missing. Reading a workbook then has to fail
   loudly: an empty grid would read as "the workbook holds no projects", which
   merges as a dataset-wide deletion of everybody's data. */
test("reading a workbook without the Excel library loaded throws instead of reporting an empty workbook", () => {
  const book = masterBook();
  const money = workbook({ COLLECTIBLES: [
    ["Project ID", "Net Amount (Check Amount)"],
    ["QMB-001", 12_000_000],
  ] });
  setWorkbookSheetReader(null);
  try {
    assert.throws(() => readMasterWorkbook(book, { currentYear: 2026 }), /not loaded/i,
      "a missing parser is an error, never an empty sheet");
    assert.throws(() => readCollectiblesWorkbook(money), /not loaded/i);
  } finally {
    setWorkbookSheetReader(XLSX.utils.sheet_to_json);
  }

  const { dim } = readMasterWorkbook(book, { currentYear: 2026 });
  assert.ok(dim.size > 0, "and the same workbook reads normally once the reader is registered again");
});
