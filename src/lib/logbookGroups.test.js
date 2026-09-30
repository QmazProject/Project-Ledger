/* The staff logbook splits into one department per project site. */

import test from "node:test";
import assert from "node:assert/strict";
import { NO_SITE_KEY, siteKey, groupStaffBySite, pagesOf } from "./logbookGroups.js";

const emp = (id, site) => ({ id, site });

test("staff are grouped by project site, ignoring case and spacing", () => {
  const groups = groupStaffBySite([
    emp("1", "Head Office"), emp("2", "Bulacan Site"), emp("3", " head  office "), emp("4", "HEAD OFFICE"),
  ]);
  assert.deepEqual(groups.map((g) => [g.label, g.staff.map((e) => e.id)]), [
    ["Bulacan Site", ["2"]],
    ["Head Office", ["1", "3", "4"]],
  ]);
});

test("a group is labelled with the spelling most of its staff use", () => {
  const [g] = groupStaffBySite([emp("1", "pod office"), emp("2", "POD Office"), emp("3", "POD Office")]);
  assert.equal(g.label, "POD Office");
  const [tie] = groupStaffBySite([emp("1", "Site A"), emp("2", "site a")]);
  assert.equal(tie.label, "Site A", "a tie keeps the first spelling seen");
});

test("staff with no project site form their own group, last — never a default department", () => {
  const groups = groupStaffBySite([emp("1", ""), emp("2", "Zeta Site"), emp("3", undefined), emp("4", "  ")]);
  assert.deepEqual(groups.map((g) => g.key), [siteKey("Zeta Site"), NO_SITE_KEY]);
  assert.deepEqual(groups[1].staff.map((e) => e.id), ["1", "3", "4"]);
  assert.equal(groups[1].label, "");
});

test("the sheet's first-stamp order is kept inside each department", () => {
  const [a] = groupStaffBySite([emp("9", "A"), emp("2", "A"), emp("5", "A")]);
  assert.deepEqual(a.staff.map((e) => e.id), ["9", "2", "5"]);
});

test("each department pages on its own, six to a sheet", () => {
  const seven = Array.from({ length: 7 }, (_, i) => emp(String(i), "A"));
  assert.deepEqual(pagesOf(seven, 6).map((p) => p.length), [6, 1]);
  assert.deepEqual(pagesOf([], 6), [[]], "an empty department still prints one blank sheet");
  assert.deepEqual(groupStaffBySite([]), []);
});
