import { useState, useMemo, useRef, useEffect } from "react";
import * as XLSX from "xlsx";
import { supabase, isConfigured } from "./lib/supabase";

/* ==================================================================
   Project Ledger — QM Builders
   Attributes : PROJECT_MASTER_DATA.xlsx › "QMB PROJECTS" + "QM LICENSES"
   Money      : UPDATED COLLECTIBLES.xlsx › "COLLECTIBLES"

   Nothing is built in. Both workbooks are parsed in the browser and the parsed
   result is kept in one shared Supabase row, so the page opens with whatever was
   imported last and a re-import replaces it for everyone.
================================================================== */

const EMPTY_STORE = { coll: [], dim: new Map() };
const NO_DATA_LABEL = "No data yet \u00b7 upload the workbooks to begin";

/* ---------------- parsing helpers ---------------- */

const NORM = (s) => String(s ?? "").toUpperCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
const CLEAN = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());
const KEY = (v) => NORM(v);

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const s = String(v).replace(/[()]/g, "").replace(/[^0-9.-]/g, "");
  if (!s || s === "-" || s === ".") return null;
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return /^\(/.test(String(v)) ? -n : n;
}

const LIC_MAP = {
  "QM BUIDERS": "QM BUILDERS", "QMB": "QM BUILDERS", "QM BUILDER": "QM BUILDERS",
  "QG DEVELOPMENT CORPORATION": "QG DEVELOPMENT CORP.",
  "ADAMANT DEVELOPMENT CORPORATION": "ADAMANT DEVELOPMENT CORP.",
};
const normLic = (s) => { const v = NORM(s); return LIC_MAP[v] || v; };
const normStatus = (s) => NORM(s).replace("ON-GOING", "ONGOING").replace("ON GOING", "ONGOING");

function findSheet(wb, tests) {
  return wb.SheetNames.find((n) => tests.some((t) => t(NORM(n))));
}
function grid(wb, name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" });
}
function headerRow(g) {
  for (let i = 0; i < Math.min(12, g.length); i++)
    if ((g[i] || []).some((c) => NORM(c).includes("PROJECT ID"))) return i;
  return 0;
}
/** exact matches win over partial ones, so "GROSS AMOUNT" never grabs "COLLECTIBLE GROSS AMOUNT" */
function findCol(headers, exacts = [], parts = []) {
  for (const e of exacts) { const i = headers.indexOf(NORM(e)); if (i > -1) return i; }
  for (const p of parts) {
    const needles = Array.isArray(p) ? p.map(NORM) : [NORM(p)];
    const i = headers.findIndex((h) => needles.every((n) => h.includes(n)));
    if (i > -1) return i;
  }
  return -1;
}

/* ---------------- readers ---------------- */

function readMaster(wb) {
  const log = [];
  const dim = new Map();
  const want = [
    { test: (n) => n.includes("QMB PROJECT"), kind: "qmb" },
    { test: (n) => n.includes("QM LICENSE"), kind: "lic" },
  ];
  for (const w of want) {
    const sn = wb.SheetNames.find((n) => w.test(NORM(n)));
    if (!sn) { log.push({ warn: true, text: `Sheet for ${w.kind === "qmb" ? "QMB Projects" : "QM Licenses"} not found` }); continue; }
    const g = grid(wb, sn);
    const hr = headerRow(g);
    const H = (g[hr] || []).map(NORM);
    const c = {
      id: findCol(H, ["PROJECT ID"], ["PROJECT ID"]),
      district: findCol(H, ["DISTRICT"], ["DISTRICT"]),
      location: findCol(H, ["LOCATION"], ["LOCATION"]),
      category: findCol(H, ["PROJECT CATEGORY"], ["CATEGORY"]),
      engineer: findCol(H, ["SENIOR ENGINEER"], [["SENIOR", "ENGINEER"]]),
      name: findCol(H, ["PROJECT NAME"], ["PROJECT NAME"]),
      year: findCol(H, ["YEAR", "PROJECT YEAR"], ["YEAR"]),
      contract: findCol(H, ["CONTRACT AMOUNT/ REVISED", "CONTRACT AMOUNT", "CONTRACT COST"], ["CONTRACT AMOUNT"]),
      license: w.kind === "lic"
        ? findCol(H, ["CONTRACTORS LICENSE"], [["CONTRACTOR", "LICENSE"]])
        : findCol(H, ["LICENSE"], ["LICENSE"]),
      status: w.kind === "lic" ? findCol(H, ["PROJECT STATUS BASED ON ACTUAL"], [["PROJECT STATUS"]]) : -1,
      swa: w.kind === "lic" ? findCol(H, ["SWA %"], ["SWA"]) : -1,
    };
    if (c.id < 0) { log.push({ warn: true, text: `${sn}: no Project ID column` }); continue; }

    let n = 0;
    for (let r = hr + 1; r < g.length; r++) {
      const row = g[r] || [];
      const id = KEY(row[c.id]);
      if (!id || id === "TOTAL") continue;
      const d = dim.get(id) || {};
      const put = (f, i, fn) => {
        if (i < 0 || d[f]) return;
        const v = fn ? fn(row[i]) : CLEAN(row[i]);
        if (v && v !== "-") d[f] = v;
      };
      // QM Licenses is the authority on license; QMB Projects on everything else it carries
      put("license", c.license, normLic);
      put("engineer", c.engineer, NORM);
      put("district", c.district, NORM);
      put("category", c.category, NORM);
      put("location", c.location, NORM);
      put("name", c.name);
      put("status", c.status, NORM);
      if (!d.year) { const y = toNum(row[c.year]); if (y) d.year = Math.round(y); }
      if (d.swa === undefined && c.swa >= 0) { const w2 = toNum(row[c.swa]); if (w2 !== null) d.swa = w2; }
      if (!d.contract) { const a = toNum(row[c.contract]); if (a) d.contract = a; }
      dim.set(id, d);
      n++;
    }
    log.push({ text: `${sn}: ${n} rows read` });
  }
  return { dim, log };
}

function readCollectibles(wb) {
  const log = [];
  const sn = findSheet(wb, [(n) => n.includes("COLLECTIBLE")]);
  if (!sn) return { rows: null, log: [{ warn: true, text: "No sheet named COLLECTIBLES found" }] };
  const g = grid(wb, sn);
  const hr = headerRow(g);
  const H = (g[hr] || []).map(NORM);
  const c = {
    id: findCol(H, ["PROJECT ID#", "PROJECT ID"], ["PROJECT ID"]),
    office: findCol(H, ["IMPLEMENTING OFFICE"], ["IMPLEMENTING"]),
    contract: findCol(H, ["CONTRACT AMOUNT"], ["CONTRACT AMOUNT"]),
    billpct: findCol(H, ["BILLING %"], ["BILLING"]),
    gross: findCol(H, ["GROSS AMOUNT"], []),
    net: findCol(H, ["NET AMOUNT (CHECK AMOUNT)"], [["NET AMOUNT", "CHECK"]]),
    cg: findCol(H, ["COLLECTIBLE GROSS AMOUNT"], [["COLLECTIBLE", "GROSS"]]),
    cc: findCol(H, ["COLLECTIBLE CASH BAL"], [["COLLECTIBLE", "CASH"]]),
    cr: findCol(H, ["COLLECTIBLE RETENTION"], [["COLLECTIBLE", "RETENTION"]]),
    bal: findCol(H, [], [["BALANCE FOR COLLECTION"]]),
    netbal: findCol(H, [], [["NET BAL", "COLLECTION"]]),
    status: findCol(H, ["STATUS"], ["STATUS"]),
    remarks: findCol(H, ["REMARKS"], ["REMARKS"]),
  };
  if (c.id < 0) return { rows: null, log: [{ warn: true, text: `${sn}: no Project ID column` }] };

  const rows = [];
  const seen = new Set();
  const get = (row, i) => (i < 0 ? null : toNum(row[i]));
  for (let r = hr + 1; r < g.length; r++) {
    const row = g[r] || [];
    const raw = CLEAN(row[c.id]);
    const id = KEY(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      key: id, id: raw,
      office: CLEAN(row[c.office]) || "UNSPECIFIED",
      status: normStatus(row[c.status]),
      remarks: CLEAN(row[c.remarks]),
      contract: get(row, c.contract), billpct: get(row, c.billpct),
      gross: get(row, c.gross), net: get(row, c.net),
      cg: get(row, c.cg), cc: get(row, c.cc), cr: get(row, c.cr),
      bal: get(row, c.bal), netbal: get(row, c.netbal),
    });
  }
  log.push({ text: `${sn}: ${rows.length} projects read` });
  const missing = Object.entries(c).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) log.push({ warn: true, text: `Columns not matched: ${missing.join(", ")}` });
  return { rows, log };
}

/* ---------------- assembly ---------------- */

function assemble(coll, dim) {
  return coll.map((m) => {
    const d = dim.get(m.key) || {};
    const r = {
      id: m.id,
      name: d.name || "",
      district: d.district || "UNSPECIFIED",
      license: d.license || "UNSPECIFIED",
      engineer: d.engineer || "UNASSIGNED",
      category: d.category || "UNSPECIFIED",
      location: d.location || "UNSPECIFIED",
      status: m.status || d.status || "UNSPECIFIED",
      swa: d.swa ?? null,
      office: m.office,
      year: d.year || 0,
      /* these five come strictly from the collectibles workbook — no master fallback,
         so a blank there shows as blank rather than quietly borrowing an older figure */
      contract: m.contract ?? null,
      billpct: m.billpct, gross: m.gross, net: m.net,
      cg: m.cg, cc: m.cc, cr: m.cr, bal: m.bal, netbal: m.netbal,
      remarks: m.remarks,
    };
    r.yearStr = r.year ? String(r.year) : "UNSPECIFIED";
    r._hay = [r.id, r.name, r.district, r.license, r.engineer, r.category,
      r.location, r.status, r.office, r.remarks].join(" ").toLowerCase();
    return r;
  });
}

/* ---------------- shared dataset ----------------
   There is no built-in data. Whatever the last person imported is parsed here in
   the browser and the result is kept in one shared row, so everybody else opens
   the same figures without re-uploading. The stored payload is the {coll, dim}
   store itself — dim is carried as entries because a Map is not JSON — which is
   why importing one workbook on its own still joins against the other.
------------------------------------------------- */

const DATASET_TABLE = "project_ledger_dataset";
const DATASET_ID = "current";
const DATASET_VERSION = 1;

const serialiseStore = (store) => ({
  version: DATASET_VERSION,
  coll: store.coll,
  dim: [...store.dim.entries()],
});
const deserialiseStore = (payload) => ({
  coll: Array.isArray(payload?.coll) ? payload.coll : [],
  dim: new Map(Array.isArray(payload?.dim) ? payload.dim : []),
});

/** null when nothing has been uploaded yet, or when Supabase is not configured */
async function loadDataset() {
  if (!isConfigured || !supabase) return null;
  const { data, error } = await supabase.from(DATASET_TABLE)
    .select("payload, source_label, uploaded_by_username, uploaded_at")
    .eq("id", DATASET_ID).maybeSingle();
  if (error) throw error;
  if (!data?.payload) return null;
  return {
    store: deserialiseStore(data.payload),
    label: data.source_label || "",
    username: data.uploaded_by_username || "",
    at: data.uploaded_at || "",
  };
}

async function saveDataset(store, label, userId, username) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  const at = new Date().toISOString();
  const { error } = await supabase.from(DATASET_TABLE).upsert({
    id: DATASET_ID,
    payload: serialiseStore(store),
    source_label: label,
    project_count: store.coll.length,
    uploaded_by: userId,
    uploaded_by_username: username || "Unknown user",
    uploaded_at: at,
  }, { onConflict: "id" });
  if (error) throw error;
  return at;
}

/* ---------------- manual entries ----------------
   Targets, dates, actual output and remarks are typed in by hand, so they must
   survive a re-import. They live in their own store keyed by project ID and are
   never touched by the Excel readers — importing replaces only the imported
   columns and leaves everything below untouched.
------------------------------------------------- */

async function loadManual() {
  if (!isConfigured || !supabase) return {};
  const { data, error } = await supabase.from("project_manual_updates")
    .select("project_id, status, contract_amount, target_qty, unit, start_date, target_completion, actual_completion, actual_output, remarks");
  if (error) throw error;
  return Object.fromEntries((data || []).map((row) => {
    const manual = {
      target: row.target_qty, unit: row.unit, start: row.start_date,
      due: row.target_completion, finish: row.actual_completion,
      actual: row.actual_output, note: row.remarks,
    };
    if (row.status !== null && row.status !== undefined) manual.status = row.status;
    if (row.contract_amount !== null && row.contract_amount !== undefined) manual.contract = row.contract_amount;
    return [row.project_id, manual];
  }));
}
async function saveManualRow(id, values, oldValues, userId, username, changedFields) {
  if (!isConfigured || !supabase) throw new Error("Supabase is not configured.");
  if (values.contract !== "" && values.contract !== null && toNum(values.contract) === null)
    throw new Error("Contract must be a numeric amount.");
  const { error } = await supabase.from("project_manual_updates").upsert({
    project_id: id,
    status: CLEAN(values.status) || null,
    contract_amount: values.contract === "" || values.contract === null ? null : toNum(values.contract),
    target_qty: values.target === "" || values.target === null ? null : toNum(values.target),
    unit: values.unit || null,
    start_date: values.start || null,
    target_completion: values.due || null,
    actual_completion: values.finish || null,
    actual_output: values.actual === "" || values.actual === null ? null : toNum(values.actual),
    remarks: values.note || null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "project_id" });
  if (error) throw error;

  const auditFields = [
    ["status", "Status"], ["contract", "Contract"],
    ["target", "Target qty"], ["unit", "Unit"], ["start", "Start date"],
    ["due", "Target completion"], ["finish", "Actual completion"],
    ["actual", "Actual output"], ["note", "Remarks"],
  ];
  const changes = auditFields
    .filter(([field]) => !changedFields || changedFields.has(field))
    .filter(([field]) => String(oldValues?.[field] ?? "") !== String(values?.[field] ?? ""))
    .map(([field, label]) => ({
      project_id: id,
      column_name: label,
      old_value: oldValues?.[field] ?? null,
      new_value: values?.[field] ?? null,
      changed_by: userId,
      changed_by_username: username || "Unknown user",
    }));
  if (changes.length) {
    const { error: auditError } = await supabase.from("project_manual_update_audit").insert(changes);
    if (auditError) throw auditError;
  }
}

const DAY = 86400000;
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
function daysUntil(due) {
  if (!due) return null;
  const t = Date.parse(due + "T00:00:00");
  return isNaN(t) ? null : Math.round((t - today0()) / DAY);
}
/* days from `from` to `to`, both yyyy-mm-dd; null when either is missing or
   unparseable. Positive means `to` falls after `from`. */
function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(from + "T00:00:00"), b = Date.parse(to + "T00:00:00");
  return isNaN(a) || isNaN(b) ? null : Math.round((b - a) / DAY);
}
const fmtDate = (s) => {
  if (!s) return "";
  const t = Date.parse(s + "T00:00:00");
  if (isNaN(t)) return s;
  const d = new Date(t);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

/* ---------------- presentation ---------------- */

const DIMS = [
  { k: "district", label: "District", w: 190 },
  { k: "category", label: "Project category", w: 190 },
  { k: "license", label: "License", w: 260 },
  { k: "yearStr", label: "Project year", w: 140 },
  { k: "engineer", label: "Senior engineer", w: 210 },
  { k: "office", label: "Implementing office", w: 250 },
  { k: "location", label: "Location", w: 220 },
  { k: "status", label: "Status", w: 160 },
  { k: "hasTarget", label: "Targets", w: 150 },
];

const T = {
  paper: "#E9EDE7", paper2: "#F4F7F2", panel: "#FFFFFF",
  ink: "#16211C", inkSoft: "#4C5B53", inkFaint: "#7F8D84",
  rule: "#C6CEC4", ruleSoft: "#DEE4DA",
  collected: "#0E5B57", works: "#9A4B12", retention: "#6E6014", cash: "#3C6E9E", bad: "#8C2F26",
};
const DISPLAY = '"Archivo","Helvetica Neue",system-ui,sans-serif';
const BODY = '"IBM Plex Sans",system-ui,-apple-system,sans-serif';
const MONO = '"IBM Plex Mono",ui-monospace,Menlo,monospace';

const P = "\u20B1";
const money = (n) => n === null || n === undefined || !isFinite(n) ? "—"
  : (n < 0 ? "-" : "") + P + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const compact = (n) => {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e9) return s + P + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + P + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + P + (a / 1e3).toFixed(0) + "K";
  return money(n);
};
const qty = (n) => (n === null || n === undefined || n === "" || isNaN(Number(n)))
  ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (n) => (n === null || n === undefined || !isFinite(n) ? "—" : (n * 100).toFixed(1) + "%");
const sum = (rows, k) => rows.reduce((t, r) => t + (r[k] || 0), 0);

const COLS = [
  { k: "id", label: "ID", stick: true, w: 92 },
  { k: "district", label: "District" },
  { k: "license", label: "License" },
  { k: "engineer", label: "Senior engineer" },
  { k: "category", label: "Category" },
  { k: "location", label: "Location" },
  { k: "status", label: "Status", edit: "status", w: 160 },
  { k: "contract", label: "Contract", edit: "amount", money: true, w: 101 },
  { k: "swa", label: "SWA %", pct: true },
  { k: "billpct", label: "Billed %", pct: true },
  { k: "net", label: "Collected (net)", money: true, group: "collection" },
  { k: "cg", label: "Balance works", money: true, group: "collection" },
  { k: "cr", label: "Retention", money: true, group: "collection" },
  { k: "bal", label: "Balance for collection", money: true, w: 119, group: "collection" },
  { k: "netbal", label: "Net balance", money: true, group: "collection" },
  { k: "target", label: "Target qty", edit: "qty", w: 84 },
  { k: "unit", label: "Unit", edit: "text", w: 76 },
  { k: "start", label: "Start date", edit: "date", w: 128 },
  { k: "due", label: "Target completion", edit: "date", w: 132 },
  /* the day the target was actually met — what separates "Delivered on time"
     from plain "Delivered"; blank means unknown, never on time */
  { k: "finish", label: "Actual completion", edit: "date", w: 132 },
  { k: "actual", label: "Actual output", edit: "qty", w: 88 },
  { k: "note", label: "Remarks", edit: "text", w: 190 },
];

const AUDIT_FIELD_LABELS = Object.fromEntries(COLS.filter((c) => c.edit).map((c) => [c.k, c.label]));

/* the table hides the long project name; the export still carries it */
const EXPORT_COLS = [
  COLS[0],
  { k: "name", label: "Project name" },
  ...COLS.slice(1),
];

function Panel({ title, right, children }) {
  return (
    <section className="mb-3 rounded-sm"
             style={{ background: T.panel, border: `1px solid ${T.rule}`, boxShadow: "0 10px 26px -20px rgba(22,33,28,.6)",
                      height: "100%", display: "flex", flexDirection: "column" }}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <h3 className="text-[11px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 700 }}>{title}</h3>
          {right}
        </div>
      )}
      <div className="p-3" style={{ flex: 1, display: "flex", flexDirection: "column" }}>{children}</div>
    </section>
  );
}

function Kpi({ label, value, meta, color }) {
  return (
    <div className="rounded-sm px-3 pb-3 pt-2.5"
         style={{ background: T.panel, border: `1px solid ${T.rule}`, borderTop: `3px solid ${color || T.ink}` }}>
      <div className="text-[10px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>{label}</div>
      <div className="mt-1 text-xl leading-tight" style={{ fontFamily: MONO, fontWeight: 600, color: color || T.ink }}>{value}</div>
      <div className="mt-0.5 text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>{meta}</div>
    </div>
  );
}

function Meter({ label, segments, legend }) {
  const total = segments.reduce((t, s) => t + Math.max(0, s.value || 0), 0) || 1;
  return (
    <div>
      <div className="mb-1.5 text-[10px] uppercase tracking-widest" style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>{label}</div>
      <div className="flex h-7 overflow-hidden" style={{ border: `1px solid ${T.ink}`, background: T.paper2 }}>
        {segments.map((s, i) => (
          <div key={i} title={`${s.label} — ${money(s.value)}`}
               style={{ width: (Math.max(0, s.value || 0) / total) * 100 + "%", background: s.color, transition: "width .35s ease" }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs" style={{ color: T.inkSoft }}>
        {legend.map((l, i) => (
          <span key={i}>
            {l.color && <span className="mr-1.5 inline-block h-2.5 w-2.5 align-[-1px]" style={{ background: l.color }} />}
            {l.label} <b style={{ fontFamily: MONO, color: T.ink }}>{l.value}</b>
            {l.extra ? <span style={{ color: T.inkFaint }}> · {l.extra}</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- import panel ---------------- */

function ImportPanel({ onLoad, sourceLabel, uploadedBy, log, busy, onReload, reloading, forceOpen }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const shown = open || forceOpen;

  const take = (files) => { if (files && files.length) onLoad([...files]); };

  return (
    <div className="mb-4 rounded-sm" style={{ background: T.panel, border: `1px solid ${T.rule}` }}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="text-[11.5px]" style={{ fontFamily: MONO, color: T.inkSoft }}>
          Data source: <b style={{ color: T.ink }}>{sourceLabel}</b>
          {uploadedBy && <span style={{ color: T.inkFaint }}> · {uploadedBy}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onReload} disabled={reloading} className="rounded-sm px-2.5 py-1 text-xs"
                  style={{ border: `1px solid ${T.rule}`, color: T.inkSoft, opacity: reloading ? 0.6 : 1 }}>
            {reloading ? "Reloading…" : "Reload saved data"}
          </button>
          {/* with no ledger loaded there is nothing to close back to, so the drop
              zone stays open and the toggle is left out */}
          {!forceOpen && (
            <button onClick={() => setOpen(!open)} className="rounded-sm px-2.5 py-1 text-xs"
                    style={{ border: `1px solid ${T.ink}`, background: open ? T.ink : T.panel,
                             color: open ? T.paper2 : T.ink }}>
              {open ? "Close" : "Update from Excel"}
            </button>
          )}
        </div>
      </div>

      {shown && (
        <div className="px-3 pb-3" style={{ borderTop: `1px solid ${T.ruleSoft}` }}>
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
            className="mt-3 rounded-sm px-4 py-7 text-center"
            style={{ border: `2px dashed ${over ? T.collected : T.rule}`, background: over ? "#F0F6F4" : T.paper2 }}
          >
            <div className="text-sm" style={{ fontFamily: DISPLAY, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" }}>
              Drop the two workbooks here
            </div>
            <p className="mx-auto mt-1.5 max-w-xl text-xs" style={{ color: T.inkSoft }}>
              The project master workbook (read from <b>QMB Projects</b> and <b>QM Licenses</b>) and the
              updated collectibles workbook (read from <b>Collectibles</b>). Drop either one on its own or both
              together — each file is identified by its sheet names, so the order doesn't matter. The workbooks
              are parsed in this browser and only the resulting figures are saved, replacing the ledger everyone
              sees. Hand-typed targets, dates and remarks are keyed by project ID and are not touched.
            </p>
            <input ref={inputRef} type="file" accept=".xlsx,.xls,.xlsm" multiple hidden
                   onChange={(e) => take(e.target.files)} />
            <button onClick={() => inputRef.current && inputRef.current.click()} disabled={busy}
                    className="mt-3 rounded-sm px-3 py-1.5 text-xs"
                    style={{ border: `1px solid ${T.ink}`, background: T.ink, color: T.paper2, opacity: busy ? 0.6 : 1 }}>
              {busy ? "Reading…" : "Choose files"}
            </button>
          </div>

          {log.length > 0 && (
            <div className="mt-3 rounded-sm px-3 py-2" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
              {log.map((l, i) => (
                <div key={i} className="text-[11.5px]" style={{ fontFamily: MONO, color: l.warn ? T.bad : T.inkSoft }}>
                  {l.warn ? "! " : "· "}{l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyLedger({ loading, configured }) {
  return (
    <div className="rounded-sm px-6 py-12 text-center"
         style={{ background: T.panel, border: `1px solid ${T.rule}` }}>
      <div className="text-base uppercase"
           style={{ fontFamily: DISPLAY, fontWeight: 800, letterSpacing: ".05em" }}>
        {loading ? "Loading the ledger…" : "No project data yet"}
      </div>
      {!loading && (
        <p className="mx-auto mt-2 max-w-lg text-xs" style={{ color: T.inkSoft }}>
          {configured
            ? "Use the drop zone above to import the project master and collectibles workbooks. The figures are saved once and everybody signed in sees them."
            : "Supabase is not configured for this build, so nothing can be loaded or saved. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then import the workbooks."}
        </p>
      )}
    </div>
  );
}

/* ---------------- filter bar ---------------- */

function FilterDropdown({ dim, counts, selected, onToggle, onClearOne, open, onOpen }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => [...counts.entries()]
    .filter(([v]) => !q || v.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), [counts, q]);

  const on = selected.size > 0;
  const summary = selected.size === 0 ? "All"
    : selected.size === 1 ? [...selected][0]
    : selected.size + " selected";

  return (
    <div className="relative" style={{ width: dim.w, minWidth: 130, flex: "1 1 auto", maxWidth: 320 }}>
      <div className="mb-1 text-[9.5px] uppercase"
           style={{ fontFamily: DISPLAY, fontWeight: 600, letterSpacing: ".09em", color: T.inkSoft }}>
        {dim.label}
      </div>
      <button
        onClick={() => onOpen(open ? null : dim.k)}
        className="flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-xs"
        style={{
          border: `1px solid ${on || open ? T.ink : T.rule}`,
          background: on ? T.ink : T.panel,
          color: on ? T.paper2 : T.ink,
          boxShadow: open ? `0 0 0 2px ${T.collected}33` : "none",
        }}
      >
        <span className="truncate" title={summary}>{summary}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {on && (
            <span className="rounded-full px-1.5 text-[9.5px]"
                  style={{ fontFamily: MONO, background: T.paper2, color: T.ink }}>{selected.size}</span>
          )}
          <span style={{ fontFamily: MONO, fontSize: 10, opacity: 0.7 }}>{open ? "\u25B2" : "\u25BC"}</span>
        </span>
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 rounded-sm p-2"
             style={{ top: "100%", width: Math.max(dim.w, 230), background: T.panel,
                      border: `1px solid ${T.ink}`, boxShadow: "0 18px 40px -20px rgba(22,33,28,.55)" }}>
          {counts.size > 8 && (
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="find\u2026"
                   className="mb-1.5 w-full rounded-sm px-2 py-1 text-xs" style={{ border: `1px solid ${T.rule}` }} />
          )}
          <div className="max-h-64 overflow-auto">
            {list.length === 0 && <div className="px-1 py-2 text-[11px]" style={{ color: T.inkFaint }}>No match.</div>}
            {list.map(([v, n]) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs"
                     style={{ opacity: n ? 1 : 0.4 }}>
                <input type="checkbox" checked={selected.has(v)} onChange={() => onToggle(dim.k, v)}
                       style={{ accentColor: T.collected }} />
                <span className="flex-1 truncate" title={v}>{v}</span>
                <span className="text-[10.5px]" style={{ fontFamily: MONO, color: T.inkFaint }}>{n}</span>
              </label>
            ))}
          </div>
          {on && (
            <button onClick={() => onClearOne(dim.k)}
                    className="mt-1.5 w-full rounded-sm py-1 text-[11px]"
                    style={{ border: `1px solid ${T.rule}`, color: T.inkSoft }}>
              Clear {dim.label.toLowerCase()}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterBar({ q, setQ, filters, countsFor, onToggle, onClearOne, onClearAll, anyActive }) {
  const [open, setOpen] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(null); };
    const esc = (e) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={ref} className="sticky top-0 z-20 mb-3 rounded-sm px-3 pb-3 pt-2.5"
         style={{ background: T.panel, border: `1px solid ${T.rule}`, boxShadow: "0 10px 26px -22px rgba(22,33,28,.7)" }}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative" style={{ width: 220, minWidth: 160, flex: "1 1 auto", maxWidth: 320 }}>
          <div className="mb-1 text-[9.5px] uppercase"
               style={{ fontFamily: DISPLAY, fontWeight: 600, letterSpacing: ".09em", color: T.inkSoft }}>Search</div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID, project name, remarks\u2026"
                 className="w-full rounded-sm px-2.5 py-1.5 text-xs"
                 style={{ border: `1px solid ${q ? T.ink : T.rule}` }} />
        </div>

        {DIMS.map((d) => (
          <FilterDropdown key={d.k} dim={d} counts={countsFor(d.k)} selected={filters[d.k]}
                          onToggle={onToggle} onClearOne={onClearOne}
                          open={open === d.k} onOpen={setOpen} />
        ))}

        <button onClick={onClearAll} disabled={!anyActive}
                className="rounded-sm px-2.5 py-1.5 text-[11px]"
                style={{ border: `1px solid ${T.rule}`, color: anyActive ? T.ink : T.inkFaint,
                         background: T.panel, opacity: anyActive ? 1 : 0.5, alignSelf: "flex-end" }}>
          Clear all
        </button>
      </div>
    </div>
  );
}

/* ---------------- charts ---------------- */

function GroupChart({ rows, groupBy, onGroupBy }) {
  const PLOT = 172;
  const HEAD = 15;          // headroom so a data label never overruns the panel
  const BAR = PLOT - HEAD;  // usable bar height
  const COLW = 66;
  const arr = useMemo(() => {
    const g = new Map();
    rows.forEach((r) => {
      const k = r[groupBy];
      if (!g.has(k)) g.set(k, { k, n: 0, net: 0, cg: 0, cr: 0, bal: 0 });
      const o = g.get(k);
      o.n++; o.net += r.net || 0; o.cg += r.cg || 0; o.cr += r.cr || 0; o.bal += r.bal || 0;
    });
    return [...g.values()].sort((a, b) => b.bal - a.bal);
  }, [rows, groupBy]);

  const show = arr.slice(0, 12);
  const max = Math.max(1, ...show.map((a) => Math.max(a.bal, a.net)));
  const h = (v) => Math.max(v > 0 ? 1 : 0, (v / max) * BAR);

  return (
    <Panel title="By group" right={
      <label className="text-[11px]" style={{ fontFamily: MONO, color: T.inkSoft }}>
        Group by{" "}
        <select value={groupBy} onChange={(e) => onGroupBy(e.target.value)} className="ml-1 rounded-sm px-1.5 py-1 text-[12px]"
                style={{ border: `1px solid ${T.rule}`, background: T.panel }}>
          {DIMS.map((d) => <option key={d.k} value={d.k}>{d.label}</option>)}
        </select>
      </label>
    }>
      {show.length === 0 ? (
        <div className="py-8 text-center text-xs" style={{ color: T.inkFaint }}>Nothing to chart.</div>
      ) : (
        <div className="flex gap-2">
          {/* y axis */}
          <div className="relative shrink-0" style={{ width: 46, height: PLOT }}>
            {[1, 0.5, 0].map((f) => (
              <div key={f} className="absolute right-0 text-[9.5px]"
                   style={{ top: HEAD + (1 - f) * BAR - 6, fontFamily: MONO, color: T.inkFaint }}>
                {f === 0 ? "0" : compact(max * f)}
              </div>
            ))}
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto">
            {/* plot */}
            <div className="relative flex items-end" style={{ height: PLOT, borderBottom: `1px solid ${T.ink}` }}>
              {[1, 0.5].map((f) => (
                <div key={f} className="pointer-events-none absolute left-0 right-0"
                     style={{ top: HEAD + (1 - f) * BAR, borderTop: `1px dashed ${T.ruleSoft}` }} />
              ))}
              {show.map((a) => (
                <div key={a.k} className="flex items-end justify-center gap-1"
                     style={{ flex: "1 1 0", minWidth: COLW, padding: "0 3px" }}>
                  {/* balance for collection, stacked */}
                  <div className="flex flex-col items-center"
                       title={`${a.k} — balance for collection ${money(a.bal)} (works ${money(a.cg)}, retention ${money(a.cr)})`}>
                    <span style={{ fontFamily: MONO, fontSize: 8, lineHeight: "13px", whiteSpace: "nowrap",
                                   color: T.works, letterSpacing: "-.02em" }}>
                      {a.bal > 0 ? compact(a.bal) : ""}
                    </span>
                    <div className="flex flex-col justify-end" style={{ width: 24, height: h(a.bal) }}>
                      <div style={{ height: h(a.cr), background: T.retention }} />
                      <div style={{ height: h(a.cg), background: T.works }} />
                    </div>
                  </div>
                  {/* collected */}
                  <div className="flex flex-col items-center" title={`${a.k} — collected ${money(a.net)}`}>
                    <span style={{ fontFamily: MONO, fontSize: 8, lineHeight: "13px", whiteSpace: "nowrap",
                                   color: T.collected, letterSpacing: "-.02em" }}>
                      {a.net > 0 ? compact(a.net) : ""}
                    </span>
                    <div style={{ width: 24, height: h(a.net), background: T.collected }} />
                  </div>
                </div>
              ))}
            </div>

            {/* labels */}
            <div className="flex items-start">
              {show.map((a) => (
                <div key={a.k} title={`${a.k} · ${a.n} project${a.n === 1 ? "" : "s"}`}
                     className="text-center" style={{ flex: "1 1 0", minWidth: COLW, padding: "5px 2px 0" }}>
                  <div style={{
                    fontFamily: MONO, fontSize: 9, lineHeight: 1.2, color: T.inkSoft,
                    overflow: "hidden", overflowWrap: "anywhere", wordBreak: "break-word",
                    display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", maxHeight: 33,
                  }}>
                    {a.k}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: T.inkSoft, marginTop: 7, lineHeight: 1.2 }}>
                    {a.n} Project{a.n === 1 ? "" : "s"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {show.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.works }} />unbilled works</span>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.retention }} />retention</span>
          <span><span className="mr-1 inline-block h-2 w-2 align-[-1px]" style={{ background: T.collected }} />collected</span>
          <span>left column = balance for collection{arr.length > 12 ? ` · top 12 of ${arr.length}` : ""}</span>
        </div>
      )}
    </Panel>
  );
}

function StatusChart({ rows }) {
  const arr = useMemo(() => {
    const g = new Map();
    rows.forEach((r) => {
      if (!g.has(r.status)) g.set(r.status, { k: r.status, n: 0, bal: 0 });
      const o = g.get(r.status); o.n++; o.bal += r.bal || 0;
    });
    return [...g.values()].sort((a, b) => b.bal - a.bal);
  }, [rows]);
  const max = Math.max(1, ...arr.map((a) => a.bal));
  return (
    <Panel title="Balance for collection by project status">
      {arr.length === 0 && <div className="py-8 text-center text-xs" style={{ color: T.inkFaint }}>Nothing to chart.</div>}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-around", gap: 6 }}>
      {arr.map((a) => (
        <div key={a.k}>
          <div className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 truncate font-semibold" title={a.k}>{a.k}</span>
            <span className="h-3.5 flex-1" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
              <span className="block h-full" style={{ width: (a.bal / max) * 100 + "%", background: T.collected }} />
            </span>
            <span className="w-24 shrink-0 text-right text-[11px]" style={{ fontFamily: MONO, color: T.inkSoft }}>{compact(a.bal)}</span>
          </div>
          <div className="mt-0.5 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint, marginLeft: 88 }}>
            {a.n} project{a.n === 1 ? "" : "s"}
          </div>
        </div>
      ))}
      </div>
    </Panel>
  );
}

/* ---------------- table ---------------- */

function EditCell({ value, type, onChange }) {
  const [focus, setFocus] = useState(false);
  const v = value ?? "";
  const numericValue = type === "amount" ? toNum(v) : null;
  const displayValue = type === "amount" && !focus && v !== ""
    ? (numericValue === null ? v : money(numericValue))
    : v;

  return (
    <input
      value={displayValue}
      type={type === "date" ? "date" : "text"}
      inputMode={type === "qty" || type === "amount" ? "decimal" : undefined}
      list={type === "status" ? "project-status-suggestions" : undefined}
      onChange={(e) => onChange(type === "amount"
        ? e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1")
        : e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onKeyDown={(e) => { if (e.key === "Escape") e.currentTarget.blur(); }}
      style={{
        width: "100%", border: `1px solid ${focus ? T.collected : "transparent"}`,
        background: focus ? T.panel : "transparent", borderRadius: 2, padding: "1px 4px",
        fontFamily: type === "text" ? BODY : MONO, fontSize: 11.5, color: T.ink,
        textAlign: type === "qty" || type === "amount" ? "right" : "left", outline: "none",
      }}
    />
  );
}

function AuditModal({ target, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    supabase.from("project_manual_update_audit")
      .select("id, column_name, old_value, new_value, changed_by_username, changed_at")
      .eq("project_id", target.projectId)
      .eq("column_name", AUDIT_FIELD_LABELS[target.field])
      .order("changed_at", { ascending: false })
      .then(({ data, error: queryError }) => {
        if (!alive) return;
        if (queryError) setError(queryError.message);
        else setLogs(data || []);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [target]);

  return (
    <div role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
         style={{ position: "fixed", inset: 0, zIndex: 20, background: "rgba(22,33,28,.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="audit-title"
           style={{ width: "min(680px, 100%)", maxHeight: "80vh", overflow: "auto", background: T.panel,
                    border: `1px solid ${T.ink}`, borderRadius: 2, boxShadow: "0 18px 50px rgba(0,0,0,.25)" }}>
        <div className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
          <div>
            <h2 id="audit-title" style={{ fontFamily: DISPLAY, fontSize: 13, fontWeight: 700, textTransform: "uppercase" }}>
              Audit trail · {AUDIT_FIELD_LABELS[target.field]}
            </h2>
            <div style={{ marginTop: 3, fontFamily: MONO, fontSize: 11, color: T.inkSoft }}>Project ID: {target.projectId}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close audit trail"
                  style={{ border: `1px solid ${T.rule}`, background: T.paper2, color: T.ink, padding: "3px 8px", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: 16 }}>
          {loading && <div style={{ color: T.inkFaint, fontSize: 12 }}>Loading audit history…</div>}
          {error && <div style={{ color: T.bad, fontSize: 12 }}>Could not load audit history: {error}</div>}
          {!loading && !error && !logs.length && <div style={{ color: T.inkFaint, fontSize: 12 }}>No saved changes for this cell yet.</div>}
          {!loading && !error && logs.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                {[["When", "left"], ["User", "left"], ["Previous value", "left"], ["New value", "left"]].map(([label, align]) => (
                  <th key={label} style={{ padding: "6px 7px", textAlign: align, borderBottom: `2px solid ${T.ink}`,
                                            fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{label}</th>
                ))}
              </tr></thead>
              <tbody>{logs.map((log) => (
                <tr key={log.id}>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap", fontFamily: MONO, fontSize: 10.5 }}>
                    {new Date(log.changed_at).toLocaleString()}
                  </td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}` }}>{log.changed_by_username}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, color: T.inkSoft }}>{log.old_value ?? "—"}</td>
                  <td style={{ padding: "7px", borderBottom: `1px solid ${T.ruleSoft}`, fontWeight: 600 }}>{log.new_value ?? "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}


function LedgerTable({ rows, sort, onSort, onExport, onEdit, onSaveRow, onSaveAll, onAuditCell, dirtyIds, dirtyCount, savingIds, statusOptions = [] }) {
  const [showCollection, setShowCollection] = useState(false);
  /* the four collection-detail columns fold away by default; the export always
     carries every column regardless of what is on screen */
  const cols = useMemo(() => COLS.filter((c) => !c.group || showCollection), [showCollection]);
  const groupCount = COLS.filter((c) => c.group === "collection").length;
  const data = useMemo(() => {
    const d = rows.slice();
    const { key, dir } = sort;
    d.sort((a, b) => {
      const x = a[key], y = b[key];
      if (typeof x === "number" || typeof y === "number") return ((x ?? -Infinity) - (y ?? -Infinity)) * dir;
      return String(x ?? "").localeCompare(String(y ?? "")) * dir;
    });
    return d;
  }, [rows, sort]);

  const th = { position: "sticky", top: 0, background: T.paper2, zIndex: 3, textAlign: "left", padding: "7px 9px",
    borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase",
    letterSpacing: ".06em", cursor: "pointer", whiteSpace: "nowrap" };
  const stick = { position: "sticky", left: 0, background: T.panel, zIndex: 2, borderRight: `1px solid ${T.rule}` };
  const pillColor = (s) => (s === "ONGOING" ? T.collected : s === "SUSPENDED" ? T.bad : T.inkFaint);

  return (
    <Panel title="Projects" right={
      <div className="flex items-center gap-2">
        <span className="text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>({data.length})</span>
        <button onClick={() => setShowCollection(!showCollection)}
                className="rounded-sm px-3 py-1 text-xs"
                title="Collected (net), balance works, retention, balance for collection, net balance"
                style={{ border: `1px solid ${T.collected}`,
                         background: showCollection ? T.collected : "#E4EFEC",
                         color: showCollection ? T.paper2 : T.collected,
                         fontFamily: DISPLAY, fontWeight: 700, letterSpacing: ".04em",
                         textTransform: "uppercase", fontSize: 10.5, whiteSpace: "nowrap",
                         boxShadow: showCollection ? "none" : `0 0 0 2px ${T.collected}22` }}>
          {showCollection ? "▾ Hide" : "▸ Show"} collection detail ({groupCount})
        </button>
        <button onClick={onSaveAll} disabled={!dirtyCount || savingIds.size > 0}
                className="rounded-sm px-2.5 py-1 text-xs"
                style={{ border: `1px solid ${dirtyCount ? T.collected : T.rule}`,
                         background: dirtyCount ? T.collected : T.paper2,
                         color: dirtyCount ? T.paper2 : T.inkFaint,
                         fontFamily: DISPLAY, fontWeight: 700, cursor: dirtyCount ? "pointer" : "default" }}>
          {savingIds.size ? "Saving…" : `Save changes${dirtyCount ? ` (${dirtyCount})` : ""}`}
        </button>
        <button onClick={() => onExport(data)} className="rounded-sm px-2.5 py-1 text-xs"
                style={{ border: `1px solid ${T.rule}`, background: T.panel, color: T.inkSoft }}>Export filtered CSV</button>
      </div>
    }>
      <datalist id="project-status-suggestions">
        {statusOptions.map((status) => <option key={status} value={status} />)}
      </datalist>
      {data.length === 0 ? (
        <div className="py-10 text-center text-xs" style={{ color: T.inkFaint }}>No projects match these filters.</div>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: 620 }}>
          <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 12 }}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.k} onClick={() => onSort(c.k)}
                      style={{ ...th, ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w,
                                                 whiteSpace: c.stick ? "nowrap" : "normal" } : {}),
                               color: c.edit ? "#C28A00" : T.ink,
                               ...(c.stick ? { ...stick, background: T.paper2, zIndex: 4 } : {}) }}>
                    {c.label}{c.edit && <span aria-hidden="true" style={{ color: T.bad, marginLeft: 3, fontWeight: 800 }}>*</span>} <span style={{ fontFamily: MONO, color: T.inkFaint }}>{sort.key === c.k ? (sort.dir > 0 ? "▲" : "▼") : "↕"}</span>
                  </th>
                ))}
                <th style={{ ...th, cursor: "default", width: 68, minWidth: 68 }}>Save</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r, ri) => (
                <tr key={r.id + "|" + ri}>
                  {cols.map((c) => {
                    const v = r[c.k];
                    const base = { padding: "6px 9px", borderBottom: `1px solid ${T.ruleSoft}`, verticalAlign: "top" };
                    const wStyle = c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden" } : {};
                    if (c.group) base.background = "#F2F6F1";
                    if (c.edit) return (
                      <td key={c.k} onContextMenu={(e) => {
                        e.preventDefault();
                        onAuditCell({ projectId: r.id, field: c.k, value: v });
                      }} onClick={(e) => {
                        if (e.target.tagName !== "INPUT") e.currentTarget.querySelector("input")?.focus();
                      }}
                          style={{ ...base, ...wStyle, padding: "3px 5px", background: "#FBFCFA", cursor: "text" }}>
                        <EditCell value={v} type={c.edit} onChange={(nv) => onEdit(r.id, c.k, nv)}
                        />
                      </td>
                    );
                    if (c.money) return <td key={c.k} style={{ ...base, ...wStyle, fontFamily: MONO, textAlign: "right", whiteSpace: "nowrap" }}>
                      {v ? money(v) : <span style={{ color: T.inkFaint }}>—</span>}</td>;
                    if (c.pct) return <td key={c.k} style={{ ...base, ...wStyle, fontFamily: MONO, textAlign: "right" }}>{pct(v)}</td>;
                    if (c.pill) return <td key={c.k} style={base}>
                      <span className="inline-block rounded-full px-2 py-px text-[10.5px]"
                            style={{ border: `1px solid ${pillColor(v)}`, color: pillColor(v) }}>{v}</span></td>;
                    return <td key={c.k} title={c.stick ? [v, r.name].filter(Boolean).join(" \u2014 ") : v} style={{ ...base,
                      ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden", textOverflow: "ellipsis" } : {}),
                      ...(c.stick ? { ...stick, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap", padding: "6px 8px", fontSize: 11.5 } : {}),
                      ...(c.wide ? { maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : {}) }}>{v}</td>;
                  })}
                  <td style={{ padding: "3px 5px", borderBottom: `1px solid ${T.ruleSoft}`, textAlign: "center" }}>
                    <button type="button" title={`Save changes for ${r.id}`} aria-label={`Save changes for ${r.id}`}
                            onClick={() => onSaveRow(r.id)} disabled={!dirtyIds.has(r.id) || savingIds.has(r.id)}
                            style={{ border: `1px solid ${dirtyIds.has(r.id) ? T.collected : T.rule}`,
                                     background: dirtyIds.has(r.id) ? "#E4EFEC" : T.paper2,
                                     color: dirtyIds.has(r.id) ? T.collected : T.inkFaint, borderRadius: 2,
                                     padding: "2px 6px", cursor: dirtyIds.has(r.id) ? "pointer" : "default", fontSize: 13 }}>
                      {savingIds.has(r.id) ? "…" : "▣"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                {cols.map((c, i) => {
                  const base = { position: "sticky", bottom: 0, background: T.paper2, borderTop: `2px solid ${T.ink}`,
                    padding: "7px 9px", fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap", zIndex: 3 };
                  if (i === 0) return <td key={c.k} style={{ ...base, ...stick, background: T.paper2, zIndex: 4,
                    width: c.w, minWidth: c.w, maxWidth: c.w, padding: "7px 8px", fontSize: 11 }}>TOTAL</td>;
                  if (c.k === "district") return <td key={c.k} style={base}>{data.length} projects</td>;
                  if (c.money) return <td key={c.k} style={{ ...base, textAlign: "right",
                    ...(c.w ? { width: c.w, minWidth: c.w, maxWidth: c.w, overflow: "hidden" } : {}) }}>{money(sum(data, c.k))}</td>;
                  if (c.k === "swa") {
                    const w2 = data.filter((r) => r.swa !== null && r.swa !== undefined);
                    const ct2 = sum(w2, "contract");
                    return <td key={c.k} style={{ ...base, textAlign: "right" }}>
                      {pct(ct2 ? w2.reduce((t, r) => t + r.swa * (r.contract || 0), 0) / ct2 : null)}</td>;
                  }
                  if (c.k === "billpct") { const ct = sum(data, "contract");
                    return <td key={c.k} style={{ ...base, textAlign: "right" }}>{pct(ct ? sum(data, "gross") / ct : null)}</td>; }
                  if (c.k === "target") return <td key={c.k} style={{ ...base, textAlign: "right" }}>
                    {data.filter((r) => r.target !== null && r.target !== undefined && r.target !== "").length}</td>;
                  return <td key={c.k} style={base} />;
                })}
                <td style={{ position: "sticky", bottom: 0, background: T.paper2, borderTop: `2px solid ${T.ink}` }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ---------------- target tracking ---------------- */

/* A project only enters this analysis once someone has set a target or a completion
   date. Actual output falls back to SWA % when the manual figure is blank, so a row
   is useful the moment a date is typed in. */
function assessTargets(rows) {
  const tracked = [];
  rows.forEach((r) => {
    const num = (x) => (x === null || x === undefined || x === "" || isNaN(Number(x)) ? null : Number(x));
    const target = num(r.target);
    const actual = num(r.actual) !== null ? num(r.actual) : (target !== null ? 0 : null);
    if (target === null && !r.due) return;

    const days = daysUntil(r.due);                 // days left until the deadline
    const sinceStart = r.start ? daysUntil(r.start) : null;
    const elapsed = sinceStart === null ? null : Math.max(0, -sinceStart);
    const gap = target !== null && actual !== null ? target - actual : null;
    const remaining = gap !== null ? Math.max(0, gap) : null;
    const progress = target ? Math.min(actual / target, 2) : null;
    const done = target !== null && actual !== null && actual >= target;

    /* Demonstrated capacity: what the crew has actually produced per day since
       starting. Multiply by the days left and compare against the quantity still
       outstanding — that answers whether the remaining time can absorb the
       remaining work, rather than merely whether they are behind today. */
    const capacity = elapsed !== null && elapsed > 0 && actual !== null && actual > 0 ? actual / elapsed : null;
    const canDeliver = capacity !== null && days !== null && days > 0 ? capacity * days : null;
    const needRate = remaining !== null && days !== null && days > 0 ? remaining / days : null;
    const pace = capacity !== null && needRate ? capacity / needRate : null;   // 1.0 = exactly enough

    /* Was it on time? That is a claim about the day the work landed, so it is
       answered by the hand-typed actual completion date and never by today's
       date — measuring from today would relabel a project delivered early as
       late the moment its deadline rolled by. Both dates are ISO yyyy-mm-dd,
       so they compare directly. With no completion date typed in there is no
       evidence either way, and the row stays plain "Delivered". */
    const lateDays = done ? daysBetween(r.due, r.finish) : null;   // + = late, 0/- = on time
    const onTime = done && !!r.finish && !!r.due && r.finish <= r.due;

    let bucket, rank;
    /* Standing is intentionally based on the values the user entered. The
       previous capacity calculation could call a row On track merely because
       its historical daily rate projected well, even when its visible target,
       output, and deadline indicated otherwise. */
    if (done) { bucket = onTime ? "Delivered on time" : "Delivered"; rank = onTime ? 5 : 4; }
    else if (days !== null && days < 0) { bucket = "Overdue"; rank = 0; }
    else if (days !== null && days <= 3) { bucket = "Critical"; rank = 1; }
    else { bucket = "On track"; rank = 3; }

    /* Overdue outranks everything, and within it the whole balance still to
       collect is the weight — a deadline already missed puts the full amount at
       risk. Elsewhere the weight is the share of target still outstanding,
       tightened by how far short the crew's rate falls. */
    const urgency = days === null ? 1 : days < 0 ? 2.2 : days <= 30 ? 1.6 : days <= 90 ? 1.2 : 1;
    const shortfall = progress !== null && progress < 1 ? 1 - progress
      : (days !== null && days < 0 && !done ? 0.25 : 0);
    const paceDrag = pace !== null && pace < 1 ? 1 + (1 - pace) : 1;
    const score = bucket === "Overdue"
      ? (r.bal || 0) * urgency
      : shortfall * (r.bal || 0) * urgency * paceDrag;

    tracked.push({ ...r, target, actual, gap, remaining, progress, days, elapsed,
                   capacity, canDeliver, needRate, pace, bucket, rank, score, done,
                   onTime, lateDays });
  });
  return tracked.sort((a, b) => a.rank - b.rank || b.score - a.score);
}

const BUCKET_COLOR = {
  "Overdue": T.bad, "Critical": "#D2A21C", "Behind target": T.retention,
  "On track": T.collected, "Delivered on time": T.collected, "Delivered": T.inkSoft,
};

/* the two standings that demand action are filled rather than outlined, so they
   carry across a room; everything else stays a quiet outline */
const BUCKET_PILL = {
  "Overdue":  { bg: T.bad,     fg: "#FFFFFF", bd: T.bad,     weight: 700 },
  "Critical": { bg: "#F0CB45", fg: T.ink,     bd: "#C79E1E", weight: 700 },
};
/* every standing renders at the same size so the column reads as one control,
   sized to the longest label ("Delivered on time") */
const PILL_BASE = {
  display: "inline-block", width: 112, textAlign: "center", padding: "2px 6px",
  borderRadius: 999, fontSize: 10, lineHeight: "13px", whiteSpace: "nowrap",
};
const pillStyle = (b) => {
  const s = BUCKET_PILL[b];
  return s
    ? { ...PILL_BASE, background: s.bg, color: s.fg, border: `1px solid ${s.bd}`, fontWeight: s.weight }
    : { ...PILL_BASE, background: "transparent", color: BUCKET_COLOR[b], border: `1px solid ${BUCKET_COLOR[b]}`, fontWeight: 500 };
};

function TargetAnalysis({ rows }) {
  const tracked = useMemo(() => assessTargets(rows), [rows]);

  if (tracked.length === 0) {
    return (
      <Panel title="Target tracking and priority">
        <div className="py-8 text-center text-xs" style={{ color: T.inkFaint, lineHeight: 1.7 }}>
          No targets set yet.<br />
          Fill in <b>Target qty</b> or <b>Target completion</b> on any row above and it will appear here.
        </div>
      </Panel>
    );
  }

  const buckets = ["Overdue", "Critical", "Behind target", "On track", "Delivered on time", "Delivered"];
  const counts = {};
  buckets.forEach((b) => (counts[b] = tracked.filter((t) => t.bucket === b)));

  const atRisk = tracked.filter((t) => ["Overdue", "Critical", "Behind target"].includes(t.bucket));
  const notAchieved = tracked.filter((t) => !t.done);
  const atRiskMoney = sum(atRisk, "bal");
  /* action items first; targets already met on time are listed underneath as a
     record of what has landed, and never carry a priority weight */
  const actionItems = tracked.filter((t) => t.rank <= 2).slice(0, 10);
  const onTrack = tracked.filter((t) => t.bucket === "On track").slice(0, 8);
  /* both delivered standings belong in the record of what has landed — a late
     delivery is if anything the more useful one to see */
  const achieved = tracked.filter((t) => t.done)
    .sort((a, b) => (b.bal || 0) - (a.bal || 0)).slice(0, 8);
  const priority = [...actionItems, ...onTrack, ...achieved];
  /* normalise the bar inside each bucket — otherwise one huge overdue project
     flattens every critical bar to a sliver */
  const bucketMax = {};
  priority.forEach((p) => { bucketMax[p.bucket] = Math.max(bucketMax[p.bucket] || 1, p.score); });

  return (
    <Panel title="Target tracking and priority" right={
      <span className="text-[11px]" style={{ fontFamily: MONO, color: T.inkFaint }}>
        {tracked.length} of {rows.length} projects have targets
      </span>
    }>
      {/* headline numbers */}
      <div className="mb-3 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))" }}>
        <Kpi label="Projects with target" value={tracked.length}
             meta={`of ${rows.length} shown`} />
        <Kpi label="Achieved on time" value={counts["Delivered on time"].length} color={T.collected}
             meta={counts["Delivered"].length
               ? `${counts["Delivered"].length} delivered, not confirmed on time`
               : "every delivery on time"} />
        <Kpi label="Not yet achieved" value={notAchieved.length}
             meta={`${counts["Overdue"].length} overdue · ${counts["Critical"].length + counts["Behind target"].length} behind · ${counts["On track"].length} on track`} />
        <Kpi label="Overdue targets" value={counts["Overdue"].length} color={T.bad}
             meta="past completion date" />
        <Kpi label="Collection at risk" value={compact(atRiskMoney)} color={T.works} meta={money(atRiskMoney)} />
      </div>

      {/* how the tracked set splits */}
      <div className="mb-1 text-[10px] uppercase tracking-widest"
           style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>Where they stand</div>
      <div className="mb-3 flex h-6 overflow-hidden" style={{ border: `1px solid ${T.ink}`, background: T.paper2 }}>
        {buckets.map((b) => counts[b].length ? (
          <div key={b} title={`${b} — ${counts[b].length} project${counts[b].length === 1 ? "" : "s"}`}
               style={{ width: (counts[b].length / tracked.length) * 100 + "%", background: BUCKET_COLOR[b] }} />
        ) : null)}
      </div>
      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[11px]" style={{ color: T.inkSoft }}>
        {buckets.map((b) => counts[b].length ? (
          <span key={b}>
            <span className="mr-1.5 inline-block h-2.5 w-2.5 align-[-1px]" style={{ background: BUCKET_COLOR[b] }} />
            {b} <b style={{ fontFamily: MONO, color: T.ink }}>{counts[b].length}</b>
          </span>
        ) : null)}
      </div>

      {/* the ranked worklist */}
      <div className="mb-1.5 text-[10px] uppercase tracking-widest"
           style={{ fontFamily: DISPLAY, fontWeight: 600, color: T.inkSoft }}>
        Work these first — on-track and completed projects are listed underneath
      </div>
      <div className="overflow-x-auto">
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", fontSize: 11.5 }}>
          <thead>
            <tr>
              {[["#"], ["Project"], ["District / engineer"], ["Standing"], ["Target qty", "right"],
                ["Actual", "right"], ["Done", "right"], ["Pace", "right"], ["Due"], ["Remarks"],
                ["Balance to collect", "right"], ["Priority"]].map(([hd, al]) => (
                <th key={hd} style={{ textAlign: al || "left", padding: "5px 8px",
                                      borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 9.5,
                                      textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap" }}>{hd}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {priority.map((p, i) => (
              <tr key={p.id} style={p.done || p.bucket === "On track" ? { background: "#F7FAF6" } : undefined}>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, color: T.inkFaint }}>
                  {p.done ? "\u2713" : p.bucket === "On track" ? "—" : i + 1}</td>
                <td title={p.name} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, fontWeight: 600, whiteSpace: "nowrap" }}>{p.id}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.district} · <span style={{ color: T.inkSoft }}>{p.engineer}</span>
                </td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}>
                  <span style={pillStyle(p.bucket)}>{p.bucket}</span>
                </td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right" }}>
                  {qty(p.target)}{p.unit ? <span style={{ color: T.inkFaint }}> {p.unit}</span> : null}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right" }}>
                  {qty(p.actual)}{p.unit ? <span style={{ color: T.inkFaint }}> {p.unit}</span> : null}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right",
                             color: p.progress !== null && p.progress < 1 ? T.bad : T.collected }}>
                  {p.progress === null ? "—" : (p.progress * 100).toFixed(0) + "%"}</td>
                <td title={p.capacity === null
                    ? "Set a start date to measure the daily rate"
                    : `${qty(p.capacity.toFixed(2))} ${p.unit || "units"}/day achieved · ${qty((p.needRate || 0).toFixed(2))} needed · ${qty(Math.round(p.canDeliver))} deliverable in ${p.days} days vs ${qty(p.remaining)} outstanding`}
                    style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right",
                             color: p.pace === null ? T.inkFaint : p.pace < 1 ? T.bad : T.collected }}>
                  {p.pace === null ? "—" : p.pace.toFixed(2) + "\u00D7"}</td>
                {/* once delivered, the countdown to the deadline is meaningless —
                    what matters is the day it landed and by how much it missed */}
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, whiteSpace: "nowrap",
                             color: !p.done && p.days !== null && p.days < 0 ? T.bad : T.inkSoft }}>
                  {p.due ? fmtDate(p.due) : "—"}
                  {p.done ? (
                    p.lateDays === null
                      ? <span style={{ color: T.inkFaint }}> · completion date not set</span>
                      : <span style={{ color: p.lateDays > 0 ? T.bad : T.collected }}>
                          {" · "}{fmtDate(p.finish)}
                          {p.lateDays > 0 ? ` (${p.lateDays}d late)` : " (on time)"}
                        </span>
                  ) : p.days !== null && (
                    <span style={{ color: T.inkFaint }}> · {p.days < 0 ? Math.abs(p.days) + "d late" : p.days + "d left"}</span>
                  )}
                </td>
                <td title={p.note || ""} style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`,
                             maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                             color: p.note ? T.ink : T.inkFaint }}>
                  {p.note || "—"}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO, textAlign: "right", whiteSpace: "nowrap" }}>
                  {money(p.bal || 0)}</td>
                <td style={{ padding: "5px 8px", borderBottom: `1px solid ${T.ruleSoft}`, width: 90 }}>
                  {p.done || p.bucket === "On track" ? (
                    <span style={{ fontFamily: MONO, fontSize: 10, color: T.inkFaint }}>—</span>
                  ) : (
                    <span className="block h-2" style={{ background: T.paper2, border: `1px solid ${T.ruleSoft}` }}>
                      <span className="block h-full" style={{ width: (p.score / bucketMax[p.bucket]) * 100 + "%", background: BUCKET_COLOR[p.bucket] }} />
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-[10px]" style={{ fontFamily: MONO, color: T.inkFaint, lineHeight: 1.6 }}>
        On track means the target completion date is more than three days away and the target has not yet been reached.
        Critical means the deadline is within three days; overdue means the deadline has passed. A project counts as
        delivered when Actual output reaches Target qty, and as <b>delivered on time</b> only when its Actual completion
        date is on or before the Target completion date — leave that date blank and it stays <b>delivered</b>, since
        there is nothing to prove it landed on time. Priority ranks overdue and critical projects first.
      </div>
    </Panel>
  );
}

function PasswordChangePanel({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError("");
    if (password.length < 6 || password.length > 8) return setError("Password must be between 6 and 8 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    // Supabase's normal client update enforces the configured weak-password
    // check. This special flow is already limited to users with a temporary
    // password, so complete it through the protected server-side operation.
    const { data: passwordData, error: passwordError } = await supabase.functions.invoke("complete-password-change", {
      body: { password },
    });
    const passwordMessage = passwordData?.error || passwordError?.message;
    if (!passwordMessage) {
      const { error: profileError } = await supabase.rpc("complete_password_change");
      if (profileError) setError(profileError.message);
      else {
        setSuccess(true);
        window.setTimeout(onDone, 1800);
      }
    } else setError(passwordMessage);
    setBusy(false);
  };
  const field = { width: "100%", padding: "9px 11px", fontFamily: MONO, fontSize: 13, color: T.ink,
    background: T.paper2, border: `1px solid ${T.rule}`, borderRadius: 2, outline: "none" };
  return <div style={{ position: "fixed", inset: 0, zIndex: 30, background: "rgba(22,33,28,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <style>{`@keyframes password-success-pop { 0% { transform: scale(.35); opacity: 0; } 70% { transform: scale(1.12); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }`}</style>
    <form onSubmit={submit} style={{ width: "min(420px,100%)", background: T.panel, padding: 22, border: `1px solid ${T.ink}` }}>
      {success ? <div role="status" style={{ textAlign: "center", padding: "18px 8px 10px" }}>
        <div aria-hidden="true" style={{ width: 58, height: 58, margin: "0 auto 14px", borderRadius: "50%", background: T.collected, color: T.paper2,
                                            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 34, fontWeight: 700,
                                            animation: "password-success-pop .55s ease-out both" }}>✓</div>
        <h2 style={{ fontFamily: DISPLAY, fontSize: 15, textTransform: "uppercase", color: T.collected }}>Password changed successfully</h2>
        <p style={{ fontSize: 12, color: T.inkSoft }}>Returning to Project Ledger…</p>
      </div> : <>
        <h2 style={{ fontFamily: DISPLAY, fontSize: 14, textTransform: "uppercase" }}>Change temporary password</h2>
        <p style={{ fontSize: 12, color: T.inkSoft }}>An administrator assigned a temporary password. Choose a private password to continue.</p>
        <input aria-label="New password" type="password" minLength={6} maxLength={8} placeholder="New password (6–8 characters)" value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...field, marginTop: 12 }} />
        <input aria-label="Confirm password" type="password" minLength={6} maxLength={8} placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ ...field, marginTop: 8 }} />
        {error && <div role="alert" style={{ marginTop: 10, color: T.bad, fontSize: 12 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 14, padding: 10, border: 0, background: T.ink, color: T.paper2, fontFamily: DISPLAY, fontWeight: 700 }}>{busy ? "Saving…" : "Change password"}</button>
      </>}
    </form>
  </div>;
}

function AdminPanel({ onClose }) {
  const [users, setUsers] = useState([]);
  const [captchaEnabled, setCaptchaEnabled] = useState(true);
  const [temporary, setTemporary] = useState({});
  const [resetSuccess, setResetSuccess] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const call = async (body) => {
    setBusy(true); setMessage("");
    const { data, error } = await supabase.functions.invoke("admin-users", { body });
    setBusy(false);
    if (error || data?.error) { setMessage(error?.message || data.error); return null; }
    return data;
  };
  const load = async () => { const data = await call({ action: "list" }); if (data) setUsers(data.users || []); };
  useEffect(() => {
    let alive = true;
    supabase.functions.invoke("admin-users", { body: { action: "list" } }).then(({ data, error }) => {
      if (!alive) return;
      setBusy(false);
      if (error || data?.error) setMessage(error?.message || data.error);
      else { setUsers(data?.users || []); setCaptchaEnabled(data?.captcha_enabled !== false); }
    });
    return () => { alive = false; };
  }, []);
  const resetPassword = async (id) => {
    const value = temporary[id] || "";
    if (value.length < 6 || value.length > 8) { setMessage("Enter a temporary password between 6 and 8 characters."); return; }
    const data = await call({ action: "reset-password", user_id: id, temporary_password: value });
    if (data) { setMessage(`Temporary password created for ${users.find((u) => u.id === id)?.username || "the selected user"}.`); setResetSuccess((p) => ({ ...p, [id]: true })); setTemporary((p) => ({ ...p, [id]: "" })); await load(); }
  };
  const toggleBan = async (u) => { const data = await call({ action: u.banned_until ? "unban" : "ban", user_id: u.id }); if (data) await load(); };
  const toggleCaptcha = async () => {
    const data = await call({ action: "set-captcha", enabled: !captchaEnabled });
    if (data) setCaptchaEnabled(data.captcha_enabled !== false);
  };
  return <div style={{ position: "fixed", inset: 0, zIndex: 25, background: "rgba(22,33,28,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <div style={{ width: "min(1000px,100%)", maxHeight: "85vh", overflow: "auto", background: T.panel, border: `1px solid ${T.ink}` }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${T.rule}` }}>
        <h2 style={{ fontFamily: DISPLAY, fontSize: 14, textTransform: "uppercase" }}>User management</h2>
        <button type="button" onClick={onClose} style={{ border: `1px solid ${T.rule}`, background: T.paper2, padding: "3px 8px" }}>×</button>
      </div>
      <div style={{ padding: 16 }}>
        {message && <div role="status" style={{ marginBottom: 10, color: message.includes("error") || message.includes("required") ? T.bad : T.inkSoft, fontSize: 12 }}>{message}</div>}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "10px 12px", marginBottom: 14, background: T.paper2, border: `1px solid ${T.rule}` }}>
          <div>
            <div style={{ fontFamily: DISPLAY, fontSize: 11, textTransform: "uppercase" }}>Live CAPTCHA protection</div>
            <div style={{ marginTop: 3, color: T.inkSoft, fontSize: 11 }}>Require hCaptcha on sign-in and password recovery.</div>
          </div>
          <button type="button" disabled={busy} onClick={toggleCaptcha} style={{ minWidth: 92, padding: "6px 9px", border: `1px solid ${captchaEnabled ? T.collected : T.bad}`, background: captchaEnabled ? "#E4EFEC" : "#FBEEEC", color: captchaEnabled ? T.collected : T.bad, fontFamily: DISPLAY, fontWeight: 700, fontSize: 11 }}>
            {captchaEnabled ? "Enabled" : "Disabled"}
          </button>
        </div>
        <div className="overflow-auto"><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr>{["Username", "Email", "Role", "Status", "Temporary password", "Actions"].map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 7px", borderBottom: `2px solid ${T.ink}`, fontFamily: DISPLAY, fontSize: 10, textTransform: "uppercase" }}>{h}</th>)}</tr></thead>
          <tbody>{users.map((u) => <tr key={u.id}>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, fontFamily: MONO }}>{u.username || "—"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}>{u.email || "—"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}>{u.role}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, color: u.banned_until ? T.bad : T.collected }}>{u.banned_until ? "Blocked" : "Active"}</td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}` }}><input type="password" minLength={6} maxLength={8} placeholder="6–8 characters" value={temporary[u.id] || ""} onChange={(e) => setTemporary((p) => ({ ...p, [u.id]: e.target.value }))} style={{ width: 150, padding: "4px 6px", border: `1px solid ${T.rule}`, fontFamily: MONO, fontSize: 11 }} /></td>
            <td style={{ padding: 7, borderBottom: `1px solid ${T.ruleSoft}`, whiteSpace: "nowrap" }}><button type="button" disabled={busy} onClick={() => resetPassword(u.id)} style={{ marginRight: 6, padding: "4px 7px", border: `1px solid ${T.rule}`, background: resetSuccess[u.id] ? "#E4EFEC" : T.paper2, color: resetSuccess[u.id] ? T.collected : T.ink, fontSize: 11 }}>{resetSuccess[u.id] ? "Created ✓" : "Reset"}</button><button type="button" disabled={busy} onClick={() => toggleBan(u)} style={{ padding: "4px 7px", border: `1px solid ${u.banned_until ? T.collected : T.bad}`, background: T.paper2, color: u.banned_until ? T.collected : T.bad, fontSize: 11 }}>{u.banned_until ? "Unblock" : "Block"}</button></td>
          </tr>)}</tbody>
        </table></div>
      </div>
    </div>
  </div>;
}

/* ---------------- app ---------------- */

export default function ProjectLedger({ user, onSignOut }) {
  const [store, setStore] = useState(EMPTY_STORE);
  const [sourceLabel, setSourceLabel] = useState("Loading…");
  const [uploadedBy, setUploadedBy] = useState("");
  const [dataReady, setDataReady] = useState(false);
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);

  const [manual, setManual] = useState({});
  const [manualReady, setManualReady] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [savingIds, setSavingIds] = useState(new Set());
  const [saveMessage, setSaveMessage] = useState("");
  const [username, setUsername] = useState(user?.user_metadata?.username || user?.email || "Unknown user");
  const [role, setRole] = useState("user");
  const [forcePasswordChange, setForcePasswordChange] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [auditTarget, setAuditTarget] = useState(null);

  useEffect(() => {
    let alive = true;
    loadManual().then((m) => {
      if (alive) { setManual(m); setManualReady(true); }
    }).catch((error) => {
      if (alive) { setManualReady(true); setSaveMessage(`Could not load saved project updates: ${error.message}`); }
    });
    if (isConfigured && supabase && user?.id) {
      supabase.from("profiles").select("username, role, force_password_change").eq("id", user.id).maybeSingle()
        .then(({ data }) => { if (!alive || !data) return; if (data.username) setUsername(data.username); setRole(data.role || "user"); setForcePasswordChange(Boolean(data.force_password_change)); });
    }
    return () => { alive = false; };
  }, [user]);

  /* the shared dataset, applied on load and whenever somebody asks for a reload */
  const applyDataset = (row) => {
    if (!row) {
      setStore(EMPTY_STORE);
      setSourceLabel(isConfigured ? NO_DATA_LABEL : "Supabase not configured — imports cannot be saved");
      setUploadedBy("");
      return;
    }
    setStore(row.store);
    setSourceLabel(row.label || `${row.store.coll.length} projects`);
    setUploadedBy(row.username ? `uploaded by ${row.username}${row.at ? " · " + fmtDate(row.at.slice(0, 10)) : ""}` : "");
  };

  useEffect(() => {
    let alive = true;
    loadDataset().then((row) => {
      if (!alive) return;
      applyDataset(row);
      setDataReady(true);
    }).catch((error) => {
      if (!alive) return;
      setSourceLabel("Could not load the saved ledger");
      setLog([{ warn: true, text: `Could not load the saved ledger: ${error.message}` }]);
      setDataReady(true);
    });
    return () => { alive = false; };
  }, []);

  const reloadDataset = async () => {
    setReloading(true);
    try {
      applyDataset(await loadDataset());
      setLog([]);
    } catch (error) {
      setLog([{ warn: true, text: `Could not reload the saved ledger: ${error.message}` }]);
    } finally {
      setReloading(false);
    }
  };

  const editManual = (id, field, value) =>
    setDrafts((prev) => {
      const row = { ...(prev[id] || {}) };
      row[field] = value;
      const next = { ...prev };
      next[id] = row;
      return next;
    });

  const dirtyIds = useMemo(() => new Set(Object.keys(drafts)), [drafts]);
  const dirtyCount = useMemo(() => Object.values(drafts)
    .reduce((count, row) => count + Object.keys(row).length, 0), [drafts]);

  const saveRow = async (id) => {
    if (!drafts[id] || savingIds.has(id)) return;
    const values = { ...(manual[id] || {}), ...drafts[id] };
    const imported = importedRows.find((row) => row.id === id) || {};
    const previous = { ...imported, ...(manual[id] || {}) };
    const changedFields = new Set(Object.keys(drafts[id]));
    setSavingIds((prev) => new Set(prev).add(id));
    setSaveMessage("");
    try {
      await saveManualRow(id, values, previous, user?.id, username, changedFields);
      setManual((prev) => ({ ...prev, [id]: values }));
      setDrafts((prev) => { const next = { ...prev }; delete next[id]; return next; });
      setSaveMessage(`Saved changes for ${id}.`);
    } catch (error) {
      setSaveMessage(`Could not save ${id}: ${error.message}`);
    } finally {
      setSavingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  };

  const saveAll = async () => {
    const ids = [...dirtyIds];
    for (const id of ids) await saveRow(id);
  };

  const [filters, setFilters] = useState(() => { const o = {}; DIMS.forEach((d) => (o[d.k] = new Set())); return o; });
  const [q, setQ] = useState("");
  const [groupBy, setGroupBy] = useState("district");
  const [sort, setSort] = useState({ key: "bal", dir: -1 });

  const importedRows = useMemo(() => assemble(store.coll, store.dim), [store]);
  /* imported columns and hand-typed columns are merged only at render time — an
     import rebuilds `importedRows` and never touches `manual` */
  const records = useMemo(() => importedRows.map((r) => {
    const m = manual[r.id];
    const draft = drafts[r.id];
    const merged = m || draft ? { ...r, ...(m || {}), ...(draft || {}) } : { ...r };
    const set = (x) => x !== undefined && x !== null && x !== "";
    merged.hasTarget = set(merged.target) || set(merged.due) ? "With target" : "No target";
    if (m || draft) merged._hay = [r._hay, merged.status, merged.contract, merged.note].filter(set).join(" ").toLowerCase();
    return merged;
  }), [importedRows, manual, drafts]);
  const statusOptions = useMemo(() => [...new Set([
    "ONGOING", "SUSPENDED", "COMPLETED",
    ...records.map((r) => r.status).filter(Boolean),
  ])].sort((a, b) => String(a).localeCompare(String(b))), [records]);

  const handleFiles = async (files) => {
    setBusy(true);
    const out = [];
    let coll = store.coll, dim = store.dim, gotColl = false, gotMaster = false;
    for (const f of files) {
      try {
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
        const names = wb.SheetNames.map(NORM);
        const isColl = names.some((n) => n.includes("COLLECTIBLE"));
        const isMaster = names.some((n) => n.includes("QMB PROJECT") || n.includes("QM LICENSE"));
        out.push({ text: `${f.name} — ${wb.SheetNames.length} sheets` });
        if (isColl) {
          const r = readCollectibles(wb);
          out.push(...r.log);
          if (r.rows && r.rows.length) { coll = r.rows; gotColl = true; }
        } else if (isMaster) {
          const r = readMaster(wb);
          out.push(...r.log);
          if (r.dim.size) { dim = r.dim; gotMaster = true; }
        } else {
          out.push({ warn: true, text: `${f.name}: no Collectibles / QMB Projects / QM Licenses sheet — skipped` });
        }
      } catch (err) {
        out.push({ warn: true, text: `${f.name}: could not be read (${err.message})` });
      }
    }
    if (gotColl || gotMaster) {
      const matched = coll.filter((m) => dim.has(m.key)).length;
      out.push({ text: `Joined: ${matched} of ${coll.length} projects matched to master attributes` });
      if (matched < coll.length)
        out.push({ warn: true, text: `${coll.length - matched} project IDs not found in QMB Projects / QM Licenses — shown as UNSPECIFIED` });
      const next = { coll, dim };
      const parts = [];
      if (gotColl) parts.push("collectibles");
      if (gotMaster) parts.push("master");
      const label = `Imported ${parts.join(" + ")} · ${files.map((f) => f.name).join(", ")}`;
      setStore(next);
      setSourceLabel(label);
      /* shown immediately, then saved — a failed save leaves this browser working
         and says so, rather than throwing away a parse that succeeded */
      try {
        const at = await saveDataset(next, label, user?.id, username);
        setUploadedBy(`uploaded by ${username} · ${fmtDate(at.slice(0, 10))}`);
        out.push({ text: `Saved to the shared ledger — ${coll.length} projects are now what everyone sees` });
      } catch (error) {
        setUploadedBy("not saved — visible in this browser only");
        out.push({ warn: true, text: `Shown here but NOT saved for other users: ${error.message}` });
      }
    }
    setLog(out);
    setBusy(false);
  };

  const query = q.trim().toLowerCase();
  const passes = (r, skip) => {
    for (const d of DIMS) {
      if (d.k === skip) continue;
      const s = filters[d.k];
      if (s.size && !s.has(r[d.k])) return false;
    }
    if (query && !r._hay.includes(query)) return false;
    return true;
  };
  const rows = records.filter((r) => passes(r, null));

  const countsFor = (dimKey) => {
    const m = new Map();
    records.forEach((r) => m.set(r[dimKey], 0));
    records.forEach((r) => { if (passes(r, dimKey)) m.set(r[dimKey], m.get(r[dimKey]) + 1); });
    return m;
  };

  const toggle = (dimKey, value) => setFilters((prev) => {
    const s = new Set(prev[dimKey]);
    s.has(value) ? s.delete(value) : s.add(value);
    return { ...prev, [dimKey]: s };
  });
  const clearOne = (dimKey) => setFilters((prev) => ({ ...prev, [dimKey]: new Set() }));
  const clearAll = () => { const o = {}; DIMS.forEach((d) => (o[d.k] = new Set())); setFilters(o); setQ(""); };
  const onSort = (k) => setSort((s) => (s.key === k ? { key: k, dir: -s.dir } : { key: k, dir: -1 }));

  const exportCsv = (data) => {
    const qq = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [EXPORT_COLS.map((c) => qq(c.label)).join(",")];
    data.forEach((r) => lines.push(EXPORT_COLS.map((c) => qq(r[c.k])).join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    a.download = "project-collectibles-filtered.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  };

  const contract = sum(rows, "contract"), gross = sum(rows, "gross"), net = sum(rows, "net");
  const cg = sum(rows, "cg"), cc = sum(rows, "cc"), cr = sum(rows, "cr");
  const bal = sum(rows, "bal"), netbal = sum(rows, "netbal");
  const other = Math.max(0, contract - gross - cg);
  const activeSegs = DIMS.filter((d) => filters[d.k].size);
  const anyActive = activeSegs.length > 0 || query.length > 0;
  /* nothing to filter, chart or total until a workbook has been imported */
  const empty = records.length === 0;

  return (
    <div style={{
      background: T.paper, color: T.ink, fontFamily: BODY, fontSize: 14, minHeight: "100vh",
      backgroundImage: `linear-gradient(${T.ruleSoft} 1px,transparent 1px),linear-gradient(90deg,${T.ruleSoft} 1px,transparent 1px)`,
      backgroundSize: "28px 28px", backgroundPosition: "-1px -1px",
    }}>
      <style dangerouslySetInnerHTML={{ __html:
        `@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');` }} />

      <div className="mx-auto max-w-[1480px] px-4 pb-16">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4 pt-5 pb-3" style={{ borderBottom: `2px solid ${T.ink}` }}>
          <div>
            <h1 className="text-2xl uppercase" style={{ fontFamily: DISPLAY, fontWeight: 800, letterSpacing: ".045em" }}>Project Ledger</h1>
            <div className="mt-1 text-xs" style={{ color: T.inkSoft }}>
              Filter by district, license, senior engineer, category, location — read collectibles,
              balance for collection, balance works and status.
            </div>
          </div>
          <div className="flex items-end gap-4 text-right text-[11px] leading-relaxed" style={{ fontFamily: MONO, color: T.inkSoft }}>
            <div>
              {records.length} projects loaded<br />
              master from QMB Projects + QM Licenses
            </div>
            {role === "admin" && <button type="button" onClick={() => setAdminOpen(true)}
              style={{ color: T.ink, background: T.paper2, border: `1px solid ${T.rule}`, fontFamily: MONO, fontSize: 10, padding: "5px 7px", cursor: "pointer" }}>
              User management
            </button>}
            {onSignOut && (
              <button
                type="button"
                onClick={onSignOut}
                className="px-2 py-1 uppercase"
                style={{
                  color: T.ink,
                  background: T.paper2,
                  border: `1px solid ${T.rule}`,
                  fontFamily: MONO,
                  fontSize: 10,
                  letterSpacing: ".08em",
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </header>

        <ImportPanel onLoad={handleFiles} sourceLabel={sourceLabel} uploadedBy={uploadedBy}
                     log={log} busy={busy} onReload={reloadDataset} reloading={reloading}
                     forceOpen={dataReady && empty} />

        {empty ? <EmptyLedger loading={!dataReady} configured={isConfigured} /> : <>

        <FilterBar q={q} setQ={setQ} filters={filters} countsFor={countsFor}
                   onToggle={toggle} onClearOne={clearOne} onClearAll={clearAll} anyActive={anyActive} />

        <div className="mb-4 flex flex-wrap items-baseline gap-2 px-3 py-2"
             style={{ background: T.paper2, border: `1px solid ${T.rule}`, borderLeft: `4px solid ${T.ink}`,
                      fontFamily: MONO, fontSize: 12, color: T.inkSoft }}>
          <span><b style={{ color: T.ink }}>{rows.length}</b> of {records.length} projects</span>
          {activeSegs.length === 0 && !query && <span style={{ color: T.inkFaint }}>› no filters applied</span>}
          {activeSegs.map((d) => (
            <span key={d.k}>
              <span style={{ color: T.inkFaint }}>› </span>{d.label}:{" "}
              <b style={{ color: T.ink }}>{filters[d.k].size <= 2 ? [...filters[d.k]].join(", ") : filters[d.k].size + " selected"}</b>
            </span>
          ))}
          {query && <span><span style={{ color: T.inkFaint }}>› </span>search: <b style={{ color: T.ink }}>{query}</b></span>}
        </div>

        <div>
            <div className="mb-3 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(168px,1fr))" }}>
              <Kpi label="Projects" value={rows.length} meta={`of ${records.length}`} />
              <Kpi label="Contract amount" value={compact(contract)} meta={money(contract)} />
              <Kpi label="Collected (net)" value={compact(net)} color={T.collected}
                   meta={contract ? pct(net / contract) + " of contract" : "—"} />
              <Kpi label="Balance for collection" value={compact(bal)} color={T.works} meta={`net ${compact(netbal)}`} />
              <Kpi label="Balance works" value={compact(cg)} color={T.works}
                   meta={contract ? pct(cg / contract) + " of contract" : "—"} />
              <Kpi label="Retention held" value={compact(cr)} color={T.retention} meta={money(cr)} />
            </div>


            <div className="grid gap-3" style={{ gridTemplateColumns: "7fr 3fr", alignItems: "stretch" }}>
              <Panel title="Where the money sits">
                <Meter label="Contract amount — billed vs works still to do"
                  segments={[
                    { label: "Billed gross", value: gross, color: T.collected },
                    { label: "Balance works", value: cg, color: T.works },
                    { label: "Unaccounted", value: other, color: T.ruleSoft },
                  ]}
                  legend={[
                    { color: T.collected, label: "Billed gross", value: money(gross), extra: pct(contract ? gross / contract : null) },
                    { color: T.works, label: "Balance works", value: money(cg), extra: pct(contract ? cg / contract : null) },
                    { label: "Contract", value: money(contract) },
                  ]} />
                <div style={{ flex: 1, minHeight: 16 }} />
                <Meter label="Balance for collection — what it is made of"
                  segments={[
                    { label: "Unbilled works", value: cg, color: T.works },
                    { label: "Cash balance", value: cc, color: T.cash },
                    { label: "Retention", value: cr, color: T.retention },
                  ]}
                  legend={[
                    { color: T.works, label: "Unbilled works", value: money(cg) },
                    { color: T.cash, label: "Cash balance", value: money(cc) },
                    { color: T.retention, label: "Retention", value: money(cr) },
                    { label: "Total", value: money(bal), extra: "net " + money(netbal) },
                  ]} />
              </Panel>
              <StatusChart rows={rows} />
            </div>

            <div style={{ marginTop: 18 }}>
              <GroupChart rows={rows} groupBy={groupBy} onGroupBy={setGroupBy} />
            </div>

            {(!manualReady || saveMessage) && (
              <div className="mb-2 px-3 py-2 text-xs" role={saveMessage.startsWith("Could") ? "alert" : undefined}
                   style={{ color: saveMessage.startsWith("Could") ? T.bad : T.inkSoft,
                            background: saveMessage.startsWith("Could") ? "#FBEEEC" : T.paper2,
                            border: `1px solid ${saveMessage.startsWith("Could") ? T.bad + "55" : T.rule}` }}>
                {manualReady ? saveMessage : "Loading saved project updates…"}
              </div>
            )}
            <LedgerTable rows={rows} sort={sort} onSort={onSort} onExport={exportCsv} onEdit={editManual}
                         onSaveRow={saveRow} onSaveAll={saveAll} dirtyIds={dirtyIds} dirtyCount={dirtyCount}
                         savingIds={savingIds} onAuditCell={setAuditTarget} statusOptions={statusOptions} />

            <TargetAnalysis rows={rows} />
            {auditTarget && <AuditModal key={`${auditTarget.projectId}:${auditTarget.field}`} target={auditTarget}
                                        onClose={() => setAuditTarget(null)} />}
        </div>

        </>}

        {adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
        {forcePasswordChange && <PasswordChangePanel onDone={() => setForcePasswordChange(false)} />}
      </div>
    </div>
  );
}
