/* Run with: npm test */

import test from "node:test";
import assert from "node:assert/strict";

import { analyseSwa, swaBands, swaPoints, SWA_DEFAULT_VIEW, SWA_PARITY_BAND } from "./swaMonitor.js";

/* Percentages are fractions everywhere in this ledger — 0.55, never 55 — from
   the workbook and from the panel's own editor alike. */
const row = (over = {}) => ({
  id: "QMB-001 - 2026", name: "Sample", district: "NORTH", engineer: "CRUZ",
  swa: 0.40, billpct: 0.30, contract: 10_000_000, cg: 2_000_000, bal: 3_000_000, ...over,
});

/* Mirrors the precedence in ProjectLedger's `records` memo:
     const merged = { ...r, ...(handEntered || {}), ...(m || {}) };
     if (draft) Object.assign(merged, draft);
   The monitor is handed the RESULT of this, never the layers, which is what
   keeps one precedence rule in one place. */
const effective = ({ imported, handEntered = null, manual = null, draft = null }) => {
  const merged = { ...imported, ...(handEntered || {}), ...(manual || {}) };
  if (draft) Object.assign(merged, draft);
  return merged;
};

/* ---------------- precedence: manual outranks imported ---------------- */

test("1. an imported SWA with no override is what the monitor plots", () => {
  const r = effective({ imported: row({ swa: 0.40 }) });
  assert.equal(analyseSwa([r]).points[0].swaP, 40);
});

test("2. a manual SWA overrides the imported one, and the gap follows it", () => {
  /* imported 40%, manually corrected to 55%, billing 30% -> gap +25pt */
  const r = effective({ imported: row({ swa: 0.40, billpct: 0.30 }), manual: { swa: 0.55 } });
  const { points } = analyseSwa([r]);
  assert.equal(points[0].swaP, 55, "the manual value wins, not the imported 40");
  assert.equal(points[0].billP, 30);
  assert.equal(points[0].lag, 25, "gap is measured from the effective SWA");
});

test("3. a later import does not displace the manual override", () => {
  /* the workbook is re-imported with a new figure; the manual layer is applied
     over it exactly as before, so the effective value is unchanged */
  const r = effective({ imported: row({ swa: 0.70 }), manual: { swa: 0.55 } });
  assert.equal(analyseSwa([r]).points[0].swaP, 55,
    "re-importing changes the underlying value, never the override on top of it");
});

test("20. an unsaved draft is what the panel shows, so it is what the monitor plots", () => {
  const r = effective({ imported: row({ swa: 0.40 }), manual: { swa: 0.55 }, draft: { swa: 0.61 } });
  assert.equal(analyseSwa([r]).points[0].swaP, 61,
    "the monitor agrees with the cell above it while an edit is still unsaved");
});

/* ---------------- the gap ---------------- */

test("4. SWA above billing is work done and not yet invoiced", () => {
  const { unbilled, overbilled } = analyseSwa([row({ id: "A", swa: 0.90, billpct: 0.40 })]);
  assert.equal(unbilled.length, 1);
  assert.equal(unbilled[0].lag, 50);
  assert.equal(overbilled.length, 0);
});

test("5. billing above SWA is billed ahead of the work", () => {
  const { unbilled, overbilled } = analyseSwa([row({ id: "C", swa: 0.20, billpct: 0.80 })]);
  assert.equal(overbilled.length, 1);
  assert.equal(Math.round(overbilled[0].lag), -60);
  assert.equal(unbilled.length, 0);
});

test("6. SWA equal to billing is neither, and the parity band is exclusive", () => {
  const equal = analyseSwa([row({ swa: 0.50, billpct: 0.50 })]);
  assert.equal(equal.unbilled.length, 0);
  assert.equal(equal.overbilled.length, 0);
  assert.equal(equal.points[0].lag, 0);

  /* exactly SWA_PARITY_BAND apart is still parity — the test is `> 5`, not `>= 5` */
  const onTheEdge = analyseSwa([row({ swa: 0.55, billpct: 0.50 })]);
  assert.equal(Math.round(onTheEdge.points[0].lag), SWA_PARITY_BAND);
  assert.equal(onTheEdge.unbilled.length, 0, "5pt apart is not yet called out");

  const justOver = analyseSwa([row({ swa: 0.56, billpct: 0.50 })]);
  assert.equal(justOver.unbilled.length, 1, "just past the band is");
});

/* ---------------- blanks are not zeros ---------------- */

test("7. a blank SWA excludes the project rather than plotting it at 0%", () => {
  const a = analyseSwa([row({ id: "A", swa: null }), row({ id: "B", swa: undefined }), row({ id: "C", swa: 0.5 })]);
  assert.equal(a.plotted, 1, "only the project that has a figure is plotted");
  assert.equal(a.missing, 2, "and the omission is reported, not hidden");
  assert.equal(a.points[0].id, "C");
});

test("8. a blank billing figure excludes the project too", () => {
  const a = analyseSwa([row({ billpct: null }), row({ id: "ok", billpct: 0.2 })]);
  assert.equal(a.plotted, 1);
  assert.equal(a.missing, 1);
});

test("a genuine zero is a value and is plotted", () => {
  const a = analyseSwa([row({ swa: 0, billpct: 0 })]);
  assert.equal(a.plotted, 1, "0% built and 0% billed is a real, plottable state");
  assert.equal(a.missing, 0);
  assert.equal(a.points[0].swaP, 0);
  assert.equal(a.points[0].lag, 0);
});

/* ---------------- value to invoice ---------------- */

/* The figure is the Balance works (cg) already carried for those projects — NOT
   the gap multiplied by the contract. Pinning it because the two are easy to
   confuse and produce very different numbers. */
test("9 & 10. Value to invoice totals Balance works (cg), not gap x contract", () => {
  const rows = [
    row({ id: "A", swa: 0.90, billpct: 0.40, contract: 10_000_000, cg: 5_000_000 }),
    row({ id: "B", swa: 0.95, billpct: 0.10, contract: 20_000_000, cg: 1_500_000 }),
    row({ id: "C", swa: 0.50, billpct: 0.50, contract: 99_000_000, cg: 9_000_000 }), // parity, excluded
  ];
  const { unbilledMoney } = analyseSwa(rows);
  assert.equal(unbilledMoney, 6_500_000, "cg of the called-out projects only");

  const gapTimesContract = (0.5 * 10_000_000) + (0.85 * 20_000_000);
  assert.notEqual(unbilledMoney, gapTimesContract, "explicitly not the gap-times-contract reading");
});

test("a missing cg contributes nothing rather than breaking the total", () => {
  const { unbilledMoney } = analyseSwa([
    row({ id: "A", swa: 0.9, billpct: 0.1, cg: null }),
    row({ id: "B", swa: 0.9, billpct: 0.1, cg: 250_000 }),
  ]);
  assert.equal(unbilledMoney, 250_000);
});

/* ---------------- weighted average ---------------- */

test("Avg SWA is weighted by contract, so a large project counts for more", () => {
  const { avgSwa } = analyseSwa([
    row({ id: "big", swa: 0.20, billpct: 0.10, contract: 90_000_000 }),
    row({ id: "small", swa: 1.00, billpct: 0.90, contract: 10_000_000 }),
  ]);
  /* (20*90 + 100*10) / 100 = 28, not the unweighted 60 */
  assert.equal(avgSwa, 28);
});

test("Avg SWA is withheld rather than NaN when no project carries a contract", () => {
  const { avgSwa } = analyseSwa([row({ swa: 0.5, billpct: 0.4, contract: 0 })]);
  assert.equal(avgSwa, null, "dividing by a zero contract total must not print NaN%");
  assert.equal(analyseSwa([]).avgSwa, null, "and an empty selection has no average");
});

/* ---------------- filters are authoritative ---------------- */

test("11. the monitor describes exactly the rows it is given", () => {
  const all = [
    row({ id: "2026-A", swa: 0.90, billpct: 0.20, contract: 10_000_000, cg: 4_000_000 }),
    row({ id: "2026-B", swa: 0.80, billpct: 0.30, contract: 10_000_000, cg: 1_000_000 }),
    /* a real gap, not exactly the parity band — otherwise it would be excluded
       from both totals and the comparison below would prove nothing */
    row({ id: "2025-C", swa: 0.10, billpct: 0.02, contract: 80_000_000, cg: 9_000_000 }),
  ];
  const everything = analyseSwa(all);
  assert.equal(everything.plotted, 3);
  assert.equal(everything.unbilledMoney, 14_000_000);

  /* the caller filters; the monitor never reaches past what it was handed */
  const filtered = analyseSwa(all.filter((r) => r.id.startsWith("2026")));
  assert.equal(filtered.plotted, 2);
  assert.equal(filtered.unbilledMoney, 5_000_000);
  assert.equal(filtered.avgSwa, 85, "the average is of the selection, not the ledger");
});

/* ---------------- widest gaps ---------------- */

test("12. widest gaps are ranked by the size of the gap, largest first", () => {
  const { unbilled } = analyseSwa([
    row({ id: "mid", swa: 0.60, billpct: 0.30 }),
    row({ id: "widest", swa: 0.95, billpct: 0.10 }),
    row({ id: "narrow", swa: 0.40, billpct: 0.32 }),
    row({ id: "parity", swa: 0.50, billpct: 0.50 }),
  ]);
  assert.deepEqual(unbilled.map((p) => p.id), ["widest", "mid", "narrow"]);
  assert.equal(unbilled.every((p, i, a) => i === 0 || a[i - 1].lag >= p.lag), true);
});

/* ---------------- spread bands ---------------- */

test("bands bucket Balance for collection by SWA decile, 100% landing in the top band", () => {
  const bands = swaBands(swaPoints([
    row({ id: "a", swa: 0.05, billpct: 0, bal: 1_000_000 }),
    row({ id: "b", swa: 0.95, billpct: 0, bal: 2_000_000 }),
    row({ id: "c", swa: 1.00, billpct: 0, bal: 3_000_000 }),
  ]));
  assert.equal(bands.length, 10);
  assert.equal(bands[0].n, 1);
  assert.equal(bands[0].bal, 1_000_000);
  assert.equal(bands[9].n, 2, "100% must not fall off the end of the last band");
  assert.equal(bands[9].bal, 5_000_000);
  assert.equal(bands.reduce((t, b) => t + b.n, 0), 3, "every plotted project lands in exactly one band");
});

test("bands use Balance for collection, which is a different field from Value to invoice", () => {
  const pts = swaPoints([row({ swa: 0.95, billpct: 0.10, bal: 7_000_000, cg: 2_000_000 })]);
  assert.equal(swaBands(pts)[9].bal, 7_000_000, "bal, not cg");
  assert.equal(analyseSwa([row({ swa: 0.95, billpct: 0.10, bal: 7_000_000, cg: 2_000_000 })]).unbilledMoney,
    2_000_000, "cg, not bal");
});

/* ---------------- the default view ---------------- */

test("13. Scatter is the default view", () => {
  assert.equal(SWA_DEFAULT_VIEW, "scatter",
    "the panel opens on the scatter; nobody should have to click to see it");
});

/* Spread's deciles are a separate function precisely so the panel can leave
   them uncomputed until somebody asks. */
test("15. computing the spread is separable from analysing the rows", () => {
  const a = analyseSwa([row()]);
  assert.equal(Object.prototype.hasOwnProperty.call(a, "bands"), false,
    "analyseSwa must not compute bands — the panel calls swaBands only in spread mode");
  assert.equal(typeof swaBands, "function");
});

/* ---------------- shape guarantees ---------------- */

test("the analysis never mutates the rows it was given", () => {
  const original = row({ swa: 0.4, billpct: 0.3 });
  const snapshot = JSON.stringify(original);
  analyseSwa([original]);
  swaBands(swaPoints([original]));
  assert.equal(JSON.stringify(original), snapshot);
});

test("an empty or malformed selection is handled rather than thrown on", () => {
  assert.deepEqual(analyseSwa([]).points, []);
  assert.equal(analyseSwa([]).plotted, 0);
  assert.equal(analyseSwa(undefined).plotted, 0);
  assert.deepEqual(swaBands(undefined).length, 10);
  assert.equal(analyseSwa([null, undefined, row()]).plotted, 1);
});
