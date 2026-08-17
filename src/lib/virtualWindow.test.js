import test from "node:test";
import assert from "node:assert/strict";

import { computeVirtualWindow, averageMeasuredHeight } from "./virtualWindow.js";

/* 555 is the size of the real ledger this was written for. */
const COUNT = 555;
const VIEWPORT = 620;
const uniform = () => 34;

const win = (over) => computeVirtualWindow({
  count: COUNT, scrollTop: 0, viewportHeight: VIEWPORT, heightAt: uniform, estimate: 34, overscan: 8, ...over,
});

test("only the visible rows plus overscan are mounted, not the whole ledger", () => {
  const { start, end } = win();
  assert.equal(start, 0, "at the top of the list nothing above is needed");
  /* 620px of viewport is ~19 rows of 34px, plus 8 overscan below. */
  assert.ok(end < 40, `expected a small window, got ${end - start} rows`);
  assert.ok(end >= 19, "the window must at least cover the viewport");
});

test("the spacers describe every row that is not mounted, so the scrollbar stays honest", () => {
  const { start, end, padTop, padBottom } = win({ scrollTop: 4_000 });
  const mounted = (end - start) * 34;
  assert.equal(padTop + mounted + padBottom, COUNT * 34,
    "padding plus rendered rows must equal the full list height");
});

test("scrolling moves the window rather than growing it", () => {
  const top = win({ scrollTop: 0 });
  const middle = win({ scrollTop: 9_000 });
  const later = win({ scrollTop: 12_000 });

  assert.ok(middle.start > top.start, "the window follows the scroll");
  assert.ok(middle.padTop > 0, "rows above the viewport are accounted for");
  /* Compared mid-list to mid-list: at the very top there are no rows above to
     overscan, so that window is legitimately smaller. The two mid-list windows
     can still differ by a single row, because where the viewport edge falls
     inside a row depends on the offset — what must not happen is the window
     growing with how far down the list somebody has scrolled. */
  assert.ok(Math.abs((later.end - later.start) - (middle.end - middle.start)) <= 1,
    "the window stays a constant size however deep the scroll is");
  assert.ok(later.end - later.start < 40, "and stays small in absolute terms");
  assert.ok(top.end - top.start < middle.end - middle.start,
    "the window at the top is smaller because overscan above it is clamped away");
});

test("the last row is reachable — scrolled to the end, the window covers the tail", () => {
  const totalHeight = COUNT * 34;
  const { end, padBottom } = win({ scrollTop: totalHeight - VIEWPORT });
  assert.equal(end, COUNT, "the final row is mounted when it is on screen");
  assert.equal(padBottom, 0, "and nothing is left padded below it");
});

/* A filter can shrink the list while the container is still scrolled far past
   the new end. Every row then sits above the viewport, and a window that
   allowed start to run past the list would render an empty table. */
test("over-scrolling past a shrunken list still renders rows", () => {
  const { start, end } = computeVirtualWindow({
    count: 3, scrollTop: 20_000, viewportHeight: VIEWPORT, heightAt: uniform,
  });
  assert.ok(end > start, "something is always rendered");
  assert.equal(end, 3, "and it is the tail of what is left");
});

test("an empty list asks for no rows and no padding", () => {
  assert.deepEqual(computeVirtualWindow({ count: 0, scrollTop: 0, viewportHeight: VIEWPORT, heightAt: uniform }),
    { start: 0, end: 0, padTop: 0, padBottom: 0 });
});

/* Rows are variable height because the Balance Work and Remarks cells grow to
   fit their text. Windowing that assumed one constant height would drift
   further out of position the further down the list somebody scrolled. */
test("variable row heights are walked, not multiplied", () => {
  /* every tenth row is a tall multi-line Remarks row */
  const heightAt = (index) => (index % 10 === 0 ? 96 : 30);
  const total = Array.from({ length: COUNT }, (_, i) => heightAt(i)).reduce((a, b) => a + b, 0);
  const { start, end, padTop, padBottom } = computeVirtualWindow({
    count: COUNT, scrollTop: 5_000, viewportHeight: VIEWPORT, heightAt, overscan: 8,
  });
  const mounted = Array.from({ length: end - start }, (_, i) => heightAt(start + i)).reduce((a, b) => a + b, 0);
  assert.equal(padTop + mounted + padBottom, total, "tall rows are measured, not averaged away");
  assert.ok(padTop <= 5_000, "the window never starts below the scroll position");
});

test("rows that have never been rendered fall back to the estimate", () => {
  /* nothing measured at all — the first paint, before any row exists */
  const { padTop, padBottom, end, start } = computeVirtualWindow({
    count: 100, scrollTop: 0, viewportHeight: VIEWPORT, heightAt: () => undefined, estimate: 40, overscan: 2,
  });
  assert.equal(padTop + (end - start) * 40 + padBottom, 100 * 40,
    "an unmeasured list is still given a full, consistent height");
});

test("a measured height of zero is ignored rather than collapsing the list", () => {
  const { padTop, padBottom, start, end } = computeVirtualWindow({
    count: 50, scrollTop: 0, viewportHeight: VIEWPORT, heightAt: () => 0, estimate: 34, overscan: 2,
  });
  assert.equal(padTop + (end - start) * 34 + padBottom, 50 * 34,
    "a row mid-unmount reporting 0 must not shrink the scroll height to nothing");
});

test("the estimate follows what has actually been measured", () => {
  assert.equal(averageMeasuredHeight([30, 40, 50]), 40);
  assert.equal(averageMeasuredHeight([], 34), 34, "nothing measured yet keeps the default");
  assert.equal(averageMeasuredHeight([0, undefined, 60], 34), 60, "zero and missing are not data");
});
