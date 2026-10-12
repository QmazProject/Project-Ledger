/* ==================================================================
   SWA monitoring — the arithmetic behind "accomplishment against billing".

   Pure functions, no React, so every figure the panel prints can be exercised
   directly. Extracted from the panel unchanged: these are the formulas that
   were copied in, not new ones.

   The one thing to understand before reading further is which money field each
   figure uses, because two different ones are involved and they are not
   interchangeable:

     cg   "Balance works" — COLLECTIBLE GROSS AMOUNT from the workbook. This is
          what "Value to invoice" totals: work delivered and not yet billed.
     bal  "Balance for collection". This is what the spread bands accumulate and
          what sizes the scatter bubbles.

   Percentages arrive as FRACTIONS (0.55, not 55) from both the workbook and the
   panel's own editor, which stores through fractionFromPercent. Everything here
   multiplies by 100 exactly once, at the boundary, and works in percentage
   points from then on. `lag` is therefore a difference of points, not a ratio.
================================================================== */

/** Scatter is what the panel opens on. Exported so the component and its tests
 *  agree on the default rather than each naming it separately. */
export const SWA_DEFAULT_VIEW = "scatter";

/** How far accomplishment and billing may diverge before a project is called
 *  out. Strict: a project exactly 5 points apart is still "within parity". */
export const SWA_PARITY_BAND = 5;

const sumOf = (rows, key) => rows.reduce((total, row) => total + (row[key] || 0), 0);

/* Binary floating point cannot hold 0.55, and the error survives the ×100:
   0.55 * 100 is 55.00000000000001, and (0.55 - 0.50) * 100 is 5.000000000000004.
   That last one matters — it is greater than SWA_PARITY_BAND, so a project
   exactly five points apart was called out as "done, not billed" while another
   true five-point gap, landing a fraction the other side of the error, was not.
   The rule says the band is exclusive; rounding here is what makes the code
   actually say that. Six decimal places of a percentage point is far finer than
   any figure this ledger carries, so nothing real is rounded away. */
const trim = (n) => Math.round(n * 1e6) / 1e6;
const asPoints = (fraction) => trim(fraction * 100);

const present = (value) => value !== null && value !== undefined;

/** One plottable point per project that has BOTH figures.
 *
 *  A project missing either one is excluded, never coerced to zero. A blank SWA
 *  means nobody has recorded accomplishment yet; plotting it at 0% would put it
 *  in the worst band on the chart and pull the weighted average down, inventing
 *  a fact about work that may well be finished. The count of excluded projects
 *  is reported separately so the omission is visible rather than silent. */
export function swaPoints(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && present(row.swa) && present(row.billpct))
    .map((row) => {
      const swaP = asPoints(row.swa);
      const billP = asPoints(row.billpct);
      return {
        ...row,
        swaP,
        billP,
        /* Positive = built more than billed. Taken as the difference of the two
           displayed figures, so the Gap column can never disagree with the SWA
           and Billed columns printed beside it. */
        lag: trim(swaP - billP),
      };
    });
}

/** Everything the KPI row and the widest-gaps table show. */
export function analyseSwa(rows) {
  const all = Array.isArray(rows) ? rows : [];
  const points = swaPoints(all);

  const unbilled = points
    .filter((p) => p.lag > SWA_PARITY_BAND)
    .sort((a, b) => b.lag - a.lag);
  const overbilled = points.filter((p) => p.lag < -SWA_PARITY_BAND);

  /* Weighted by contract so a ₱100M project at 20% is not averaged against a
     ₱1M project at 100% as though they were the same problem. */
  const contractTotal = sumOf(points, "contract");
  const avgSwa = points.length && contractTotal
    ? trim(points.reduce((total, p) => total + p.swaP * (p.contract || 0), 0) / contractTotal)
    : null;

  return {
    points,
    plotted: points.length,
    /* projects dropped for want of an SWA or a billing figure */
    missing: all.length - points.length,
    unbilled,
    /* Balance works, NOT contract × gap: this is the amount already carried as
       collectible for work that has been done and not yet invoiced. */
    unbilledMoney: sumOf(unbilled, "cg"),
    overbilled,
    avgSwa,
  };
}

/** Balance for collection bucketed into ten SWA deciles.
 *
 *  Computed only when the Spread view is opened — the panel defaults to Scatter
 *  and most sessions never ask for this. */
export function swaBands(points) {
  const bands = Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i * 10 + 10, n: 0, bal: 0 }));
  for (const p of Array.isArray(points) ? points : []) {
    /* 100% lands in the 90–100 band rather than falling off the end. */
    const index = Math.min(9, Math.max(0, Math.floor(p.swaP / 10)));
    bands[index].n++;
    bands[index].bal += p.bal || 0;
  }
  return bands;
}
