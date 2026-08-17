/* The one editable table cell, shared by the ledger table and the target
   dialogs that are downloaded on demand. It lives in its own file because
   ./shared.js holds no components: mixing the two breaks fast refresh. */

import { useLayoutEffect, useRef, useState } from "react";
import { cleanText as CLEAN, numberOrNull as toNum } from "../lib/projectImport";
import { fractionFromPercent, percentFromFraction } from "../lib/panelData";
import { T, BODY, MONO, money, PROJECT_STATUS_OPTIONS } from "./shared";

const PROJECT_STATUS_TONE = {
  /* Grey, and deliberately the flattest of the five: UNSPECIFIED is the
     absence of an answer, so it must not compete with the statuses that carry
     one. It is also what a blank status renders as — see below. */
  UNSPECIFIED: { background: T.paper2, border: T.rule, color: T.inkFaint },
  /* Blue, borrowed from the cash tone. Prospective work, distinct from
     ONGOING's amber so the two are not read as the same stage at a glance. */
  "NOT YET AWARDED": { background: "#E8F0F7", border: T.cash, color: T.cash },
  ONGOING: { background: "#FFF4C2", border: "#D2A21C", color: "#765900" },
  COMPLETED: { background: "#E4EFEC", border: T.collected, color: T.collected },
  SUSPENDED: { background: "#FBEEEC", border: T.bad, color: T.bad },
};


/* The SWA cell is percent on both sides of the keyboard — 10.1 in, "10.1%"
   back, 0.101 stored (see fractionFromPercent). The typed text is held
   separately while the cell has focus: deriving it from the stored fraction on
   every keystroke would eat the dot the moment somebody typed "10.". */
/* `wrap` is for the columns that hold a sentence rather than a word. A single
   line input showed only as much of a saved Balance Work as the column was
   wide — "Emulsified Asphalt, Wearing Course Hot Lai…" — and the rest could be
   reached only by clicking into the cell and scrolling it. A textarea grown to
   its own content shows every line of it while staying one field: same value,
   same onChange, same Escape. */
export default function EditCell({ value, type, onChange, wrap = false, disabled = false }) {
  const [focus, setFocus] = useState(false);
  /* null means "not being typed into"; "" is a real value the user cleared */
  const [typed, setTyped] = useState(null);
  const v = value ?? "";
  const numericValue = type === "amount" ? toNum(v) : null;
  let displayValue = v;
  if (type === "amount" && !focus && v !== "")
    displayValue = numericValue === null ? v : money(numericValue);
  else if (type === "pct") {
    /* Focused and blurred must show the same number. pct() rounds to one
       decimal, so a typed 58.45 read back as "58.5%" and the cell disagreed
       with what the user had just entered. percentFromFraction is the exact
       inverse of what the keystroke handler stored, so what comes back is
       precisely what was typed — 58.4 stays 58.4%, 58.45 stays 58.45% — with
       the % sign added on blur. */
    const asPercent = percentFromFraction(v);
    displayValue = focus ? (typed ?? asPercent) : (asPercent === "" ? "" : asPercent + "%");
  }

  /* Only text wraps. The number, percent and date cells reformat themselves on
     blur and are a single token by construction, so growing them would add
     height no value can ever fill. */
  const multiline = wrap && type === "text";
  const grow = useRef(null);
  /* Measured before paint, or a cell that is two lines tall would render one
     line tall for a frame every time the row re-renders. */
  useLayoutEffect(() => {
    const el = grow.current;
    if (!el) return;
    const fit = () => {
      /* auto first: scrollHeight never reports less than the height already
         set, so without this a cell that lost a line would keep the old one. */
      el.style.height = "auto";
      /* scrollHeight is content plus padding and stops short of the border, so
         a border-box height set from it alone clips the last line by a pixel. */
      el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return undefined;
    /* How many lines the same text takes depends on how wide the column ended
       up, and that is settled by the browser after this runs — and again
       whenever the window is resized. Width only: fit() changes the height, so
       reacting to height here is how this would loop forever. */
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [multiline, displayValue]);

  if (type === "status") {
    const current = CLEAN(v).toUpperCase();
    /* A blank status *is* UNSPECIFIED, so it now selects the real option and
       takes its colour rather than showing a disabled placeholder. Display
       only — nothing is written until somebody picks a value, so a project
       nobody has touched keeps its empty status in the data and in the chart
       instead of being silently reclassified by a render. */
    const effective = current || "UNSPECIFIED";
    const recognized = PROJECT_STATUS_OPTIONS.includes(effective);
    const tone = PROJECT_STATUS_TONE[effective] || { background: T.paper2, border: T.rule, color: T.inkSoft };
    return (
      <select
        aria-label="Project status"
        disabled={disabled}
        value={recognized ? effective : "__current__"}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
        style={{
          width: "100%", border: `1px solid ${focus ? T.ink : tone.border}`,
          background: tone.background, color: tone.color, borderRadius: 2, padding: "2px 4px",
          fontFamily: MONO, fontSize: 11.5, fontWeight: 700, outline: "none",
          cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.72 : 1,
        }}
      >
        {/* Only an unrecognised *non-blank* status still needs this — a value
            some older import wrote that is not one of the five. Blank is now
            handled by UNSPECIFIED above. */}
        {!recognized && <option value="__current__" disabled>{current}</option>}
        {PROJECT_STATUS_OPTIONS.map((status) => (
          <option key={status} value={status} style={{ color: PROJECT_STATUS_TONE[status].color }}>
            {status}
          </option>
        ))}
      </select>
    );
  }

  const field = {
    width: "100%", border: `1px solid ${focus ? T.collected : "transparent"}`,
    background: focus ? T.panel : "transparent", borderRadius: 2, padding: "1px 4px",
    fontFamily: type === "text" ? BODY : MONO, fontSize: 11.5, color: T.ink,
    textAlign: type === "qty" || type === "amount" || type === "pct" ? "right" : "left", outline: "none",
  };
  const handlers = {
    onFocus: () => setFocus(true),
    onBlur: () => { setFocus(false); setTyped(null); },
  };

  if (multiline) return (
    <textarea
      ref={grow}
      rows={1}
      value={displayValue}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      {...handlers}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.currentTarget.blur(); return; }
        /* The column stores one run of text, so Enter leaves the cell the way
           it does in every other cell instead of writing a newline into the
           value. Shift+Enter is left alone for anybody who wants one. */
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
      }}
      style={{
        ...field, display: "block", boxSizing: "border-box", resize: "none",
        /* the element is sized to its own content, so it never has anything to
           scroll — a scrollbar here would only steal width from the text */
        overflow: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.35,
        opacity: disabled ? 0.72 : 1, cursor: disabled ? "default" : "text",
      }}
    />
  );

  return (
    <input
      value={displayValue}
      disabled={disabled}
      type={type === "date" ? "date" : "text"}
      inputMode={type === "qty" || type === "amount" || type === "pct" ? "decimal" : undefined}
      title={type === "pct" ? "Type the percentage itself — 10.1 is 10.1%" : undefined}
      onChange={(e) => {
        if (type === "pct") {
          const text = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
          setTyped(text);
          onChange(fractionFromPercent(text));
          return;
        }
        onChange(type === "amount"
          ? e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1")
          : e.target.value);
      }}
      {...handlers}
      onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
      style={{ ...field, opacity: disabled ? 0.72 : 1, cursor: disabled ? "default" : "text" }}
    />
  );
}
