/* Mounts only the ledger rows that are on screen.

   The ledger holds hundreds of projects and each row is expensive: eighteen
   cells, eleven of them an EditCell with its own state, its own layout effect
   and its own ResizeObserver. At 555 projects that was about 17,000 live
   components, roughly 97% of them scrolled out of sight, and every one of them
   was reconciled again on every keystroke, every filter change and every
   30-second presence poll. That is the multi-second freeze, not the data.

   What this does NOT change is what the ledger knows. The full filtered,
   sorted array is still passed in and still drives totals, KPIs, charts,
   export and the target analysis. This decides one thing only: which rows
   currently need a DOM node.

   Unsaved edits are safe across unmount because they were never held in the
   row. `drafts` lives in ProjectLedger and is keyed by project id, so a row
   that scrolls out of view keeps its unsaved value, keeps its place in Save
   All and Ctrl+S, and keeps the reload guard armed. Scrolling it back mounts a
   fresh row that reads the same draft. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computeVirtualWindow, averageMeasuredHeight } from "../lib/virtualWindow";

const DEFAULT_ROW_HEIGHT = 34;

export function useVirtualRows({ scrollRef, count, keyAt, overscan = 8 }) {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(620);
  /* Heights are state rather than a ref because the render below reads them to
     decide the window, and a ref read during render is not something React
     guarantees is up to date. Keyed by project id, not by index, so a row keeps
     its measured height when the table is re-sorted or filtered — which is what
     stops the scroll position lurching every time a column header is clicked. */
  const [heights, setHeights] = useState(() => new Map());

  const keyByElement = useRef(new Map());
  const observerRef = useRef(null);

  /* Follow the container's own scrolling. The table already lives in its own
     overflow-auto box, so this never has to reason about the page scroll. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;

    let frame = 0;
    const read = () => {
      frame = 0;
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    };
    /* Coalesced to one read per frame: scroll fires far more often than the
       screen updates, and each state change here re-renders the table. */
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };

    read();
    el.addEventListener("scroll", onScroll, { passive: true });

    let boxObserver;
    if (typeof ResizeObserver !== "undefined") {
      boxObserver = new ResizeObserver(read);
      boxObserver.observe(el);
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      boxObserver?.disconnect();
    };
  }, [scrollRef]);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    keyByElement.current.clear();
  }, []);

  /* A row is measured by observing it, not by reading it after every render.
     Observing reports the first size *and* every later one, which matters
     because a mounted row changes height as it is typed into — the Remarks and
     Balance Work cells grow to fit their text. It also keeps the measurement
     out of the render path entirely: this fires as a browser callback, the way
     any other external subscription would. */
  const measureRef = useCallback((element) => {
    if (!element) return undefined;

    if (!observerRef.current && typeof ResizeObserver !== "undefined") {
      observerRef.current = new ResizeObserver((entries) => {
        const seen = [];
        for (const entry of entries) {
          const key = keyByElement.current.get(entry.target);
          if (key === undefined) continue;
          const height = entry.target.offsetHeight;
          if (height > 0) seen.push([key, height]);
        }
        if (!seen.length) return;
        setHeights((previous) => {
          let changed = false;
          const next = new Map(previous);
          for (const [key, height] of seen) {
            const before = previous.get(key);
            /* Returning `previous` unchanged lets React bail out of the render
               entirely, which is what stops measuring from feeding itself. */
            if (before === undefined || Math.abs(before - height) > 0.5) {
              next.set(key, height);
              changed = true;
            }
          }
          return changed ? next : previous;
        });
      });
    }

    const observer = observerRef.current;
    observer?.observe(element);
    /* React 19 calls this cleanup when the row unmounts, so the observer never
       accumulates detached rows as the window slides. */
    return () => {
      observer?.unobserve(element);
      keyByElement.current.delete(element);
    };
  }, []);

  /* One ref callback per project id, reused for as long as the table is open.
     Returning a fresh arrow from here instead would hand React a new ref on
     every render, and React responds to a changed ref by running its cleanup
     and attaching again — so every row would be unobserved and re-observed on
     every scroll frame, re-measuring rows that had not moved. */
  const rowRefs = useRef(new Map());
  const rowRef = useCallback((key) => {
    let callback = rowRefs.current.get(key);
    if (!callback) {
      callback = (element) => {
        if (!element) return undefined;
        keyByElement.current.set(element, key);
        return measureRef(element);
      };
      rowRefs.current.set(key, callback);
    }
    return callback;
  }, [measureRef]);

  const estimate = useMemo(
    () => averageMeasuredHeight(heights.values(), DEFAULT_ROW_HEIGHT),
    [heights],
  );

  const window_ = computeVirtualWindow({
    count,
    scrollTop,
    viewportHeight,
    overscan,
    estimate,
    heightAt: (index) => heights.get(keyAt(index)),
  });

  return { ...window_, measureRef: rowRef };
}
