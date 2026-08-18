# Frontend Performance Playbook

Lessons from making the Project Ledger fast, written so they can be reused on a new
system. Every number here was measured on this codebase — 555 projects, a real
authenticated session — not estimated.

## Golden rules

- **Measure before you optimise, and measure the right thing.** Both bottlenecks
  found here were counter-intuitive. Nobody would have guessed either.
- **Download time and main-thread time are different problems with different
  fixes.** Code splitting cannot fix a slow render. Virtualization cannot fix a
  4 MB bundle. Know which one you have.
- **Never defer authoritative data to improve a benchmark.** Deferring code is
  free; deferring *correctness* buys a fast number and a corrupted database.
- **Do not claim an improvement without a before and an after** taken on the same
  build, with the same data.

---

## Part 1 — Code splitting (download time)

### The trap that cost this project 441 kB

One static import silently defeats **every** dynamic import of the same module.

```js
// src/lib/projectImport.js — used ONE function from it
import * as XLSX from "xlsx";

// src/ProjectLedger.jsx — carefully lazy, and completely pointless
const XLSX = await import("xlsx");
```

The bundler says so plainly. **Read your build warnings:**

```
[INEFFECTIVE_DYNAMIC_IMPORT] node_modules/xlsx/xlsx.mjs is dynamically imported by
src/ProjectLedger.jsx but also statically imported by src/lib/projectImport.js,
dynamic import will not move module into another chunk.
```

Result: 441 kB / 125 kB gzipped of Excel parser downloaded by every user at
sign-in, including the majority who never import a workbook.

**The fix — inject the dependency instead of importing it:**

```js
// the pure module imports nothing heavy
let sheetToRows = null;
export function setWorkbookSheetReader(reader) { sheetToRows = reader; }

const sheetGrid = (workbook, name) => {
  // Fail LOUD. See "the empty-result trap" below.
  if (!sheetToRows) throw new Error("Excel tools are not loaded yet.");
  return sheetToRows(workbook.Sheets[name], { header: 1, raw: true, defval: "" });
};
```

```js
// the caller registers it the moment the library lands
const module = await import("xlsx");
setWorkbookSheetReader(module.utils.sheet_to_json);
```

### The empty-result trap

When a guard fails, **throw — do not return an empty value.** An empty parse result
reads as "this workbook contained no projects", which merges as a *dataset-wide
deletion*. A crash is recoverable; a silent wipe of everyone's data is not.

This applies far beyond parsing. Any function that returns a collection should
never return `[]` to mean "I could not find out."

### Lazy chunks cannot import from the module that imports them

A lazily-imported dialog that reaches back into its parent forms an import cycle,
and the bundler resolves that by pulling the dialog **back into the main chunk** —
silently undoing the split.

Structure it as a triangle, never a cycle:

```
        shared.js  (constants, helpers — eager, small)
         ↑      ↑
   Parent.jsx   LazyDialog.jsx
         └─ lazy import ─┘
```

### What to split, and what to leave alone

| Split it | Keep it eager |
|---|---|
| Parsers (xlsx, pdf, csv) — huge and rarely used | Auth client — needed before anything renders |
| Admin-only panels — most users never open them | The core list/table the page exists to show |
| Modals and dialogs — by definition not on first paint | Anything the first paint reads |
| Separate workspaces / routes | Small shared helpers |
| Charting libraries, editors, date pickers | |

Rule of thumb: **if a feature needs a click to reach, it can be a chunk.**

### Every lazy feature needs an error boundary with a working retry

`React.lazy` **memoises the rejected promise**. A plain retry button does nothing —
you must construct a *new* lazy component:

```jsx
export default function LazyDialog({ label, load, onClose, children }) {
  const [attempt, setAttempt] = useState(0);
  const [Loaded, setLoaded] = useState(() => lazy(load));
  const retry = useCallback(() => {
    setLoaded(() => lazy(load));   // a NEW lazy component, not the poisoned one
    setAttempt(n => n + 1);
  }, [load]);

  return (
    <DialogErrorBoundary key={attempt} label={label} onRetry={retry} onClose={onClose}>
      <Suspense fallback={<Fallback label={label} onClose={onClose} />}>
        {children(Loaded)}
      </Suspense>
    </DialogErrorBoundary>
  );
}
```

Two rules:
- **Declare loaders at module scope.** A loader created during render restarts the
  download on every render.
- **A failed chunk must cost only that feature.** Put the boundary inside the main
  tree so a dead network never blanks the app.

### Results

| | Before | After |
|---|---|---|
| Startup JS | 1,022 kB | **557 kB** (−45%) |
| Startup JS (gzip) | 312 kB | **162 kB** (−48%) |
| Vite >500 kB warning | present | gone |

---

## Part 2 — Rendering (main-thread time)

### Code splitting did not fix the freeze — and was never going to

After a 45% smaller bundle, the page still locked up for seconds. Different
bottleneck. The Profiler told the real story:

| Stage | Time |
|---|---|
| `dataset.request_and_json` | 317 ms |
| `projects.assemble` | 2–4 ms |
| `projects.merge_and_derive` | 3–5 ms |
| **`react.project_ledger_commit`** | **up to 2,820 ms** |

Data was never the problem. **Rendering was ~100× the cost of fetching.**

### Count your components before you theorise

```
555 rows × (1 tr + 18 td + 11 EditCell + 1 SaveCell) ≈ 17,200 components
```

Each `EditCell` carried two `useState` hooks, a layout effect, a `ResizeObserver`
and a real form control. About **97% of them were scrolled out of sight**, and all
of them were reconciled again on every keystroke.

**Do this arithmetic early.** It takes five minutes and usually ends the debate.

### Three separate causes, all worth checking

1. **No `React.memo` anywhere** — every parent state change re-rendered everything.
2. **An unmemoized derived array**, which defeated a downstream `useMemo`:

   ```js
   const rows = records.filter(passes);              // new identity every render
   const data = useMemo(() => sort(rows), [rows]);   // therefore never hits
   ```

   Memoising `rows` fixed a sort that was re-running for a background poll.
3. **A background poll re-rendering the whole tree.** Presence polled every 30 s;
   each poll reconciled 17,200 components with no user input at all.

> **Watch for derived state coupled to input state.** Here `records` depended on
> `drafts`, so one keystroke rebuilt all 555 row objects with fresh identities.
> That was the 400–900 ms-per-character cost.

### Virtualization: mount only what is visible

```
555 matching projects
        ↓  full dataset stays in memory
filters / sort / KPIs / charts / totals / export  ← all still use ALL 555
        ↓  virtualization decides ONE thing
only ~20 visible rows + overscan get a DOM node
```

Non-negotiable rules:

- **Never let the UI operate on the visible slice.** Totals, export, search and
  filters must read the full array. Verify this by reading the code, not by
  assuming: here `onExport(data)` and the footer totals both took the full array.
- **Keep editable state outside the row component.** This is what makes unmounting
  safe. If drafts live in the row, virtualization eats unsaved work. If they live
  in a parent keyed by row id, scrolling a dirty row out of view is a non-event —
  Save All, Ctrl+S and the unsaved-changes guard all keep working untouched.
- **Measure row heights if rows can vary.** Auto-growing text cells make
  fixed-height windowing drift further out of position the further you scroll.
- **Cache heights by stable row id, not by index** — so heights survive sorting
  and filtering instead of lurching the scroll position.
- **Use spacer rows** carrying the pixel height of unmounted rows, so the scrollbar
  still describes the whole list.
- **Keep the window arithmetic pure and unit-tested.** It is the part that breaks
  in ways nobody notices until a row is missing at the bottom.

### Virtualization's known costs — decide consciously

- Scrolling a focused cell out of view unmounts and blurs it. Fine *if* the value
  is already committed to parent state on each keystroke.
- Browser Ctrl+F cannot find unmounted rows. Mitigated by in-app search over the
  full dataset.
- Printing renders only mounted rows. Check for a print feature before shipping.
- You trade one huge commit for many small ones while scrolling. **Those must stay
  under ~16 ms** or scrolling feels janky.

### Result

**≈17,200 components → ≈1,085.** A ~16× reduction, for +2.5 kB of bundle.

---

## Part 3 — Measuring honestly

### StrictMode doubles every render in development

`<StrictMode>` double-invokes render in dev, and the Profiler's `actualDuration`
counts both passes plus dev-only bookkeeping. **Production is typically 2–4×
faster.** Never compare a dev "before" with a production "after" — the improvement
will be mostly imaginary.

### Cap your metrics buffer, then remember you capped it

This instrumentation kept the last 160 entries. Once virtualized, *every scroll
frame* produced a commit entry — so about three seconds of scrolling silently
evicted every startup measurement.

**Capture startup numbers before interacting with the page.**

### Instrument stages, not guesses

A tiny privacy-safe timing module paid for itself repeatedly:

```js
const finish = startLedgerTiming("feature.xlsx_chunk");
try   { const m = await importer(); finish({ outcome: "ok" });    return m; }
catch (e) { finish({ outcome: "error" }); throw e; }
```

Two design choices worth copying:
- **An allowlist of safe fields.** Stage names, durations and counts only — never
  values, usernames, ids, URLs or error messages.
- **Expensive diagnostics behind a flag** (`?ledgerMetrics=1`), so measuring the
  payload size is not part of every normal sign-in.

Record `phase` from the React Profiler. The **mount vs update** split immediately
separates "the first render is slow" from "every interaction is slow" — two very
different investigations.

---

## Checklist for a new system

**Before writing a feature**

- [ ] Will this library be needed on first paint? If not, plan the dynamic import now.
- [ ] Is any state that must survive unmounting stored in a child component?

**Before shipping**

- [ ] Read every build warning, especially `INEFFECTIVE_DYNAMIC_IMPORT`.
- [ ] Check the initial chunk size and what is actually in it.
- [ ] Count components for the largest realistic dataset, not the demo one.
- [ ] Confirm derived arrays feeding a `useMemo` are themselves memoized.
- [ ] Check what background polling costs in re-renders.
- [ ] Verify every lazy feature fails gracefully with a working retry.

**When measuring**

- [ ] Same build for before and after (production for the number that matters).
- [ ] Same dataset size.
- [ ] Capture startup metrics before scrolling or interacting.
- [ ] Report mount and update commits separately.
- [ ] State plainly what you could not measure.

---

## Order of operations

Do these in order. Each step's measurement tells you whether the next is needed.

1. **Measure.** Bundle composition and a runtime profile. Do not skip to fixes.
2. **Fix ineffective dynamic imports.** Often the largest win for the least risk.
3. **Split genuinely optional features** into chunks, each with an error boundary.
4. **Re-measure.** If the freeze remains, it was never a download problem.
5. **Profile rendering.** Count components; find what triggers re-renders.
6. **Memoize derived arrays.** Cheap, low-risk, sometimes sufficient.
7. **Virtualize** only if measurement justifies it — and keep the full dataset live.
8. **Re-measure against the original baseline** and report both numbers.
