/* The staff logbook splits into one department per project site. */

import test from "node:test";
import assert from "node:assert/strict";
import { NO_SITE_KEY, siteKey, groupStaffBySite, pagesOf, pageRangeOf, pagesInRange } from "./logbookGroups.js";

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

test("a typed page range always describes something printable, capped per batch", () => {
  assert.deepEqual(pageRangeOf("1", "5", 30), { from: 1, to: 5, asked: 5 });
  assert.deepEqual(pageRangeOf("2", "5", 30), { from: 2, to: 5, asked: 5 }, "can start part way down the pad");
  assert.deepEqual(pageRangeOf("", "", 30), { from: 1, to: 1, asked: 1 }, "empty fields fall back to page 1");
  assert.deepEqual(pageRangeOf("4", "2", 30), { from: 4, to: 4, asked: 4 }, "To never sits below From");
  assert.deepEqual(pageRangeOf("0", "-3", 30), { from: 1, to: 1, asked: 1 });
  assert.deepEqual(pageRangeOf("2.9", "abc", 30), { from: 2, to: 2, asked: 2 });
  assert.deepEqual(pageRangeOf("1", "999", 30), { from: 1, to: 30, asked: 999 }, "a mistyped 999 is capped");
});

test("a page range prints the department's own pages, then blank sheets past its last", () => {
  const seven = Array.from({ length: 7 }, (_, i) => emp(String(i), "A"));
  const pages = pagesOf(seven, 6);
  const out = pagesInRange(pages, 1, 5);
  assert.deepEqual(out.map((p) => p.no), [1, 2, 3, 4, 5]);
  assert.deepEqual(out.map((p) => p.staff.length), [6, 1, 0, 0, 0]);
  assert.equal(out[1].staff[0].id, "6", "page 2 carries on with the seventh employee");
  assert.deepEqual(pagesInRange(pages, 2, 3).map((p) => [p.no, p.staff.length]), [[2, 1], [3, 0]]);
  assert.deepEqual(pagesInRange(pagesOf([], 6), 1, 2).map((p) => p.staff.length), [0, 0],
    "a department with nobody prints blank sheets only");
});
