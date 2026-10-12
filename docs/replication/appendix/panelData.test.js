import test from "node:test";
import assert from "node:assert/strict";
import {
  LOAD, settleLoad, loadingState, isReady, hasFailed,
  projectTargets, targetsLabel, TARGETS_UNKNOWN,
  buildManualSave, MANUAL_UNAVAILABLE_REASON, normalizeManualValue,
  fractionFromPercent, percentFromFraction,
} from "./panelData.js";

/* The panel's real starting point: one project with hand-typed values already
   saved against it. Every test below asks what happens to those values. */
const STORED_STATUS = "ONGOING";
const STORED_CONTRACT = 4500000;
const STORED_REMARKS = "Retention released March";
const STORED_ENGINEER = "J. SANTOS";
const STORED_SWA = 0.62;
/* what the workbook says, which the stored values above are deliberately
   different from — an override only means anything when the two disagree */
const IMPORTED_ENGINEER = "R. CRUZ";
const IMPORTED_SWA = 0.55;

const manualMap = () => new Map([
  ["CIP-2024-014", {
    storedId: "cip-2024-014",
    values: { status: STORED_STATUS, contract: STORED_CONTRACT, note: STORED_REMARKS,
      engineer: STORED_ENGINEER, swa: STORED_SWA },
  }],
]);

const importedRow = { id: "CIP-2024-014", bal: 1200000, status: "", contract: null, note: "",
  engineer: IMPORTED_ENGINEER, swa: IMPORTED_SWA };

/* How the panel loads: both requests are settled independently, so one
   rejecting cannot discard the other's result. */
const settleBoth = async (manualPromise, targetPromise) => {
  const [m, t] = await Promise.allSettled([manualPromise, targetPromise]);
  return { manual: settleLoad(m), targets: settleLoad(t) };
};

/* ---------------- the regression ---------------- */

test("REGRESSION: a failed target load leaves the hand-typed values loaded", async () => {
  const { manual, targets } = await settleBoth(
    Promise.resolve(manualMap()),
    Promise.reject(new Error('relation "public.project_targets" does not exist')),
  );

  assert.equal(isReady(manual), true, "the manual load succeeded and must survive the other failure");
  assert.equal(hasFailed(targets), true);
  assert.match(targets.error, /project_targets/);

  const entry = manual.value.get("CIP-2024-014");
  assert.equal(entry.values.status, STORED_STATUS);
  assert.equal(entry.values.contract, STORED_CONTRACT);
  assert.equal(entry.values.note, STORED_REMARKS);
});

test("REGRESSION: saving after a failed target load preserves status and contract", async () => {
  const { manual } = await settleBoth(
    Promise.resolve(manualMap()),
    Promise.reject(new Error("targets unavailable")),
  );

  /* the user edits only Remarks */
  const save = buildManualSave({
    manual, id: "CIP-2024-014", key: "CIP-2024-014",
    draft: { note: "Updated remark" }, importedRow,
  });

  assert.equal(save.ok, true);
  assert.equal(save.values.status, STORED_STATUS, "status must not be sent as null");
  assert.equal(save.values.contract, STORED_CONTRACT, "contract must not be sent as null");
  assert.equal(save.values.note, "Updated remark");
  assert.deepEqual([...save.changedFields], ["note"]);
  assert.equal(save.storedId, "cip-2024-014", "still writes back to the row the values came from");
});

test("REGRESSION: a failed manual load blocks the save instead of writing nulls", async () => {
  const { manual } = await settleBoth(
    Promise.reject(new Error("network error")),
    Promise.resolve(new Map()),
  );

  const save = buildManualSave({
    manual, id: "CIP-2024-014", key: "CIP-2024-014",
    draft: { note: "Updated remark" }, importedRow,
  });

  assert.equal(save.ok, false, "with the stored values unknown there is nothing to preserve them from");
  assert.equal(save.reason, MANUAL_UNAVAILABLE_REASON);
  assert.equal(save.values, undefined, "a refused save carries no payload at all");
});

test("REGRESSION: a failed target load is not reported as a project with no targets", async () => {
  const { targets } = await settleBoth(Promise.resolve(manualMap()), Promise.reject(new Error("boom")));
  const { targets: list, unavailable } = projectTargets(targets, "CIP-2024-014");

  assert.equal(unavailable, true);
  assert.deepEqual(list, [], "an empty list is safe to render, but only alongside the unavailable flag");
  assert.equal(targetsLabel(unavailable, list.length), TARGETS_UNKNOWN);
  assert.notEqual(targetsLabel(unavailable, list.length), "No target");
});

/* ---------------- the success path is unchanged ---------------- */

test("both loading successfully behaves exactly as before", async () => {
  const targetMap = new Map([["CIP-2024-014", [{ id: "t1", scope: "Roadworks" }]]]);
  const { manual, targets } = await settleBoth(Promise.resolve(manualMap()), Promise.resolve(targetMap));

  assert.equal(manual.status, LOAD.READY);
  assert.equal(targets.status, LOAD.READY);

  const { targets: list, unavailable } = projectTargets(targets, "CIP-2024-014");
  assert.equal(unavailable, false);
  assert.equal(list.length, 1);
  assert.equal(targetsLabel(unavailable, list.length), "With target");

  const save = buildManualSave({
    manual, id: "CIP-2024-014", key: "CIP-2024-014",
    draft: { status: "COMPLETED" }, importedRow,
  });
  assert.equal(save.ok, true);
  assert.equal(save.values.status, "COMPLETED");
  assert.equal(save.values.contract, STORED_CONTRACT);
  assert.equal(save.values.note, STORED_REMARKS);
});

test("a successful load of nothing still stays distinguishable from a failure", async () => {
  const { manual, targets } = await settleBoth(Promise.resolve(new Map()), Promise.resolve(new Map()));

  assert.equal(isReady(targets), true);
  assert.equal(hasFailed(targets), false);
  const { unavailable, targets: list } = projectTargets(targets, "CIP-2024-014");
  assert.equal(unavailable, false, "an empty result is an answer; a failure is not");
  assert.equal(targetsLabel(unavailable, list.length), "No target");

  /* a project with no stored values saves only what was typed, and that is
     correct: there is nothing to preserve */
  const save = buildManualSave({
    manual, id: "NEW-001", key: "NEW-001", draft: { note: "First remark" }, importedRow: {},
  });
  assert.equal(save.ok, true);
  assert.equal(save.values.note, "First remark");
  assert.equal(save.storedId, "NEW-001");
});

test("a project with no target of its own is not confused with an unavailable load", () => {
  const state = { status: LOAD.READY, value: new Map([["OTHER", [{ id: "t1" }]]]), error: "" };
  const { targets, unavailable } = projectTargets(state, "CIP-2024-014");
  assert.equal(unavailable, false);
  assert.deepEqual(targets, []);
});

/* ---------------- states ---------------- */

test("while loading, nothing is concluded either way", () => {
  const state = loadingState();
  assert.equal(isReady(state), false);
  assert.equal(hasFailed(state), false, "loading is not a failure and must not show an error");
  assert.equal(projectTargets(state, "CIP-2024-014").unavailable, true);
  assert.equal(buildManualSave({ manual: state, id: "X", key: "X", draft: { note: "a" } }).ok, false,
    "saving before the stored values arrive is the same hazard as saving after they failed");
});

test("a rejection carries its message through for the user to read", () => {
  assert.equal(settleLoad({ status: "rejected", reason: new Error("permission denied") }).error, "permission denied");
  assert.equal(settleLoad({ status: "rejected", reason: "plain string" }).error, "plain string");
  assert.equal(settleLoad({ status: "rejected", reason: null }).error, "Unknown error");
  assert.equal(settleLoad(undefined).status, LOAD.FAILED, "a missing result is a failure, not a success");
});

test("a fulfilled load that resolved to null is not treated as ready", () => {
  const state = settleLoad({ status: "fulfilled", value: null });
  assert.equal(state.status, LOAD.READY);
  assert.equal(isReady(state), false, "there is no map to read, so nothing may be concluded from it");
  assert.equal(projectTargets(state, "X").unavailable, true);
  assert.equal(buildManualSave({ manual: state, id: "X", key: "X", draft: {} }).ok, false);
});

test("a draft is never mutated by building a save from it", () => {
  const draft = { note: "typed" };
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: manualMap() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft, importedRow,
  });
  save.values.note = "changed afterwards";
  assert.equal(draft.note, "typed");
});

/* ---------------- the hand-typed Senior engineer ---------------- */

test("a hand-typed Senior engineer is not sent as null by an unrelated edit", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: manualMap() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft: { note: "Updated remark" }, importedRow,
  });

  assert.equal(save.ok, true);
  assert.equal(save.values.engineer, STORED_ENGINEER,
    "the save writes every column, so a field nobody touched must carry its stored value");
  assert.deepEqual([...save.changedFields], ["note"],
    "and must not be audited as an edit either");
});

test("the first hand-typed Senior engineer audits against the imported one", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: new Map() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft: { engineer: "M. REYES" }, importedRow,
  });

  assert.equal(save.ok, true);
  assert.equal(save.values.engineer, "M. REYES");
  assert.equal(save.previous.engineer, IMPORTED_ENGINEER,
    "with no override stored yet, what is being replaced is the workbook's value");
  assert.deepEqual([...save.changedFields], ["engineer"]);
});

test("a stored Senior engineer, not the imported one, is what a later edit replaces", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: manualMap() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft: { engineer: "M. REYES" }, importedRow,
  });

  assert.equal(save.previous.engineer, STORED_ENGINEER,
    "an import that changed the workbook's engineer must not be recorded as this user's old value");
});

test("a lowercase Senior engineer is stored uppercase", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: new Map() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft: { engineer: "  m.   reyes " }, importedRow,
  });

  assert.equal(save.values.engineer, "M. REYES",
    "the column is filtered and grouped on, so casing cannot be allowed to split one engineer into two");
});

test("retyping the same engineer in another case is not a change to audit", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: manualMap() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft: { engineer: "j. santos" }, importedRow,
  });

  /* saveManualRow only writes an audit row where old and new differ as strings,
     so normalising before that comparison is what keeps the trail honest */
  assert.equal(save.values.engineer, STORED_ENGINEER);
  assert.equal(String(save.previous.engineer), String(save.values.engineer),
    "nothing actually changed, so the audit comparison must find nothing");
});

test("normalisation leaves the fields that have no rule alone", () => {
  assert.equal(normalizeManualValue("note", "  keep as typed  "), "  keep as typed  ");
  assert.equal(normalizeManualValue("status", "ONGOING"), "ONGOING");
  assert.equal(normalizeManualValue("engineer", null), "", "a cleared override is blank, not the word null");
});

/* ---------------- the hand-typed SWA % ---------------- */

test("typing the percentage stores the fraction the workbook would have supplied", () => {
  assert.equal(fractionFromPercent("10.1"), 0.101, "and not 0.10100000000000001");
  assert.equal(fractionFromPercent("100"), 1);
  assert.equal(fractionFromPercent("0"), 0, "zero percent is a value, not a cleared cell");
  assert.equal(fractionFromPercent(""), "", "a cleared cell is what removes the override");
  assert.equal(fractionFromPercent("."), "", "a half-typed number is not yet a value");
});

test("the stored fraction reads back as the number that was typed", () => {
  assert.equal(percentFromFraction(0.101), "10.1", "and not 10.100000000000001");
  assert.equal(percentFromFraction(0.0525), "5.25");
  assert.equal(percentFromFraction(1), "100");
  assert.equal(percentFromFraction(0), "0");
  assert.equal(percentFromFraction(null), "");
});

test("an edited SWA survives a redisplay unchanged", () => {
  /* focus, type, blur, focus again: the cell must offer back exactly what was
     typed, or a row nobody edited drifts every time somebody clicks into it */
  for (const typedPercent of ["10.1", "0.5", "99.99", "33.33", "7"])
    assert.equal(percentFromFraction(fractionFromPercent(typedPercent)), typedPercent);
});

test("a hand-typed SWA is not sent as null by an unrelated edit", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: manualMap() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft: { note: "Updated remark" }, importedRow,
  });

  assert.equal(save.values.swa, STORED_SWA);
  assert.deepEqual([...save.changedFields], ["note"]);
});

test("the first hand-typed SWA audits against the imported one", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: new Map() }),
    id: "CIP-2024-014", key: "CIP-2024-014",
    draft: { swa: fractionFromPercent("42.5") }, importedRow,
  });

  assert.equal(save.values.swa, 0.425);
  assert.equal(save.previous.swa, IMPORTED_SWA,
    "what a first override replaces is whatever the workbook last said");
});

test("previous values read imported first, then whatever was stored over them", () => {
  const save = buildManualSave({
    manual: settleLoad({ status: "fulfilled", value: manualMap() }),
    id: "CIP-2024-014", key: "CIP-2024-014", draft: { note: "x" }, importedRow,
  });
  assert.equal(save.previous.bal, 1200000, "imported fields stay available for the audit comparison");
  assert.equal(save.previous.status, STORED_STATUS, "stored values win over imported ones");
});
