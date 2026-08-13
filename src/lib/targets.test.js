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

test("a new target must be named; a migrated one may keep a null scope", () => {
  assert.ok(validateTarget({ scope: "", target_qty: 10 }, { isNew: true }).scope);
  assert.deepEqual(validateTarget({ scope: null, target_qty: 10 }, { isNew: false }), {},
    "migrated targets have no scope and must stay editable");
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
