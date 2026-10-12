/* Run with: npm test
   Node's built-in runner — no test framework is added to the project. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  projectKey, isTrackable, isDraft, isArchived,
  selectPrimaryTarget,
  assessTarget, assessTargets, assessProjectTargets,
  atRiskExposure, distinctProjectCount,
  validateTarget, targetWarnings, AT_RISK_BUCKETS, TARGET_FIELDS, TARGET_HISTORY_FIELDS, SCOPE_LABEL,
  aggregateProjectTargets, isOutstanding,
} from "./targets.js";

/* A fixed "today" so every standing is reproducible. */
const TODAY = Date.parse("2026-08-11T00:00:00");
const at = { today: TODAY };

let seq = 0;
const target = (over = {}) => ({
  id: `t${++seq}`,
  scope: "Activity",
  target_qty: 100,
  unit: "meters",
  start_date: "2026-07-01",
  target_completion: "2026-12-01",
  actual_completion: null,
  actual_output: 0,
  archived_at: null,
  ...over,
});
const project = (over = {}) => ({ id: "QMB-001", name: "Sample", bal: 1_000_000, targets: [], ...over });

/* ---------------- canonical project key ---------------- */

test("canonical key absorbs the two divergences that actually orphan data", () => {
  assert.equal(projectKey("qmb-014"), "QMB-014");            // case
  assert.equal(projectKey("O'BRIEN-2"), "OBRIEN-2");         // straight apostrophe
  assert.equal(projectKey("O’BRIEN-2"), "OBRIEN-2");    // typographic apostrophe
  assert.equal(projectKey("  QMB   14 "), "QMB 14");         // whitespace, already handled upstream
  assert.equal(projectKey(null), "");
});

/* ---------------- legacy single-target selection ---------------- */

test("legacy view selects the nearest non-archived target", () => {
  const later = target({ id: "later", target_completion: "2027-06-01", created_at: "2026-01-01" });
  const nearest = target({ id: "nearest", target_completion: "2026-12-01", created_at: "2026-02-01" });
  const archived = target({ id: "archived", target_completion: "2026-08-01", archived_at: "2026-08-02" });

  assert.equal(selectPrimaryTarget([later, archived, nearest]), nearest);
});

test("legacy target selection puts undated targets last and does not reorder its input", () => {
  const undated = target({ id: "undated", target_completion: null, created_at: "2025-01-01" });
  const dated = target({ id: "dated", target_completion: "2028-01-01", created_at: "2026-01-01" });
  const rows = [undated, dated];

  assert.equal(selectPrimaryTarget(rows), dated);
  assert.deepEqual(rows, [undated, dated]);
  assert.equal(selectPrimaryTarget([target({ archived_at: "2026-01-01" })]), null);
});

/* The same fixtures are asserted against public.project_key() by
   supabase/verification/staging-verification.sql section 3. If either side is
   changed, change both — a silent divergence between them is what would make a
   migrated target invisible to the application that has to find it. */
export const KEY_PARITY_CASES = [
  //  input                                    expected      note
  ["abc-001",                                  "ABC-001"],   // lower case
  ["ABC-001",                                  "ABC-001"],   // already canonical
  ["abc '001",                                 "ABC 001"],   // straight apostrophe
  ["ABC \u2019001",                            "ABC 001"],   // curly apostrophe
  ["O'BRIEN-2",                                "OBRIEN-2"],  // straight, mid-token
  ["O\u2019BRIEN-2",                           "OBRIEN-2"],  // curly, mid-token
  ["  abc-001  ",                              "ABC-001"],   // leading / trailing
  ["abc    001",                               "ABC 001"],   // repeated spaces
  ["abc\u0009001",                             "ABC 001"],   // tab
  ["abc\u00a0001",                             "ABC 001"],   // non-breaking space
  ["abc\u202f001",                             "ABC 001"],   // narrow no-break space
  ["abc\u3000001",                             "ABC 001"],   // ideographic space
  ["abc-001\ufeff",                            "ABC-001"],   // zero-width no-break space
  ["  abc\u00a0\u00a0'  001 ",                 "ABC 001"],   // several kinds at once
];

test("canonical key parity fixtures — the JS half of the SQL comparison", () => {
  for (const [input, expected] of KEY_PARITY_CASES)
    assert.equal(projectKey(input), expected,
      `projectKey(${JSON.stringify(input)}) should be ${JSON.stringify(expected)}`);
});

test("the two spellings that orphan data collapse to one key", () => {
  /* This is the whole point of the canonical key: a manual row written under
     one spelling must still be found when the workbook changes its mind. */
  const pairs = [["qmb-014", "QMB-014"], ["O'BRIEN-2", "O’BRIEN-2"], ["abc 001", "abc 001"]];
  for (const [a, b] of pairs)
    assert.equal(projectKey(a), projectKey(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
});

/* ---------------- 1. one-target project is unchanged ---------------- */

test("1. a project with one target behaves exactly as before the migration", () => {
  const p = project({ targets: [target({ target_completion: "2026-08-01" })] });
  const { tracked } = assessTargets([p], at);

  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].bucket, "Overdue");
  assert.equal(tracked[0].days, -10);
  assert.equal(tracked[0].progress, 0);
  assert.equal(tracked[0].remaining, 100);
});

/* ---------------- 2. multiple targets ---------------- */

test("2. one project can carry several targets, each assessed independently", () => {
  const p = project({ targets: [
    target({ target_completion: "2026-08-01" }),                 // overdue
    target({ target_completion: "2026-08-13" }),                 // critical (2 days)
    target({ target_completion: "2026-12-01" }),                 // on track
  ]});
  const { tracked } = assessTargets([p], at);

  assert.deepEqual(tracked.map((t) => t.bucket), ["Overdue", "Critical", "On track"]);
  assert.equal(distinctProjectCount(tracked), 1);
});

/* ---------------- 3. React keys ---------------- */

test("3. every tracked row carries a unique target id for use as a React key", () => {
  const p = project({ targets: [target(), target(), target()] });
  const { tracked } = assessTargets([p], at);
  const ids = tracked.map((t) => t.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(Boolean));
  // the project id repeats across rows, which is exactly why it cannot be the key
  assert.equal(new Set(tracked.map((t) => t.projectId)).size, 1);
});

/* ---------------- 4 & 5. drafts ---------------- */

test("4. a scope-only target is a draft: stored, listed, never dropped", () => {
  const draft = target({ scope: "Survey works", target_qty: null, target_completion: null, actual_output: null });

  assert.equal(isTrackable(draft), false);
  assert.equal(isDraft(draft), true);

  const summary = assessProjectTargets(project({ targets: [draft] }), at);
  assert.equal(summary.all.length, 1);        // present
  assert.equal(summary.drafts.length, 1);     // and identified
  assert.equal(summary.tracked.length, 0);
});

test("5. a draft affects no tracking figure", () => {
  const draft = target({ scope: "Survey works", target_qty: null, target_completion: null, actual_output: null });
  const live = target({ target_completion: "2026-08-01" });
  const { tracked, drafts } = assessTargets([project({ targets: [draft, live] })], at);

  assert.equal(tracked.length, 1);
  assert.equal(drafts.length, 1);
  assert.equal(atRiskExposure(tracked).targetCount, 1);
  // a project of nothing but drafts contributes no exposure at all
  const only = assessTargets([project({ targets: [draft] })], at);
  assert.equal(atRiskExposure(only.tracked).money, 0);
  assert.equal(atRiskExposure(only.tracked).projectCount, 0);
});

test("a target with a quantity but no dates is trackable, not a draft", () => {
  const t = target({ target_completion: null, start_date: null });
  assert.equal(isTrackable(t), true);
  const [row] = assessTargets([project({ targets: [t] })], at).tracked;
  assert.equal(row.bucket, "On track");   // no deadline to be late against
  assert.equal(row.days, null);
});

/* ---------------- 6 & 7. collection at risk ---------------- */

test("6. three at-risk targets on one project count its balance once", () => {
  const p = project({ bal: 1_000_000, targets: [
    target({ target_completion: "2026-08-01" }),   // Overdue
    target({ target_completion: "2026-08-12" }),   // Critical
    target({ target_completion: "2026-08-13" }),   // Critical
  ]});
  const { tracked } = assessTargets([p], at);
  const risk = atRiskExposure(tracked);

  assert.equal(risk.money, 1_000_000, "balance must not be multiplied by target count");
  assert.equal(risk.projectCount, 1);
});

test("7. the at-risk target count still reports all three", () => {
  const p = project({ bal: 1_000_000, targets: [
    target({ target_completion: "2026-08-01" }),
    target({ target_completion: "2026-08-12" }),
    target({ target_completion: "2026-08-13" }),
  ]});
  const risk = atRiskExposure(assessTargets([p], at).tracked);

  assert.equal(risk.targetCount, 3);
  assert.equal(risk.projectCount, 1);
  assert.equal(risk.money, 1_000_000);
});

test("mixed safe and at-risk targets: the project counts once, safe targets add nothing", () => {
  const p = project({ bal: 500_000, targets: [
    target({ target_completion: "2026-08-01" }),   // Overdue
    target({ target_completion: "2026-12-01" }),   // On track
    target({ target_qty: 100, actual_output: 100, target_completion: "2026-09-01",
             actual_completion: "2026-08-05" }),   // Delivered on time
  ]});
  const risk = atRiskExposure(assessTargets([p], at).tracked);

  assert.equal(risk.targetCount, 1);
  assert.equal(risk.projectCount, 1);
  assert.equal(risk.money, 500_000);
});

test("several projects each contribute their own balance exactly once", () => {
  const a = project({ id: "A", bal: 1_000_000, targets: [
    target({ target_completion: "2026-08-01" }),
    target({ target_completion: "2026-08-02" }),
  ]});
  const b = project({ id: "B", bal: 250_000, targets: [target({ target_completion: "2026-08-03" })] });
  const c = project({ id: "C", bal: 999_999, targets: [target({ target_completion: "2026-12-01" })] });  // safe

  const risk = atRiskExposure(assessTargets([a, b, c], at).tracked);
  assert.equal(risk.targetCount, 3);
  assert.equal(risk.projectCount, 2);
  assert.equal(risk.money, 1_250_000);
});

test("a project with no targets contributes nothing and does not throw", () => {
  const { tracked, drafts } = assessTargets([project({ targets: [] }), project({ id: "X" })], at);
  assert.equal(tracked.length, 0);
  assert.equal(drafts.length, 0);

  const risk = atRiskExposure(tracked);
  assert.deepEqual([risk.targetCount, risk.projectCount, risk.money], [0, 0, 0]);

  const summary = assessProjectTargets(project({ targets: [] }), at);
  assert.equal(summary.active, 0);
  assert.equal(summary.worst, null);
  assert.equal(summary.nextDue, "");
});

test("the project balance is read through a reference, not copied onto the target", () => {
  const p = project({ bal: 1_000_000, targets: [target({ target_completion: "2026-08-01" })] });
  const [row] = assessTargets([p], at).tracked;

  assert.equal(row.bal, undefined, "a copied balance is what makes double counting possible");
  assert.equal(row.contract, undefined);
  assert.equal(row.project.bal, 1_000_000);
});

/* ---------------- 8. delivered ---------------- */

test("8. delivered, delivered on time, and delivered late stay distinct", () => {
  const onTime = target({ target_qty: 100, actual_output: 100,
                          target_completion: "2026-08-20", actual_completion: "2026-08-15" });
  const late = target({ target_qty: 100, actual_output: 100,
                        target_completion: "2026-08-01", actual_completion: "2026-08-10" });
  const unproven = target({ target_qty: 100, actual_output: 100,
                            target_completion: "2026-08-20", actual_completion: null });

  const rows = assessTargets([project({ targets: [onTime, late, unproven] })], at).tracked;
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));

  assert.equal(by[onTime.id].bucket, "Delivered on time");
  assert.equal(by[late.id].bucket, "Delivered");
  assert.equal(by[late.id].lateDays, 9);
  assert.equal(by[unproven.id].bucket, "Delivered",
    "with no completion date there is no evidence it landed on time");
  assert.equal(by[unproven.id].onTime, false);

  // delivered targets are never at risk, however large the balance
  assert.equal(atRiskExposure(rows).money, 0);
});

test("over-delivery is delivered, and progress stays capped", () => {
  const t = target({ target_qty: 100, actual_output: 250, target_completion: "2026-08-20" });
  const [row] = assessTargets([project({ targets: [t] })], at).tracked;
  assert.equal(row.done, true);
  assert.equal(row.progress, 2);
  assert.equal(row.remaining, 0);
});

/* ---------------- archived ---------------- */

test("an archived target leaves tracking, drafts and exposure entirely", () => {
  const archived = target({ target_completion: "2026-08-01", archived_at: "2026-08-10T00:00:00Z" });
  const live = target({ target_completion: "2026-08-01" });
  const p = project({ bal: 1_000_000, targets: [archived, live] });

  assert.equal(isArchived(archived), true);
  assert.equal(isTrackable(archived), false);
  assert.equal(isDraft(archived), false, "archived is its own state, not a draft");

  const { tracked, drafts } = assessTargets([p], at);
  assert.equal(tracked.length, 1);
  assert.equal(drafts.length, 0);

  const summary = assessProjectTargets(p, at);
  assert.equal(summary.archived.length, 1);
  assert.equal(summary.all.length, 2, "archived targets remain listed for the modal");
  assert.equal(summary.active, 1);
});

/* ---------------- ranking / summary ---------------- */

test("the worklist ranks overdue first and the summary reports the worst standing", () => {
  const p = project({ targets: [
    target({ target_completion: "2026-12-01" }),   // On track
    target({ target_completion: "2026-08-01" }),   // Overdue
    target({ target_completion: "2026-08-13" }),   // Critical
  ]});
  const { tracked } = assessTargets([p], at);
  assert.equal(tracked[0].bucket, "Overdue");

  const summary = assessProjectTargets(p, at);
  assert.equal(summary.worst.bucket, "Overdue");
  assert.equal(summary.atRisk.length, 2);
  assert.equal(summary.nextDue, "2026-08-01", "soonest outstanding deadline");
});

test("no standing outside the known set, and 'Behind target' is gone", () => {
  const p = project({ targets: [
    target({ target_completion: "2026-08-01" }),
    target({ target_completion: "2026-08-13" }),
    target({ target_completion: "2026-12-01" }),
    target({ target_qty: 100, actual_output: 100, actual_completion: "2026-08-01" }),
  ]});
  const buckets = new Set(assessTargets([p], at).tracked.map((t) => t.bucket));
  assert.ok(!buckets.has("Behind target"));
  for (const b of buckets)
    assert.ok(["Overdue", "Critical", "On track", "Delivered", "Delivered on time"].includes(b), b);
  assert.deepEqual(AT_RISK_BUCKETS, ["Overdue", "Critical"]);
});

/* ---------------- validation ---------------- */

test("Actual completion is historical system data, not an editable target field", () => {
  assert.equal(TARGET_FIELDS.some(([field]) => field === "actual_completion"), false);
  assert.equal(TARGET_HISTORY_FIELDS.some(([field]) => field === "actual_completion"), true);
});

/* The column is headed "Balance Work". The audit trail files that field under
   "Scope", because the database functions write that string themselves and the
   history is read back by matching on it. Renaming the stored label to agree
   with the heading is the tempting, silent way to lose every scope change ever
   recorded — this test is here to make that failure loud. */
test("renaming the Balance Work heading must not rename what the audit trail stores", () => {
  assert.equal(SCOPE_LABEL, "Balance Work", "the heading the panel shows");
  assert.deepEqual(TARGET_FIELDS[0], ["scope", "Scope"],
    "the name the RPCs write into project_manual_update_audit.column_name — follows the database, not the UI");
  assert.equal(TARGET_HISTORY_FIELDS[0][1], "Scope", "and history reads back under the same stored name");
});

/* Balance Work is the author's choice, on a new target as much as on a migrated
   one. It was required on new targets once; requiring it again would block the
   Manage Targets modal on a field the business has said is optional. */
test("Balance Work is optional on every target, new or migrated", () => {
  assert.deepEqual(validateTarget({ scope: "", target_qty: 10 }, { isNew: true }), {},
    "a brand new target may be saved without one");
  assert.deepEqual(validateTarget({ scope: null, target_qty: 10 }, { isNew: false }), {},
    "migrated targets have no scope and must stay editable");
  assert.deepEqual(validateTarget({ scope: null, target_qty: 10 }, { isNew: true }), {},
    "null and empty are both simply absent");
});

test("editable numbers and dates are checked, and target completion cannot precede the start", () => {
  assert.ok(validateTarget({ scope: "A", target_qty: -5 }).target_qty);
  assert.ok(validateTarget({ scope: "A", actual_output: "abc" }).actual_output);
  assert.ok(validateTarget({ scope: "A", start_date: "2026-05-01", target_completion: "2026-04-01" }).target_completion);
  assert.deepEqual(validateTarget({ scope: "A", start_date: "2026-05-01", target_completion: "2026-06-01" }), {});
  assert.deepEqual(validateTarget({ scope: "A", target_qty: "", actual_output: "" }), {},
    "blank is legitimate for every optional field");
});

test("legacy actual completion is retained as read-only data, not validated as user input", () => {
  assert.deepEqual(validateTarget({
    scope: "A", start_date: "2026-05-01", actual_completion: "2026-04-01",
  }), {});
});

test("over-delivery and zero quantity warn rather than block", () => {
  assert.deepEqual(validateTarget({ scope: "A", target_qty: 100, actual_output: 150 }), {});
  assert.equal(targetWarnings({ target_qty: 100, actual_output: 150 }).length, 1);
  assert.equal(targetWarnings({ target_qty: 0 }).length, 1);
  assert.equal(targetWarnings({ target_qty: 100, actual_output: 50 }).length, 0);
});

test("a zero target still needs an explicit Actual output save to complete", () => {
  const blankOutput = assessTarget(project(), target({ target_qty: 0, actual_output: null }), TODAY);
  const savedOutput = assessTarget(project(), target({ target_qty: 0, actual_output: 0 }), TODAY);

  assert.equal(blankOutput.done, false);
  assert.equal(savedOutput.done, true);
});

test("a recorded completion remains delivered after Actual output is reduced", () => {
  const row = assessTarget(project(), target({
    target_qty: 100, actual_output: 25, actual_completion: "2026-08-10",
  }), TODAY);

  assert.equal(row.done, true);
  assert.equal(row.bucket, "Delivered on time");
});

/* ---------------- live standing in the modal ---------------- */

test("standing survives raw input strings, which is what the modal hands it", () => {
  /* The modal computes a standing from what is currently typed, so every value
     arrives as a string and empty fields arrive as "" rather than null. */
  const typed = {
    id: "t-live", scope: "Activity A",
    target_qty: "100", unit: "meters",
    start_date: "2026-07-01", target_completion: "2026-08-01",
    actual_completion: "", actual_output: "40",
  };
  const row = assessTarget(project(), typed, TODAY);

  assert.equal(row.bucket, "Overdue");
  assert.equal(row.target, 100);
  assert.equal(row.actual, 40);
  assert.equal(row.progress, 0.4);
  assert.equal(row.remaining, 60);
  assert.equal(row.finish, "", "an empty completion date must not read as delivered");
  assert.equal(row.done, false);
});

test("a half-typed row is a draft until it has a quantity or a deadline", () => {
  assert.equal(isTrackable({ scope: "A", target_qty: "", target_completion: "" }), false);
  assert.equal(isTrackable({ scope: "A", target_qty: "0", target_completion: "" }), true);
  assert.equal(isTrackable({ scope: "A", target_qty: "", target_completion: "2026-09-01" }), true);
});

/* ---------------- 12. import isolation ---------------- */

test("12. targets are read from their own collection, never from project fields", () => {
  /* A re-import rebuilds the project row from the workbook. Legacy target
     columns riding along on that row must not resurrect as targets. */
  const reimported = {
    id: "QMB-001", bal: 1_000_000, targets: [],
    target: 999, unit: "legacy", due: "2026-01-01", start: "2025-01-01",
    finish: null, actual: 5,
  };
  const { tracked, drafts } = assessTargets([reimported], at);
  assert.equal(tracked.length, 0);
  assert.equal(drafts.length, 0);
  assert.equal(assessProjectTargets(reimported, at).all.length, 0);
});

/* The Targets filter counted every stored target, so a project whose only
   target was a draft — a Balance Work name with no quantity and no completion
   date — was filed under "With target" while every target column on its row
   rendered blank. These pin the two halves of that fix. */
test("a draft is not counted as a trackable target", () => {
  const at = { today: Date.parse("2026-08-13T00:00:00Z") };
  const draftOnly = { id: "QMB-001", bal: 1_000_000, targets: [
    { id: "d1", scope: "Roadworks", target_qty: null, unit: "", start_date: "", target_completion: "", actual_output: null },
  ] };
  const summary = assessProjectTargets(draftOnly, at);

  assert.equal(summary.tracked.length, 0, "this is what the Targets filter reads");
  assert.equal(summary.drafts.length, 1, "and the draft is still reported, not dropped");
  assert.equal(summary.active, 1, "Manage Targets still counts it, so it stays reachable");
  assert.equal(isDraft(draftOnly.targets[0]), true);
  assert.equal(isTrackable(draftOnly.targets[0]), false);

  const bare = assessProjectTargets({ id: "X", targets: [{ id: "d2" }] }, at);
  assert.equal(bare.tracked.length, 0, "a target with no fields at all is a draft too");
});

test("a quantity alone or a completion date alone makes a target trackable", () => {
  const at = { today: Date.parse("2026-08-13T00:00:00Z") };
  const rows = { id: "QMB-001", bal: 0, targets: [
    { id: "q", scope: "Qty only", target_qty: 100 },
    { id: "d", scope: "Date only", target_completion: "2026-12-31" },
    { id: "z", scope: "Zero qty", target_qty: 0 },
  ] };
  const summary = assessProjectTargets(rows, at);

  assert.equal(summary.tracked.length, 3, "a zero quantity is a real target, not a blank one");
  assert.equal(summary.drafts.length, 0);
});

test("a draft never wins the primary target slot from a real target", () => {
  const draft = { id: "draft", scope: "Named only", created_at: "2026-01-01" };
  const undated = { id: "real", scope: "Has a quantity", target_qty: 50, created_at: "2026-06-01" };

  assert.equal(selectPrimaryTarget([draft, undated]).id, "real",
    "both are undated, so only the draft rule can separate them");
  assert.equal(selectPrimaryTarget([undated, draft]).id, "real", "and the input order does not decide it");

  const dated = { id: "dated", scope: "Due soon", target_completion: "2026-09-01", created_at: "2026-07-01" };
  assert.equal(selectPrimaryTarget([draft, dated, undated]).id, "dated",
    "among trackable targets the nearest completion date still wins");
  assert.equal(selectPrimaryTarget([draft]).id, "draft",
    "a project with only a draft still opens on that draft");
  assert.equal(selectPrimaryTarget([{ id: "gone", target_qty: 5, archived_at: "2026-02-02" }, draft]).id, "draft",
    "an archived target is still never selected, trackable or not");
});

/* ---------------- project-level aggregate for the Project Panel ---------------- */

const proj = (targets) => ({ id: "QMB-001 - 2025", targets });

test("the panel's target columns sum quantities and take the earliest start", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 1000, actual_output: 400, start_date: "2026-03-01", target_completion: "2026-09-30", unit: "m3" },
    { target_qty: 200, actual_output: 50, start_date: "2026-01-15", target_completion: "2026-12-31", unit: "m3" },
  ]));
  assert.equal(a.targetQty, 1200, "total commitment across every target");
  assert.equal(a.actualOutput, 450, "total delivered");
  assert.equal(a.startDate, "2026-01-15", "the earliest start is when the project began");
  assert.equal(a.count, 2);
  assert.equal(a.unit, "m3");
  assert.equal(a.unitsMixed, false);
});

/* The business asked for the next deadline that still needs action, not simply
   the earliest date on file — otherwise a project keeps advertising a target
   completion it already met. */
test("target completion is the earliest date that is not already delivered", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 100, actual_output: 100, target_completion: "2026-03-01" },
    { target_qty: 500, actual_output: 20, target_completion: "2026-08-30" },
  ]));
  assert.equal(a.targetCompletion, "2026-08-30", "the delivered March target is skipped");
});

test("a target delivered by its recorded completion date is skipped too", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 100, actual_output: 4, actual_completion: "2026-02-02", target_completion: "2026-03-01" },
    { target_qty: 500, actual_output: 20, target_completion: "2026-08-30" },
  ]));
  assert.equal(a.targetCompletion, "2026-08-30",
    "actual_completion means done even when output never reached the quantity");
});

test("every target delivered leaves no outstanding completion date", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 100, actual_output: 100, target_completion: "2026-03-01" },
  ]));
  assert.equal(a.targetCompletion, "", "nothing is outstanding, so the panel shows no date");
});

/* Summing m3 and km produces a number that means nothing. The panel still shows
   the total because the business asked for it, but the unit has to stop
   claiming the total is measured in one of them. */
test("mixed units are reported rather than silently picked", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 1000, unit: "m3" },
    { target_qty: 4, unit: "km" },
  ]));
  assert.equal(a.unitsMixed, true);
  assert.equal(a.unit, "", "no single unit may be implied");
  assert.equal(a.targetQty, 1004, "the total is still reported");
});

test("archived targets are excluded from every figure", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 1000, actual_output: 400, start_date: "2026-03-01", target_completion: "2026-09-30" },
    { target_qty: 9999, actual_output: 8888, start_date: "2020-01-01", target_completion: "2020-02-02",
      archived_at: "2026-05-05T00:00:00Z" },
  ]));
  assert.equal(a.count, 1, "an archived target is removed, not hidden");
  assert.equal(a.targetQty, 1000);
  assert.equal(a.actualOutput, 400);
  assert.equal(a.startDate, "2026-03-01", "and cannot drag the earliest start backwards");
  assert.equal(a.targetCompletion, "2026-09-30");
});

test("a project with no targets reports nothing rather than zero", () => {
  const a = aggregateProjectTargets(proj([]));
  assert.equal(a.count, 0);
  assert.equal(a.targetQty, null, "null so the panel shows an em dash, not a 0 nobody typed");
  assert.equal(a.actualOutput, null);
  assert.equal(a.startDate, "");
  assert.equal(a.targetCompletion, "");
});

test("a quantity of zero is a real value and is still summed", () => {
  const a = aggregateProjectTargets(proj([{ target_qty: 0, actual_output: 0 }]));
  assert.equal(a.targetQty, 0, "0 entered is not the same as nothing entered");
  assert.equal(a.actualOutput, 0);
});

/* The per-target remark must never be filed under the project's own Remarks
   label — AuditModal reads a project-level cell by column_name alone. */
test("target remarks are audited under a name of their own", () => {
  const stored = Object.fromEntries(TARGET_FIELDS);
  assert.equal(stored.remarks, "Target remarks");
  assert.notEqual(stored.remarks, "Remarks",
    "sharing the project's label would merge two separate fields' histories");
});

/* Both panel dates describe the work still outstanding. Delivering the target
   that starts earliest has to move the Start date column on, exactly as
   delivering the one due soonest moves the Completion column on — otherwise the
   two dates describe different targets and the pair stops reading as one
   answer. */
test("delivering the earliest target moves BOTH panel dates to the next one", () => {
  const targets = [
    { target_qty: 100, actual_output: 100, start_date: "2026-08-01", target_completion: "2026-08-20" },
    { target_qty: 500, actual_output: 20, start_date: "2026-09-01", target_completion: "2026-09-15" },
    { target_qty: 300, actual_output: 0, start_date: "2026-10-01", target_completion: "2026-10-10" },
  ];
  const a = aggregateProjectTargets(proj(targets));
  assert.equal(a.startDate, "2026-09-01", "the delivered August target no longer holds the start date");
  assert.equal(a.targetCompletion, "2026-09-15", "and its completion is skipped too");

  /* deliver the September one as well */
  const next = aggregateProjectTargets(proj(
    targets.map((t) => (t.start_date === "2026-09-01" ? { ...t, actual_output: 500 } : t)),
  ));
  assert.equal(next.startDate, "2026-10-01", "both columns move together");
  assert.equal(next.targetCompletion, "2026-10-10");
});

test("a project whose targets are all delivered reports no outstanding dates", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 100, actual_output: 100, start_date: "2026-08-01", target_completion: "2026-08-20" },
    { target_qty: 500, actual_output: 500, start_date: "2026-09-01", target_completion: "2026-09-15" },
  ]));
  assert.equal(a.startDate, "", "nothing is outstanding, so there is no start date to show");
  assert.equal(a.targetCompletion, "");
  assert.equal(a.targetQty, 600, "but the totals still count the delivered work");
  assert.equal(a.actualOutput, 600, "a project does not shrink because it succeeded");
});

/* The dates skip delivered targets; the sums do not. The unit qualifies those
   sums, so it must follow the sums and not the dates — a delivered target in a
   second unit still makes the total a mixed one. */
test("a delivered target still counts toward the totals and the unit check", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 1000, actual_output: 1000, start_date: "2026-08-01", unit: "m3" },
    { target_qty: 4, actual_output: 1, start_date: "2026-09-01", unit: "km" },
  ]));
  assert.equal(a.targetQty, 1004, "delivered quantities remain in the total");
  assert.equal(a.actualOutput, 1001);
  assert.equal(a.unitsMixed, true,
    "the delivered target's unit still makes this total a mixed one");
  assert.equal(a.startDate, "2026-09-01", "while the date skips it");
});

test("a target delivered by actual_completion is skipped by the start date too", () => {
  const a = aggregateProjectTargets(proj([
    { target_qty: 100, actual_output: 4, actual_completion: "2026-08-02",
      start_date: "2026-08-01", target_completion: "2026-08-20" },
    { target_qty: 500, actual_output: 20, start_date: "2026-09-01", target_completion: "2026-09-15" },
  ]));
  assert.equal(a.startDate, "2026-09-01",
    "a recorded completion means delivered, whatever the output says");
});

/* The database clears actual_completion when a corrected Actual output no
   longer reaches Target qty (20260903000000_reversible_target_completion.sql).
   These pin what the panel and the worklist must do once it has: a target that
   is no longer delivered has to come back into both. */
test("a corrected typo brings the target back into the panel's dates", () => {
  const delivered = {
    target_qty: 1000, actual_output: 1000, actual_completion: "2026-08-17",
    start_date: "2026-08-01", target_completion: "2026-08-20",
  };
  const other = { target_qty: 500, actual_output: 20, start_date: "2026-09-01", target_completion: "2026-09-15" };

  const typo = aggregateProjectTargets(proj([delivered, other]));
  assert.equal(typo.startDate, "2026-09-01", "while it is delivered the panel skips it");
  assert.equal(typo.targetCompletion, "2026-09-15");

  /* the corrected row as the database now returns it: output fixed AND the
     stamp cleared, because the output no longer reaches the target */
  const corrected = { ...delivered, actual_output: 100, actual_completion: null };
  const after = aggregateProjectTargets(proj([corrected, other]));
  assert.equal(after.startDate, "2026-08-01", "corrected, it is outstanding again and holds the earliest start");
  assert.equal(after.targetCompletion, "2026-08-20", "and the earliest completion");
});

/* The stamp is what makes a target done even when the numbers disagree, which
   is exactly why it has to be cleared rather than left behind. */
test("a stamp left behind would still read as delivered — which is the bug it fixes", () => {
  const stale = { target_qty: 1000, actual_output: 100, actual_completion: "2026-08-17",
    start_date: "2026-08-01", target_completion: "2026-08-20" };
  const a = aggregateProjectTargets(proj([stale]));
  assert.equal(a.startDate, "", "100 of 1000 still reads as delivered while the stamp is there");

  const cleared = aggregateProjectTargets(proj([{ ...stale, actual_completion: null }]));
  assert.equal(cleared.startDate, "2026-08-01", "clearing the stamp is what restores it");
  assert.equal(cleared.targetCompletion, "2026-08-20");
});

/* ---------------- the row's dates and the worklist's Standing ---------------- */

/* The two date columns on the project row must describe a target somebody can
   actually go and find in Target tracking and priority. That means the same
   test on both sides, not merely "is it delivered" — a draft is not delivered
   either, and it has no Standing at all. */
test("the panel's dates come only from targets that carry a live Standing", () => {
  /* Balance Work and a start date, nothing to measure: a draft. */
  const draft = { scope: "Survey works", start_date: "2026-01-01",
    target_qty: null, target_completion: null, actual_output: null };
  const live = { scope: "Roadworks", start_date: "2026-09-01",
    target_qty: 500, target_completion: "2026-09-15", actual_output: 20 };

  assert.equal(isOutstanding(draft), false, "a draft is waiting on nobody");
  assert.equal(isOutstanding(live), true);

  const a = aggregateProjectTargets(proj([draft, live]));
  assert.equal(a.startDate, "2026-09-01",
    "the draft's earlier start date must not become the row's Earliest Start date");
  assert.equal(a.targetCompletion, "2026-09-15");
});

/* The strongest form of the guarantee: whatever contributes a date to the row
   is precisely the set the worklist lists with a non-Delivered Standing. */
test("row dates and worklist Standings are drawn from the same set of targets", () => {
  const targets = [
    target({ id: "draft", target_qty: null, target_completion: null, start_date: "2026-01-01" }),
    target({ id: "archived", start_date: "2026-02-01", archived_at: "2026-03-01" }),
    target({ id: "delivered", target_qty: 100, actual_output: 100, start_date: "2026-03-01",
      target_completion: "2026-08-20" }),
    target({ id: "overdue", target_qty: 100, actual_output: 0, start_date: "2026-09-01",
      target_completion: "2026-08-01" }),
    target({ id: "ontrack", target_qty: 100, actual_output: 0, start_date: "2026-10-01",
      target_completion: "2026-12-01" }),
  ];
  const p = project({ targets });

  /* what the worklist shows, minus anything already delivered */
  const { tracked } = assessProjectTargets(p, at);
  const waiting = new Set(tracked.filter((t) => !t.done).map((t) => t.id));
  assert.deepEqual([...waiting].sort(), ["ontrack", "overdue"],
    "the draft, the archived one and the delivered one carry no live Standing");

  /* what the row's dates are drawn from */
  const contributing = new Set(targets.filter(isOutstanding).map((t) => t.id));
  assert.deepEqual([...contributing].sort(), [...waiting].sort(),
    "the row's dates and the worklist must never disagree about which targets are live");

  const a = aggregateProjectTargets(p);
  assert.equal(a.startDate, "2026-09-01", "earliest start among the live targets only");
  assert.equal(a.targetCompletion, "2026-08-01", "earliest completion among the live targets only");
});

/* ---------------- pace ---------------- */

/* Pace is the demonstrated daily rate divided by the rate still required:
   "can the time left absorb the work left, at the speed this crew has actually
   been going". It had no coverage at all, and every value below is one the
   worklist prints straight into a cell. */

const PACE_TODAY = Date.parse("2026-08-31T00:00:00");
const paceProject = { id: "QMB-001 - 2026", displayId: "QMB-001" };
const paceTarget = (over = {}) => ({
  id: "pt", target_qty: 1000, unit: "m3", start_date: "2026-08-01",
  target_completion: "2026-09-30", actual_completion: null, actual_output: 400, ...over,
});
const paceOf = (over) => assessTarget(paceProject, paceTarget(over), PACE_TODAY);

test("pace divides the rate achieved by the rate still needed", () => {
  const r = paceOf();
  /* 400 over 30 elapsed days = 13.33/day; 600 left over 30 days = 20/day. */
  assert.equal(r.elapsed, 30);
  assert.equal(r.capacity.toFixed(2), "13.33", "demonstrated rate, not a planned one");
  assert.equal(r.remaining, 600);
  assert.equal(r.needRate.toFixed(2), "20.00");
  assert.equal(r.pace.toFixed(2), "0.67", "two thirds of the rate required");
});

/* The same number read the other way round, which is what the cell's tooltip
   quotes: what can still be produced, against what is still outstanding. */
test("pace is also deliverable-in-the-time-left over work-outstanding", () => {
  const r = paceOf();
  assert.equal(Math.round(r.canDeliver), 400, "13.33/day for the 30 days left");
  assert.equal((r.canDeliver / r.remaining).toFixed(2), r.pace.toFixed(2));
});

test("exactly on the required rate is 1.00, which the worklist colours as safe", () => {
  /* 500 of 1000 in 30 days, 500 left in 30 days: the two rates are equal. */
  assert.equal(paceOf({ actual_output: 500 }).pace.toFixed(2), "1.00");
  assert.ok(paceOf({ actual_output: 800 }).pace > 1, "ahead of the required rate");
  assert.ok(paceOf({ actual_output: 300 }).pace < 1, "behind it");
});

/* Each of these prints "—" rather than a number, and each is a different
   missing input. A regression that silently produced 0 or Infinity here would
   put a red 0.00x against work that is going fine. */
test("pace is withheld whenever it cannot honestly be computed", () => {
  assert.equal(paceOf({ start_date: null }).pace, null, "no start date, no measured rate");
  assert.equal(paceOf({ start_date: "2026-09-15" }).pace, null, "start date not reached yet");
  assert.equal(paceOf({ actual_output: 0 }).pace, null, "nothing produced yet");
  assert.equal(paceOf({ target_completion: null }).pace, null, "no deadline, no required rate");
  assert.equal(paceOf({ target_completion: "2026-08-01" }).pace, null,
    "overdue: the rate needed to finish in negative time is not a number");
  assert.equal(paceOf({ target_completion: "2026-08-31" }).pace, null, "due today is the same case");
  assert.equal(paceOf({ actual_output: 1000 }).pace, null, "delivered: nothing outstanding to pace against");
});

/* An overdue target still reports the rate it managed, so the tooltip can say
   so even though the ratio itself is withheld. */
test("an overdue target keeps its measured capacity even with no pace", () => {
  const r = paceOf({ target_completion: "2026-08-01" });
  assert.equal(r.bucket, "Overdue");
  assert.equal(r.pace, null);
  assert.equal(r.capacity.toFixed(2), "13.33", "the tooltip still has a rate to report");
});

/* ---------------- the single-target row's chosen target ---------------- */

/* With Manage multiple targets switched off in User Management, the project row
   shows six editable target columns bound to ONE target, and every edit saves
   back to that target. Which target that is therefore decides what the row
   shows AND what an edit writes to, so each rule below is load-bearing. */

const st = (over = {}) => target({ target_qty: 100, actual_output: 0, actual_completion: null, ...over });

test("the row follows the target whose work started first", () => {
  const later = st({ id: "later", start_date: "2026-09-01", target_completion: "2026-09-15" });
  const first = st({ id: "first", start_date: "2026-08-01", target_completion: "2026-12-31" });
  /* Deliberately the LATER deadline on the earlier start: under the old rule
     the nearest completion won, so this is the case that changed. */
  assert.equal(selectPrimaryTarget([later, first]).id, "first");
});

test("delivering the earliest-start target moves the row on to the next", () => {
  const done = st({ id: "done", start_date: "2026-08-01", actual_output: 100 });
  const live = st({ id: "live", start_date: "2026-09-01" });
  assert.equal(selectPrimaryTarget([done, live]).id, "live");
});

/* A null here makes the save path treat an inline edit as a brand new target,
   so a fully delivered project must never leave the row without one. */
test("a project with every target delivered still resolves to a real target", () => {
  const a = st({ id: "a", start_date: "2026-08-01", actual_output: 100 });
  const b = st({ id: "b", start_date: "2026-09-01", actual_output: 100 });
  const chosen = selectPrimaryTarget([a, b]);
  assert.ok(chosen, "never null while a target exists — a blank row would let an edit create a duplicate");
  assert.equal(chosen.id, "a", "falls back to the earliest start among them");
});

test("a target with no start date never takes the row from one that has it", () => {
  const undated = st({ id: "undated", start_date: null, target_completion: "2026-08-05" });
  const dated = st({ id: "dated", start_date: "2026-08-01", target_completion: "2026-12-31" });
  assert.equal(selectPrimaryTarget([undated, dated]).id, "dated");
  /* and with no start dates anywhere, the original ordering still decides */
  const alsoUndated = st({ id: "later-due", start_date: null, target_completion: "2026-12-01" });
  assert.equal(selectPrimaryTarget([alsoUndated, undated]).id, "undated",
    "nearest completion remains the tie-break when no target has a start date");
});

test("a draft never takes the row from a real target, however early it started", () => {
  const draft = st({ id: "draft", start_date: "2020-01-01", target_qty: null, target_completion: null });
  const real = st({ id: "real", start_date: "2026-08-01" });
  assert.equal(selectPrimaryTarget([draft, real]).id, "real",
    "an early start beside blank quantities is not what the row is for");
});

test("archived targets are still never chosen, and an empty list is still null", () => {
  const archived = st({ id: "archived", start_date: "2020-01-01", archived_at: "2026-01-01" });
  const live = st({ id: "live", start_date: "2026-08-01" });
  assert.equal(selectPrimaryTarget([archived, live]).id, "live");
  assert.equal(selectPrimaryTarget([archived]), null);
  assert.equal(selectPrimaryTarget([]), null);
});

test("choosing a target does not reorder the caller's list", () => {
  const rows = [st({ id: "b", start_date: "2026-09-01" }), st({ id: "a", start_date: "2026-08-01" })];
  selectPrimaryTarget(rows);
  assert.deepEqual(rows.map((r) => r.id), ["b", "a"], "the server-ordered list is left alone");
});

/* The two modes must describe the same target. The single-target row picks one
   target; the multi-target row's dates come from the outstanding set. The row's
   target has to be a member of that set whenever one exists. */
test("the row's target agrees with the multi-target row's dates", () => {
  const targets = [
    st({ id: "done", start_date: "2026-08-01", target_completion: "2026-08-20", actual_output: 100 }),
    st({ id: "live", start_date: "2026-09-01", target_completion: "2026-09-15" }),
  ];
  const chosen = selectPrimaryTarget(targets);
  const agg = aggregateProjectTargets({ targets });
  assert.equal(chosen.id, "live");
  assert.equal(agg.startDate, chosen.start_date, "same start date in both modes");
  assert.equal(agg.targetCompletion, chosen.target_completion, "and the same completion");
});
