/* Which rows of a long list actually need to exist in the DOM.

   Kept as a pure function, separate from the React hook that drives it, because
   the arithmetic is the part that can be wrong in ways nobody notices until a
   row is missing at the bottom of a scroll. It is exercised directly by
   virtualWindow.test.js against variable row heights.

   Rows here are variable height on purpose: the Balance Work and Remarks cells
   grow to fit their text. So this walks measured heights rather than
   multiplying by a constant, and falls back to `estimate` for rows that have
   not been rendered yet and therefore have never been measured. */

/** @param {object} options
 *  @param {number} options.count            total rows in the filtered list
 *  @param {number} options.scrollTop        scroll offset of the container
 *  @param {number} options.viewportHeight   visible height of the container
 *  @param {(index: number) => number|undefined} options.heightAt measured height, or undefined
 *  @param {number} [options.estimate]       height to assume for unmeasured rows
 *  @param {number} [options.overscan]       extra rows to keep mounted above and below
 *  @returns {{start: number, end: number, padTop: number, padBottom: number}}
 *    `start`/`end` are a half-open range. `padTop`/`padBottom` are the pixel
 *    heights of the spacers that stand in for the rows outside it, so the
 *    scrollbar keeps describing the whole list rather than the rendered slice.
 */
export function computeVirtualWindow({
  count, scrollTop, viewportHeight, heightAt, estimate = 34, overscan = 8,
}) {
  if (!Number.isFinite(count) || count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };

  const heightOf = (index) => {
    const measured = heightAt(index);
    return Number.isFinite(measured) && measured > 0 ? measured : estimate;
  };

  /* Clamped because a filter can shrink the list while the container is still
     scrolled past the new end. Left alone, every row would fall above the
     viewport and the table would render blank until the user scrolled. */
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);

  /* First row whose bottom edge is still below the top of the viewport. Stops
     at the last row rather than running off the end, so an over-scrolled
     container shows the tail of the list instead of nothing. */
  let start = 0;
  let offset = 0;
  while (start < count - 1) {
    const h = heightOf(start);
    if (offset + h > top) break;
    offset += h;
    start++;
  }

  /* ...and forward until the viewport is covered. */
  let end = start;
  let filled = offset;
  while (end < count && filled < bottom) {
    filled += heightOf(end);
    end++;
  }

  const first = Math.max(0, start - overscan);
  const last = Math.min(count, end + overscan);

  let padTop = 0;
  for (let i = 0; i < first; i++) padTop += heightOf(i);
  let padBottom = 0;
  for (let i = last; i < count; i++) padBottom += heightOf(i);

  return { start: first, end: last, padTop, padBottom };
}

/** The height to assume for a row nobody has measured yet.
 *
 *  Averaging what has actually been seen matters more than it looks: `padTop`
 *  is built from estimates for every row above the viewport, so an estimate
 *  that is wrong by 8px across 300 rows moves the content under the user's
 *  cursor by 2,400px as those rows are corrected. */
export function averageMeasuredHeight(heights, fallback = 34) {
  let total = 0;
  let seen = 0;
  for (const value of heights) {
    if (Number.isFinite(value) && value > 0) { total += value; seen++; }
  }
  return seen ? total / seen : fallback;
}
