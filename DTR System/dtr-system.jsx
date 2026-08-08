import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase, isConfigured } from "../src/lib/supabase";

/* ============================ constants ============================ */
const SLOTS = [
  { k: "amIn",  label: "AM in",  btn: "Time in",              sub: "Start of the morning",  mer: "AM" },
  { k: "amOut", label: "AM out", btn: "Time out for lunch",   sub: "Break at noon",         mer: "AM" },
  { k: "pmIn",  label: "PM in",  btn: "Time in from lunch",   sub: "Back before 1:00 PM",   mer: "PM" },
  { k: "pmOut", label: "PM out", btn: "Time out for the day", sub: "End of regular hours",  mer: "PM" },
  { k: "otIn",  label: "OT in",  btn: "Start overtime",       sub: "Overtime, regular day", mer: "PM" },
  { k: "otOut", label: "OT out", btn: "End overtime",         sub: "Close out overtime",    mer: "PM" },
];
const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const ADMIN_ID = "005582";
const SCHED_DEF = { amStart: "08:00", amEnd: "12:00", pmStart: "13:00", pmEnd: "17:00" };
const DEF = { co: "QM BUILDERS", dept: "HUMAN RESOURCE", title: "DAILY TIME RECORD (STAFF)", logo: "", sched: SCHED_DEF };

/* ============================ helpers ============================ */
const p2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const nowHM = () => { const d = new Date(); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const toMin = (hm) => { if (!hm) return null; const a = hm.split(":").map(Number); return a[0] * 60 + a[1]; };
const fmtDur = (m) => (!m || m <= 0 ? "0:00" : `${Math.floor(m / 60)}:${p2(m % 60)}`);

function disp(hm, withMer) {
  if (!hm) return "";
  const a = hm.split(":").map(Number);
  const mer = a[0] >= 12 ? "PM" : "AM";
  let hh = a[0] % 12; if (hh === 0) hh = 12;
  return `${hh}:${p2(a[1])}${withMer ? " " + mer : ""}`;
}
function parseTime(txt, merHint) {
  if (!txt) return "";
  const t = txt.trim().toUpperCase();
  const m = t.match(/^(\d{1,2})[:.\s]?(\d{2})?\s*(AM|PM|A|P)?$/);
  if (!m) return null;
  let h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  const mer = m[3] ? (m[3][0] === "A" ? "AM" : "PM") : h <= 12 ? merHint : null;
  if (mer === "PM" && h < 12) h += 12;
  if (mer === "AM" && h === 12) h = 0;
  return `${p2(h)}:${p2(mi)}`;
}
/* ============================ PDF export ============================
   No PDF library is available here, so the file is written by hand.
   Helvetica is one of the 14 fonts every PDF reader has built in, so
   nothing needs embedding except an optional logo (as JPEG/DCTDecode). */
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HBW = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const txtW = (s, size, bold) => {
  const t = bold ? HBW : HW;
  let w = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); w += c >= 32 && c <= 126 ? t[c - 32] : 500; }
  return (w * size) / 1000;
};
const pesc = (s) =>
  String(s == null ? "" : s).replace(/[^\x20-\xFF]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
const nf = (n) => (Math.round(n * 100) / 100).toString();

/* turn any stored logo into raw JPEG bytes, which PDF can embed directly */
function logoAsJpeg(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      const b64 = c.toDataURL("image/jpeg", 0.9).split(",")[1];
      resolve({ bytes: atob(b64), w: c.width, h: c.height });
    };
    img.onerror = () => reject(new Error("logo"));
    img.src = dataUrl;
  });
}

function buildDtrPdf(o) {
  const PW = 595.28, PH = 841.89, M = 25.5;
  const X0 = M, X1 = PW - M, W = X1 - X0, YTOP = PH - M;
  const c = [];
  const line = (x1, y1, x2, y2) => c.push(`${nf(x1)} ${nf(y1)} m ${nf(x2)} ${nf(y2)} l S`);
  const rect = (x, y, w, h) => c.push(`${nf(x)} ${nf(y)} ${nf(w)} ${nf(h)} re S`);
  const text = (x, y, s, size, bold) => c.push(`BT /${bold ? "F2" : "F1"} ${nf(size)} Tf ${nf(x)} ${nf(y)} Td (${pesc(s)}) Tj ET`);
  const ctext = (cx, y, s, size, bold) => text(cx - txtW(String(s), size, bold) / 2, y, s, size, bold);
  const mid = (top, h, size) => top - h / 2 - size * 0.34;
  const fit = (s, maxW, size, bold) => {
    let r = String(s);
    if (txtW(r, size, bold) <= maxW) return r;
    while (r.length > 1 && txtW(r + "..", size, bold) > maxW) r = r.slice(0, -1);
    return r + "..";
  };
  c.push("0.6 w");

  /* ---- header block ---- */
  const logoW = 54, h1 = 26, h2 = 16, h3 = 16, hdrH = h1 + h2 + h3;
  rect(X0, YTOP - hdrH, W, hdrH);
  line(X0 + logoW, YTOP, X0 + logoW, YTOP - hdrH);
  line(X0 + logoW, YTOP - h1, X1, YTOP - h1);
  line(X0 + logoW, YTOP - h1 - h2, X1, YTOP - h1 - h2);
  const rMid = (X0 + logoW + X1) / 2;
  ctext(rMid, mid(YTOP, h1, 14), o.co, 14, true);
  text(X0 + logoW + 5, mid(YTOP - h1, h2, 8), "Department:", 8, false);
  ctext(rMid, mid(YTOP - h1, h2, 10), o.dept, 10, true);
  text(X0 + logoW + 5, mid(YTOP - h1 - h2, h3, 8), "Form Title:", 8, false);
  ctext(rMid, mid(YTOP - h1 - h2, h3, 10), o.title, 10, true);
  if (o.logo) {
    const box = { w: logoW - 10, h: hdrH - 10 };
    const sc = Math.min(box.w / o.logo.w, box.h / o.logo.h);
    const iw = o.logo.w * sc, ih = o.logo.h * sc;
    c.push(`q ${nf(iw)} 0 0 ${nf(ih)} ${nf(X0 + (logoW - iw) / 2)} ${nf(YTOP - hdrH + (hdrH - ih) / 2)} cm /Im0 Do Q`);
  }

  /* ---- name / position / site / period ---- */
  const fk1 = 107.7, gapW = 34, fk2 = 96.4;
  const fvW = (W - fk1 - gapW - fk2) / 2;
  const v1x = X0 + fk1, k2x = v1x + fvW + gapW, v2x = k2x + fk2;
  const fRow = (y, l1, val1, l2, val2) => {
    text(X0, y, l1, 8.5, false);
    text(v1x + 4, y, fit(val1, fvW - 8, 8.5, false), 8.5, false);
    line(v1x, y - 2.5, v1x + fvW, y - 2.5);
    text(k2x, y, l2, 8.5, false);
    text(v2x + 4, y, fit(val2, fvW - 8, 8.5, false), 8.5, false);
    line(v2x, y - 2.5, v2x + fvW, y - 2.5);
  };
  const fy1 = YTOP - hdrH - 26;
  fRow(fy1, "NAME OF EMPLOYEE", o.name, "PROJECT SITE", o.site);
  fRow(fy1 - 22, "POSITION", o.position, "PAYROLL PERIOD", o.period);

  /* ---- grid ---- */
  const pct = [9.4, 7.6, 7.6, 7.6, 7.6, 7.6, 7.6, 6, 9, 30];
  const bx = [X0];
  pct.forEach((p) => bx.push(bx[bx.length - 1] + (p / 100) * W));
  const hh1 = 13, hh2 = 13, hh3 = 11, theadH = hh1 + hh2 + hh3;
  const rh = 19.84, PAD = 21;
  const bodyRows = Math.max(PAD, o.rows.length);
  const totalH = 21;
  const tTop = fy1 - 22 - 20;
  const tBot = tTop - theadH - bodyRows * rh - totalH;
  rect(X0, tBot, W, tTop - tBot);

  const r1b = tTop - hh1, r2b = r1b - hh2, r3b = r2b - hh3;
  [0, 4, 6, 8].forEach((i) => line(bx[i + 1], tTop, bx[i + 1], r1b));
  [0, 2, 4, 6, 7, 8].forEach((i) => line(bx[i + 1], r1b, bx[i + 1], r2b));
  [0, 1, 2, 3, 4, 5, 6, 7, 8].forEach((i) => line(bx[i + 1], r2b, bx[i + 1], r3b));
  line(bx[1], r1b, bx[5], r1b);
  line(bx[7], r1b, bx[9], r1b);
  line(bx[1], r2b, bx[7], r2b);
  line(X0, r3b, X1, r3b);

  const cmid = (i, j) => (bx[i] + bx[j]) / 2;
  ctext(cmid(0, 1), mid(tTop, theadH, 7.2), "DATE", 7.2, true);
  ctext(cmid(1, 5), mid(tTop, hh1, 7.2), "REGULAR DAY", 7.2, true);
  ctext(cmid(5, 7), mid(tTop, hh1 + hh2, 7.2) + 4.5, "OVERTIME", 7.2, true);
  ctext(cmid(5, 7), mid(tTop, hh1 + hh2, 7.2) - 4.5, "REGULAR DAY", 7.2, true);
  ctext(cmid(7, 9), mid(tTop, hh1, 7.2), "TOTAL", 7.2, true);
  const actLbl = "DAILY WORK ACTIVITIES / ACCOMPLISHMENT";
  let actSize = 7.2;
  while (actSize > 5 && txtW(actLbl, actSize, true) > bx[10] - bx[9] - 6) actSize -= 0.2;
  ctext(cmid(9, 10), mid(tTop, theadH, actSize), actLbl, actSize, true);
  ctext(cmid(1, 3), mid(r1b, hh2, 7.2), "AM", 7.2, true);
  ctext(cmid(3, 5), mid(r1b, hh2, 7.2), "PM", 7.2, true);
  ctext(cmid(7, 8), mid(r1b, hh2 + hh3, 7.2), "DAY", 7.2, true);
  ctext(cmid(8, 9), mid(r1b, hh2 + hh3, 6.4), "OVERTIME", 6.4, true);
  for (let i = 1; i <= 6; i++) ctext(cmid(i, i + 1), mid(r2b, hh3, 7), i % 2 ? "IN" : "OUT", 7, true);

  /* ---- rows ---- */
  const totalTop = r3b - bodyRows * rh;
  [1, 5, 6, 7, 8, 9].forEach((i) => line(bx[i], r3b, bx[i], totalTop));
  [6, 7, 8, 9].forEach((i) => line(bx[i], totalTop, bx[i], tBot));
  let y = r3b;
  for (let i = 0; i < bodyRows; i++) {
    const r = o.rows[i];
    if (!r || !r.leave) [2, 3, 4].forEach((j) => line(bx[j], y, bx[j], y - rh));
    if (r) {
      const base = mid(y, rh, 8);
      ctext(cmid(0, 1), base, r.date, 8, false);
      if (r.sun) ctext(cmid(0, 1), base - 6, "SUN", 5.6, true);
      if (r.leave) {
        ctext(cmid(1, 5), base, "ON LEAVE", 8, true);
      } else {
        r.times.forEach((t, j) => { if (t) ctext(cmid(j + 1, j + 2), base, t, 7.2, false); });
      }
      if (r.day) ctext(cmid(7, 8), base, r.day, 7.6, true);
      if (r.ot) ctext(cmid(8, 9), base, r.ot, 7.6, true);
      if (r.note) text(bx[9] + 4, base, fit(r.note, bx[10] - bx[9] - 8, 7.2, false), 7.2, false);
    }
    y -= rh;
    line(X0, y, X1, y);
  }
  ctext(cmid(6, 7), mid(y, totalH, 8.5), "TOTAL", 8.5, true);
  ctext(cmid(7, 8), mid(y, totalH, 8.5), o.dayTotal, 8.5, true);
  ctext(cmid(8, 9), mid(y, totalH, 8.5), o.otTotal, 8.5, true);

  /* ---- signatures ---- */
  const sw = 160, sy = tBot - 46;
  [X0, X0 + (W - sw) / 2, X1 - sw].forEach((sx, i) => {
    line(sx, sy, sx + sw, sy);
    ctext(sx + sw / 2, sy - 9, ["EMPLOYEE SIGNATURE", "SUPERVISOR / DEPT MANAGER", "GENERAL MANAGER"][i], 8, true);
  });

  /* ---- assemble ---- */
  const stream = c.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${nf(PW)} ${nf(PH)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >>${o.logo ? " /XObject << /Im0 7 0 R >>" : ""} >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  ];
  if (o.logo) {
    objs.push(
      `<< /Type /XObject /Subtype /Image /Width ${o.logo.w} /Height ${o.logo.h} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /DCTDecode /Length ${o.logo.bytes.length} >>\nstream\n${o.logo.bytes}\nendstream`
    );
  }
  let pdf = "%PDF-1.4\n";
  const off = [0];
  objs.forEach((ob, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${ob}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) pdf += String(off[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

/* downscale an uploaded image so storage stays small */
function scaleImage(file, max, mime, quality) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * sc));
        c.height = Math.max(1, Math.round(img.height * sc));
        const ctx = c.getContext("2d");
        if (mime === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL(mime, quality));
      };
      img.onerror = () => reject(new Error("not an image"));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error("could not read file"));
    fr.readAsDataURL(file);
  });
}

/* a punch can't fall before the last one recorded or after the next one */
function orderIssue(r, key, t) {
  const i = SLOTS.findIndex((s) => s.k === key);
  if (i < 0 || !t) return null;
  for (let j = i - 1; j >= 0; j--) {
    if (r[SLOTS[j].k]) {
      if (toMin(t) < toMin(r[SLOTS[j].k]))
        return `${SLOTS[i].label} can't be earlier than ${SLOTS[j].label} (${disp(r[SLOTS[j].k], true)})`;
      break;
    }
  }
  for (let j = i + 1; j < SLOTS.length; j++) {
    if (r[SLOTS[j].k]) {
      if (toMin(t) > toMin(r[SLOTS[j].k]))
        return `${SLOTS[i].label} can't be later than ${SLOTS[j].label} (${disp(r[SLOTS[j].k], true)})`;
      break;
    }
  }
  return null;
}

/* regular hours are counted only inside the scheduled window, and capped at its length */
const overlap = (a, b, lo, hi) => (!a || !b ? 0 : Math.max(0, Math.min(toMin(b), hi) - Math.max(toMin(a), lo)));
const schedCap = (s) => Math.max(0, toMin(s.amEnd) - toMin(s.amStart)) + Math.max(0, toMin(s.pmEnd) - toMin(s.pmStart));
/* the DAY column counts days worked, not hours — a full scheduled day is 1.00 */
const fmtDay = (min, cap) => (!cap || !min || min <= 0 ? "0.00" : (min / cap).toFixed(2));
function dayMinutes(r, sched) {
  const s = sched || SCHED_DEF;
  const t =
    overlap(r.amIn, r.amOut, toMin(s.amStart), toMin(s.amEnd)) +
    overlap(r.pmIn, r.pmOut, toMin(s.pmStart), toMin(s.pmEnd));
  return Math.min(t, schedCap(s));
}
const otMinutes = (r) => (r.otIn && r.otOut ? Math.max(0, toMin(r.otOut) - toMin(r.otIn)) : 0);

/* payroll periods run 28 -> 12 and 13 -> 27 */
function periodOf(d) {
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  if (day >= 28) return { s: new Date(y, m, 28), e: new Date(y, m + 1, 12) };
  if (day <= 12) return { s: new Date(y, m - 1, 28), e: new Date(y, m, 12) };
  return { s: new Date(y, m, 13), e: new Date(y, m, 27) };
}
const prevPeriod = (p) => { const d = new Date(p.s); d.setDate(d.getDate() - 1); return periodOf(d); };
const periodLabel = (p) => `${MON[p.s.getMonth()]} ${p.s.getDate()} - ${MON[p.e.getMonth()]} ${p.e.getDate()}, ${p.e.getFullYear()}`;
function periodDays(p) { const out = []; const d = new Date(p.s); while (d <= p.e) { out.push(new Date(d)); d.setDate(d.getDate() + 1); } return out; }
const logKey = (id, y) => `dtr:log:${id}:${y}`;

/* storage — DTR data stays in its own table and never shares Project Ledger rows */
const DTR_STORAGE_TABLE = "dtr_storage_dtr";
async function sGet(key, fb) {
  let cloudMissing = false;
  if (isConfigured && supabase) {
    try {
      const { data, error } = await supabase.from(DTR_STORAGE_TABLE).select("payload").eq("storage_key", key).maybeSingle();
      if (!error && data) return data.payload;
      cloudMissing = !error;
    } catch (e) { /* use platform storage below */ }
  }
  try {
    const r = await window.storage.get(key, true);
    const value = r && r.value ? JSON.parse(r.value) : fb;
    if (cloudMissing && isConfigured && supabase) {
      await supabase.from(DTR_STORAGE_TABLE).upsert({ storage_key: key, payload: value }, { onConflict: "storage_key" });
    }
    return value;
  } catch (e) { return fb; }
}
async function sSet(key, val) {
  if (isConfigured && supabase) {
    try {
      const { error } = await supabase.from(DTR_STORAGE_TABLE).upsert({ storage_key: key, payload: val }, { onConflict: "storage_key" });
      if (!error) return true;
    } catch (e) { /* use platform storage below */ }
  }
  try { const r = await window.storage.set(key, JSON.stringify(val), true); return !!r; }
  catch (e) { return false; }
}

/* ============================ styles ============================ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&display=swap');
.qm{--zinc:#DDE1E3;--zinc-dk:#C3CACD;--ink:#12233A;--ink-soft:#3D4E63;--hivis:#F2A81D;--signal:#1F7A5C;--rust:#A63A2B;
  --disp:"Barlow Condensed","Arial Narrow",sans-serif;--body:"Inter",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,monospace;
  background:var(--zinc);color:var(--ink);font-family:var(--body);font-size:15px;min-height:100vh;padding:18px 16px 60px}
.qm *{box-sizing:border-box}
.qm button{font-family:inherit;cursor:pointer}
.qm .inner{max-width:1120px;margin:0 auto}
.qm :focus-visible{outline:3px solid var(--hivis);outline-offset:2px}

.qm .top{display:flex;align-items:center;gap:14px;border-bottom:2px solid var(--ink);padding-bottom:10px;margin-bottom:22px;flex-wrap:wrap}
.qm .mark{width:34px;height:34px;flex:none;background:var(--ink);color:var(--hivis);font-family:var(--disp);font-weight:700;font-size:19px;display:grid;place-items:center;overflow:hidden}
.qm .mark img{width:100%;height:100%;object-fit:contain;background:#fff}
.qm .brand{font-family:var(--disp);font-weight:700;font-size:23px;letter-spacing:.06em;text-transform:uppercase;line-height:1}
.qm .brand small{display:block;font-family:var(--body);font-size:10.5px;font-weight:500;letter-spacing:.16em;color:var(--ink-soft);margin-top:3px}
.qm .nav{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
.qm .nav button{background:none;border:1.5px solid transparent;padding:7px 13px;font-family:var(--disp);font-size:15.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-soft)}
.qm .nav button.on{border-color:var(--ink);color:var(--ink);background:#fff}
.qm .nav button.out{color:var(--rust)}
.qm .clock{font-family:var(--mono);font-size:13px;color:var(--ink-soft)}

.qm .card{background:#fff;border:1.5px solid var(--ink);padding:22px}
.qm h2.sec{font-family:var(--disp);font-size:22px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;margin:0 0 4px}
.qm h3.s2{font-family:var(--disp);font-size:17px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;margin:28px 0 3px;padding-top:22px;border-top:1.5px solid var(--zinc-dk)}
.qm h3.s2.first{margin-top:0;padding-top:0;border-top:none}
.qm p.sub{color:var(--ink-soft);font-size:13.5px;margin:0 0 20px;max-width:62ch;line-height:1.5}
.qm .lbl{font-size:10.5px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--ink-soft);display:block;margin-bottom:5px}
.qm .hint{font-size:12.5px;color:var(--ink-soft);line-height:1.5}
.qm .saved{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--signal);font-weight:600;opacity:0;transition:opacity .25s}
.qm .saved.on{opacity:1}

.qm .lock{display:grid;grid-template-columns:1fr 300px;min-height:430px;padding:0}
@media(max-width:760px){.qm .lock{grid-template-columns:1fr}}
.qm .lockL{padding:34px 30px;display:flex;gap:26px;align-items:center}
.qm .lockText{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.qm .lockPhoto{flex:none;width:149px}
.qm .lockPhoto .frame{width:149px;height:182px;border:1.5px solid var(--ink);background:#fff;display:grid;place-items:center;overflow:hidden;transition:border-color .2s}
.qm .lockPhoto .frame img{width:100%;height:100%;object-fit:cover;display:block}
.qm .lockPhoto .frame.empty{border-style:dashed;border-color:var(--zinc-dk)}
.qm .lockPhoto .frame .ph{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--zinc-dk);text-align:center;white-space:pre-line;line-height:1.6}
.qm .lockPhoto .cap{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft);text-align:center;margin-top:8px}
@media(max-width:520px){.qm .lockL{flex-direction:column-reverse;align-items:stretch}.qm .lockPhoto{width:100%;display:flex;gap:12px;align-items:center}.qm .lockPhoto .frame{width:91px;height:113px}.qm .lockPhoto .cap{margin:0;text-align:left}}
.qm .lockR{border-left:1.5px solid var(--ink);padding:26px;background:var(--zinc)}
@media(max-width:760px){.qm .lockR{border-left:none;border-top:1.5px solid var(--ink)}}
.qm .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--rust);margin-bottom:10px}
.qm .lockText h1{font-family:var(--disp);font-size:clamp(30px,5vw,50px);font-weight:700;line-height:.95;text-transform:uppercase;margin:0 0 14px}
.qm .pinbox{font-family:var(--mono);font-weight:700;font-size:38px;letter-spacing:.22em;border:none;border-bottom:3px solid var(--ink);background:none;width:100%;padding:6px 0 8px;color:var(--ink)}
.qm .pinbox::placeholder{color:var(--zinc-dk)}
.qm .whois{margin-top:14px;min-height:52px;font-size:14px}
.qm .whois strong{font-family:var(--disp);font-size:24px;font-weight:700;text-transform:uppercase;display:block;line-height:1.1;color:var(--signal)}
.qm .whois span{color:var(--ink-soft);font-size:12.5px}
.qm .whois.bad{color:var(--rust);font-weight:500;line-height:1.4}
.qm .pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.qm .pad button{background:#fff;border:1.5px solid var(--ink);padding:15px 0;font-family:var(--mono);font-weight:500;font-size:21px;color:var(--ink)}
.qm .pad button:active{transform:translateY(2px);background:var(--hivis)}
.qm .pad button.go{background:var(--ink);color:#fff;font-family:var(--disp);font-size:17px;letter-spacing:.1em;text-transform:uppercase}

.qm .whohd{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;border-bottom:1.5px solid var(--ink);padding-bottom:14px;margin-bottom:20px}
.qm .whohd h2{font-family:var(--disp);font-size:34px;font-weight:700;text-transform:uppercase;margin:0;line-height:1}
.qm .whohd .meta{font-size:12.5px;color:var(--ink-soft);flex:1}
.qm .datepick{flex:none;text-align:right;position:relative}
.qm .datepick .lbl{margin-bottom:4px}
.qm .dprow{display:flex;gap:6px;align-items:center}
.qm .dpbtn{border:1.5px solid var(--ink);background:#fff;padding:7px 11px;font-size:13.5px;font-family:var(--body);color:var(--ink);min-width:130px}
.qm .dptoday{border:1.5px solid var(--ink);background:var(--hivis);color:var(--ink);padding:7px 11px;font-family:var(--disp);font-size:14px;letter-spacing:.08em;text-transform:uppercase}
.qm .calmask{position:fixed;inset:0;z-index:30}
.qm .calpop{position:absolute;right:0;top:calc(100% + 6px);z-index:40;background:#fff;border:1.5px solid var(--ink);padding:12px;width:268px;box-shadow:0 10px 30px rgba(18,35,58,.25);text-align:left}
.qm .calhd{display:flex;align-items:center;justify-content:space-between;margin-bottom:9px}
.qm .calhd span{font-family:var(--disp);font-size:17px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.qm .calhd button{border:1.5px solid var(--zinc-dk);background:#fff;width:26px;height:26px;font-size:15px;color:var(--ink);line-height:1;padding:0}
.qm .calgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.qm .calgrid .dow{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);text-align:center;padding-bottom:4px;font-weight:600}
.qm .calgrid button{border:1.5px solid transparent;background:none;padding:6px 0;font-family:var(--mono);font-size:13px;color:var(--ink)}
.qm .calgrid button.has{background:var(--hivis);font-weight:700}
.qm .calgrid button.today{border-color:var(--ink-soft)}
.qm .calgrid button.sel{background:var(--ink);color:#fff;border-color:var(--ink)}
.qm .calgrid button:disabled{color:var(--zinc-dk);cursor:not-allowed;background:none;border-color:transparent}
.qm .calleg{margin-top:10px;font-size:11px;color:var(--ink-soft);display:flex;align-items:center;gap:7px}
.qm .calleg i{width:13px;height:13px;background:var(--hivis);display:inline-block;flex:none}
.qm .leavecard{border:1.5px solid var(--ink);background:var(--zinc);padding:22px 24px;margin-bottom:22px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.qm .leavecard div{flex:1;min-width:220px}
.qm .leavecard strong{display:block;font-family:var(--disp);font-size:34px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;line-height:1;margin-bottom:6px}
.qm .leavecard span{font-size:13px;color:var(--ink-soft);line-height:1.5}
.qm .leavecard button{flex:none;border:1.5px solid var(--ink);background:#fff;color:var(--ink);padding:11px 16px;font-family:var(--disp);font-size:16px;letter-spacing:.08em;text-transform:uppercase}
.qm .leavebtn{border-style:dashed;color:var(--ink-soft)}
.qm .pastnote{border:1.5px solid var(--rust);color:var(--rust);padding:14px 16px;font-size:13.5px;line-height:1.5;margin-bottom:10px}
.qm .pastnote strong{font-family:var(--disp);font-size:19px;letter-spacing:.05em;text-transform:uppercase;display:block;margin-bottom:3px}
.qm .strip{display:grid;grid-template-columns:repeat(6,1fr);border:1.5px solid var(--ink);background:var(--ink);gap:1.5px;margin-bottom:22px}
@media(max-width:700px){.qm .strip{grid-template-columns:repeat(3,1fr)}}
.qm .slot{background:#fff;padding:12px 8px 14px;text-align:center;position:relative;min-height:96px;display:flex;flex-direction:column;justify-content:center}
.qm .slot .k{font-size:9.5px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:8px}
.qm .slot .v{font-family:var(--mono);font-weight:700;font-size:19px;color:var(--zinc-dk)}
.qm .slot.done{background:#F3F7F5}
.qm .slot.done .v,.qm .slot.done .k{color:var(--signal)}
.qm .slot.next{background:var(--hivis)}
.qm .slot.next .k,.qm .slot.next .v{color:var(--ink)}
.qm .slot.next:after{content:"";position:absolute;inset:3px;border:2px dashed var(--ink);opacity:.55}
.qm .slot .ed{position:absolute;top:5px;right:6px;background:none;border:none;font-size:10px;color:var(--ink-soft);opacity:.6;padding:2px 4px}
.qm .act{display:grid;grid-template-columns:1fr 300px;gap:20px}
@media(max-width:820px){.qm .act{grid-template-columns:1fr}}
.qm .big{width:100%;border:1.5px solid var(--ink);background:var(--ink);color:#fff;font-family:var(--disp);font-size:clamp(24px,3.6vw,34px);font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:26px 20px;line-height:1.05}
.qm .big.warn{background:var(--rust);border-color:var(--rust)}
.qm .big small{display:block;font-family:var(--body);font-size:12px;font-weight:500;letter-spacing:.05em;text-transform:none;opacity:.8;margin-top:7px}
.qm .big:disabled{background:var(--zinc);color:var(--ink-soft);border-color:var(--zinc-dk);cursor:not-allowed}
.qm .ot{width:100%;margin-top:10px;background:#fff;color:var(--ink);border:1.5px solid var(--ink);padding:14px;font-family:var(--disp);font-size:19px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.qm textarea.note{width:100%;min-height:132px;border:1.5px solid var(--ink);padding:11px 12px;font-size:14px;line-height:1.5;resize:vertical;font-family:var(--body)}
.qm .tally{display:flex;gap:20px;margin-top:14px;border-top:1.5px solid var(--zinc-dk);padding-top:12px}
.qm .tally div{flex:1}
.qm .tally .n{font-family:var(--mono);font-size:25px;font-weight:700}

.qm .ctl{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
.qm .ctl select,.qm .ctl input{border:1.5px solid var(--ink);background:#fff;padding:9px 11px;font-size:14px;color:var(--ink);font-family:var(--body)}
.qm .btn{background:var(--ink);color:#fff;border:1.5px solid var(--ink);padding:10px 18px;font-family:var(--disp);font-size:17px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.qm a.btn{text-decoration:none;display:inline-block;line-height:1.15}
.qm .btn.ghost{background:#fff;color:var(--ink)}
.qm .btn.sm{padding:7px 12px;font-size:14px}

.qm table.roster{width:100%;border-collapse:collapse;margin-bottom:10px}
.qm table.roster th{font-size:10.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-soft);text-align:left;padding:0 8px 7px;font-weight:600}
.qm table.roster td{padding:0 4px 8px}
.qm table.roster input{width:100%;border:1.5px solid var(--zinc-dk);padding:8px 9px;font-size:14px;font-family:var(--body)}
.qm table.roster input:focus{border-color:var(--ink)}
.qm .rolesel{width:100%;border:1.5px solid var(--zinc-dk);padding:8px 6px;font-size:13.5px;font-family:var(--body);background:#fff;color:var(--ink)}
.qm .rolesel:focus{border-color:var(--ink)}
.qm table.roster td.x button{background:none;border:1.5px solid var(--zinc-dk);color:var(--rust);padding:7px 10px;font-size:13px}
.qm .photocell{width:54px;height:66px;border:1.5px dashed var(--zinc-dk);background:#fff;display:grid;place-items:center;overflow:hidden;cursor:pointer}
.qm .photocell img{width:100%;height:100%;object-fit:cover;display:block}
.qm .photocell span{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--zinc-dk)}
.qm .photocell:hover{border-color:var(--ink)}
.qm .photoclear{display:block;margin-top:4px;background:none;border:none;padding:0;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--rust)}
.qm .avatar{width:46px;height:56px;border:1.5px solid var(--ink);object-fit:cover;flex:none;display:block}

.qm .logoRow{display:flex;gap:22px;align-items:flex-start;flex-wrap:wrap}
.qm .logoPrev{width:92px;height:92px;border:1.5px solid var(--ink);background:#fff;display:grid;place-items:center;flex:none;overflow:hidden}
.qm .logoPrev img{max-width:100%;max-height:100%;object-fit:contain}
.qm .logoPrev .none{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--zinc-dk);text-align:center;padding:6px}
.qm .grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;max-width:640px}
.qm .grid3 input{width:100%;border:1.5px solid var(--zinc-dk);padding:8px 9px;font-size:14px;font-family:var(--body)}
.qm .banner{background:var(--rust);color:#fff;padding:10px 14px;font-size:13px;margin-bottom:16px}
.qm .toast{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:60;background:var(--ink);color:#fff;padding:13px 22px;border-left:5px solid var(--hivis);font-family:var(--disp);font-size:19px;letter-spacing:.06em;text-transform:uppercase;box-shadow:0 8px 26px rgba(18,35,58,.3);max-width:88vw}
.qm .modal{position:fixed;inset:0;background:rgba(18,35,58,.55);display:grid;place-items:center;z-index:70;padding:20px}
.qm .modal .box{background:#fff;border:1.5px solid var(--ink);padding:24px;width:min(380px,100%)}
.qm .modal h3{font-family:var(--disp);font-size:22px;font-weight:700;text-transform:uppercase;margin:0 0 4px}
.qm .modal p{font-size:13px;color:var(--ink-soft);margin:0 0 16px}
.qm .modal input{width:100%;border:none;border-bottom:2.5px solid var(--ink);font-family:var(--mono);font-size:26px;font-weight:700;padding:4px 0 6px;background:none;color:var(--ink)}
.qm .modal .row{display:flex;gap:8px;margin-top:20px}
.qm .modal .row button{flex:1;padding:11px;font-family:var(--disp);font-size:16px;letter-spacing:.08em;text-transform:uppercase;border:1.5px solid var(--ink);background:#fff;color:var(--ink)}
.qm .modal .row button.pri{background:var(--ink);color:#fff}
.qm .modal .row button.del{border-color:var(--rust);color:var(--rust)}
.qm .sheetwrap{background:var(--zinc-dk);padding:20px;overflow-x:auto}
.qm .shadow{box-shadow:0 6px 24px rgba(18,35,58,.22)}
@media (prefers-reduced-motion:reduce){.qm *{transition:none!important}}
`;

/* the printed A4 form — kept separate so the print window can reuse it verbatim */
const SHEET_CSS = `
.sheet{width:190mm;margin:0 auto;background:#fff;padding:5mm 5mm 6mm;font-family:Arial,Helvetica,sans-serif;color:#000;font-size:8.5pt;line-height:1.2}
.sheet table{border-collapse:collapse;table-layout:fixed;width:100%}
.sheet .hdr td{border:0.9pt solid #000;padding:1mm 2mm;vertical-align:middle}
.sheet .hdr .logoc{width:19mm;text-align:center;padding:1.2mm}
.sheet .hdr .logoc img{max-width:15mm;max-height:13mm;display:block;margin:0 auto}
.sheet .hdr .logoc .ph{display:inline-block;border:1.6pt solid #C00;color:#C00;font-weight:bold;font-size:11pt;padding:0.8mm 2mm}
.sheet .hdr .co{text-align:center;font-weight:bold;font-size:15pt;letter-spacing:0.7pt;padding:2mm 0}
.sheet .hdr td.lab{position:relative;text-align:center;font-weight:bold;font-size:10pt;letter-spacing:0.4pt;padding:1.1mm 2mm}
.sheet .hdr td.lab .k{position:absolute;left:2mm;top:0;bottom:0;display:flex;align-items:center;font-weight:normal;font-size:8pt;letter-spacing:0}
.sheet .flds{margin:3.5mm 0 3mm}
.sheet .flds td{padding:0 0 3mm;vertical-align:baseline;font-size:8.5pt;letter-spacing:0.15pt;line-height:1.05}
.sheet .flds tr:last-child td{padding-bottom:1mm}
.sheet .flds .fk{width:38mm;white-space:nowrap}
.sheet .flds .fv{padding:0 0 0 2mm}
.sheet .flds .fv .ul{display:block;border-bottom:0.9pt solid #000;font-weight:normal;font-size:8.5pt;line-height:1.05;padding-bottom:0.6mm;min-height:3.4mm}
.sheet .flds .gap{width:12mm}
.sheet .dtr th,.sheet .dtr td{border:0.9pt solid #000;text-align:center;vertical-align:middle;padding:0}
.sheet .dtr th{font-size:7.2pt;font-weight:bold;letter-spacing:0.25pt;padding:1.1mm 0.4mm;line-height:1.15}
.sheet .dtr tbody td{height:7mm;font-size:8pt}
.sheet .dtr td.dt{font-size:8pt}
.sheet .dtr .sund{font-size:6pt;font-weight:bold;letter-spacing:0.3pt}
.sheet .dtr td.leave{font-weight:bold;font-size:8pt;letter-spacing:1.2pt}
.sheet .dtr td.num{font-size:8pt;font-weight:bold}
.sheet .dtr td.actc{text-align:left;padding:0 1.6mm;font-size:7.8pt;line-height:1.25}
.sheet .dtr tr.tot td{font-weight:bold;height:7.4mm;font-size:8.5pt;letter-spacing:0.3pt}
.sheet .dtr input,.sheet .dtr .cell{width:100%;height:100%;min-height:6.4mm;border:none;background:transparent;font-family:Arial,Helvetica,sans-serif;font-size:7.2pt;text-align:center;padding:0;color:#000}
.sheet .dtr td.actc .cell{text-align:left;font-size:7.8pt;line-height:1.25;padding-top:1mm;outline:none}
.sheet .dtr input:focus,.sheet .dtr .cell:focus{background:#FFF3D0;outline:none}
.sheet .sig{margin-top:13mm}
.sheet .sig td{font-size:8pt;text-align:center;font-weight:bold;letter-spacing:0.3pt;padding-top:1.2mm}
.sheet .sig td.ln{border-top:0.9pt solid #000}
.sheet .sig td.sp{border:none;width:7mm}
`;

const PRINT_CSS = `
@media print{
  @page{size:A4 portrait;margin:9mm}
  .qm{background:#fff;padding:0}
  .qm .noprint{display:none!important}
  .qm .sheetwrap{background:none;padding:0;overflow:visible}
  .qm .shadow{box-shadow:none}
  .qm .sheet{width:auto;padding:0}
}
`;

/* ============================ component ============================ */
export default function DTRSystem({ onBack }) {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState("lock");
  const [roster, setRoster] = useState([]);
  const [cfg, setCfg] = useState(DEF);
  const [me, setMe] = useState(null);
  const [pin, setPin] = useState("");
  const [lockMsg, setLockMsg] = useState("");
  const [note, setNote] = useState("");
  const [punchDate, setPunchDate] = useState(iso(new Date()));
  const [printHref, setPrintHref] = useState("");
  const [calOpen, setCalOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [perStart, setPerStart] = useState(iso(periodOf(new Date()).s));
  const [site, setSite] = useState("");
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState("");
  const [flash, setFlash] = useState("");
  const [storeFail, setStoreFail] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [tickN, forceTick] = useState(0);

  const logsRef = useRef({});
  const sheetRef = useRef(null);
  const timers = useRef({});
  const firstRun = useRef(true);

  const bump = () => forceTick((n) => n + 1);
  const sched = cfg.sched || SCHED_DEF;
  /* settings stay open while nobody is set up yet, so the system can be bootstrapped */
  const isAdmin = !roster.some((r) => r.id) || !!(me && me.role === "admin");
  const say = useCallback((m) => { setToast(m); setTimeout(() => setToast(""), 2800); }, []);
  const flashSaved = (which) => { setFlash(which); setTimeout(() => setFlash(""), 1400); };

  /* ---- boot ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, c] = await Promise.all([sGet("dtr:roster", []), sGet("dtr:cfg", null)]);
      if (!alive) return;
      const rr = Array.isArray(r) ? r : [];
      const withRoles = rr.map((e) => ({ ...e, role: e.role === "admin" ? "admin" : "viewer" }));
      /* a roster saved before roles existed still needs one admin, or nobody could reach Settings */
      if (withRoles.length && !withRoles.some((e) => e.role === "admin")) {
        withRoles[Math.max(0, withRoles.findIndex((e) => e.id === ADMIN_ID))].role = "admin";
      }
      setRoster(withRoles.length ? withRoles : [{ id: "", name: "", position: "", site: "", photo: "", role: "admin" }]);
      setCfg(Object.assign({}, DEF, c || {}));
      setView(rr.length ? "lock" : "settings");
      setReady(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { const t = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(t); }, []);

  /* ---- auto-save roster + header ---- */
  useEffect(() => {
    if (!ready) return;
    clearTimeout(timers.current.roster);
    timers.current.roster = setTimeout(async () => {
      const keep = roster
        .map((e) => ({ id: (e.id || "").trim(), name: (e.name || "").trim(), position: (e.position || "").trim(), site: (e.site || "").trim(), photo: e.photo || "", role: e.role === "admin" ? "admin" : "viewer" }))
        .filter((e) => e.id || e.name);
      const ids = keep.map((e) => e.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) { say("Two employees share the same ID"); return; }
      const ok = await sSet("dtr:roster", keep);
      setStoreFail(!ok);
      if (ok) flashSaved("roster");
    }, 600);
  }, [roster, ready, say]);

  useEffect(() => {
    if (!ready) return;
    if (firstRun.current) { firstRun.current = false; return; }
    clearTimeout(timers.current.cfg);
    timers.current.cfg = setTimeout(async () => {
      const ok = await sSet("dtr:cfg", cfg);
      setStoreFail(!ok);
      if (ok) flashSaved("cfg");
    }, 500);
  }, [cfg, ready]);

  /* ---- log access ---- */
  const ensureLog = useCallback(async (id, y) => {
    const k = logKey(id, y);
    if (!logsRef.current[k]) { logsRef.current[k] = await sGet(k, {}); bump(); }
    return logsRef.current[k];
  }, []);
  const recFor = (id, dateStr) => {
    const k = logKey(id, +dateStr.slice(0, 4));
    return (logsRef.current[k] || {})[dateStr] || {};
  };
  const writeRec = async (id, dateStr, mut) => {
    const y = +dateStr.slice(0, 4), k = logKey(id, y);
    logsRef.current[k] = logsRef.current[k] || {};
    logsRef.current[k][dateStr] = logsRef.current[k][dateStr] || {};
    mut(logsRef.current[k][dateStr]);
    bump();
    const ok = await sSet(k, logsRef.current[k]);
    setStoreFail(!ok);
    return ok;
  };

  /* ---- sign in ---- */
  const match = roster.find((r) => r.id && r.id === pin.trim());
  async function signIn() {
    const id = pin.trim();
    if (!id) return;
    const emp = roster.find((r) => r.id === id);
    if (!emp) {
      setLockMsg(roster.some((r) => r.id)
        ? `No employee with ID ${id}. Check the number, or add them under Settings.`
        : "Nobody is set up yet. Open Settings and add your team first.");
      return;
    }
    await ensureLog(emp.id, new Date().getFullYear());
    setMe(emp);
    setSite(emp.site || "");
    setPunchDate(iso(new Date()));
    setNote(recFor(emp.id, iso(new Date())).note || "");
    setLockMsg("");
    setPin("");
    setView("punch");
  }
  function signOut() { setMe(null); setPin(""); setLockMsg(""); setView("lock"); }

  /* ---- punching ---- */
  const todayStr = iso(new Date());
  const viewDate = punchDate || todayStr;
  const isToday = viewDate === todayStr;
  const rec = me ? recFor(me.id, viewDate) : {};
  const nextSlot = SLOTS.find((s) => !rec[s.k]);

  async function punch(slot) {
    if ((slot.k === "pmOut" || slot.k === "otOut") && !note.trim()) { say("Write your accomplishment first"); return; }
    const stamp = nowHM();
    const issue = orderIssue(rec, slot.k, stamp);
    if (issue) { say(issue); return; }
    await writeRec(me.id, viewDate, (r) => { r[slot.k] = stamp; r.note = note.trim(); });
    say(`${slot.label} recorded — ${disp(stamp, true)}`);
  }
  useEffect(() => {
    if (!me) return;
    clearTimeout(timers.current.note);
    timers.current.note = setTimeout(() => { writeRec(me.id, viewDate, (r) => { r.note = note.trim(); }); }, 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);

  /* any punch or accomplishment counts as a record for that date */
  const hasRecord = (ds) => {
    if (!me) return false;
    const r = recFor(me.id, ds);
    return !!r.leave || SLOTS.some((s) => r[s.k]) || !!(r.note && r.note.trim());
  };
  useEffect(() => {
    if (!me || !calOpen) return;
    ensureLog(me.id, calMonth.getFullYear());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, calOpen, calMonth]);

  useEffect(() => {
    if (view === "settings" && !isAdmin) setView(me ? "punch" : "lock");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, view]);

  /* switching date pulls that day's accomplishment in, and cancels any pending save for the old one */
  useEffect(() => {
    if (!me) return;
    clearTimeout(timers.current.note);
    ensureLog(me.id, +viewDate.slice(0, 4)).then(() => {
      setNote((recFor(me.id, viewDate).note || ""));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDate, me]);

  async function markLeave() {
    const go = async () => {
      await writeRec(me.id, viewDate, (r) => { SLOTS.forEach((s) => delete r[s.k]); r.leave = true; });
      say("Marked as leave");
      setConfirm(null);
    };
    if (SLOTS.some((s) => rec[s.k])) {
      setConfirm({
        title: "Mark as leave?",
        body: "This date already has punches recorded. Marking it as leave clears them.",
        yes: "Clear and mark leave",
        onYes: go,
      });
    } else go();
  }
  const clearLeave = () => writeRec(me.id, viewDate, (r) => { delete r.leave; });

  async function applyEdit(val, cleared) {
    const { slot, dateStr } = editing;
    if (cleared) { await writeRec(me.id, dateStr, (r) => { delete r[slot.k]; }); setEditing(null); return; }
    const t = parseTime(val, slot.mer);
    if (t === null) { say("Could not read that time"); return; }
    const issue = orderIssue(recFor(me.id, dateStr), slot.k, t);
    if (issue) { say(issue); return; }
    if ((slot.k === "pmOut" || slot.k === "otOut") && !note.trim()) {
      say("Write your accomplishment first"); return;
    }
    await writeRec(me.id, dateStr, (r) => { r[slot.k] = t; if (note.trim()) r.note = note.trim(); });
    setEditing(null);
  }

  /* ---- periods ---- */
  const periods = (() => { let p = periodOf(new Date()); const out = []; for (let i = 0; i < 10; i++) { out.push(p); p = prevPeriod(p); } return out; })();
  const sd = perStart.split("-").map(Number);
  const period = periodOf(new Date(sd[0], sd[1] - 1, sd[2]));
  /* Sundays are hidden unless something was actually recorded that day */
  const workedOn = (d) => {
    if (!me) return false;
    const r = recFor(me.id, iso(d));
    return !!r.leave || SLOTS.some((s) => r[s.k]) || !!(r.note && r.note.trim());
  };
  const days = periodDays(period).filter((d) => d.getDay() !== 0 || workedOn(d));

  useEffect(() => {
    if (!me || view !== "dtr") return;
    const yrs = [];
    days.forEach((d) => { if (yrs.indexOf(d.getFullYear()) < 0) yrs.push(d.getFullYear()); });
    yrs.forEach((y) => ensureLog(me.id, y));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, view, perStart]);

  /* ---- printing ---- */
  function buildPrintable() {
    const node = sheetRef.current;
    if (!node) return null;
    const clone = node.cloneNode(true);
    clone.classList.remove("shadow");
    clone.querySelectorAll("input").forEach((i) => {
      const s = document.createElement("span");
      s.textContent = i.value;
      s.style.fontSize = "8pt";
      i.replaceWith(s);
    });
    clone.querySelectorAll(".cell").forEach((d) => d.removeAttribute("contenteditable"));
    return clone;
  }
  const dtrFileName = () =>
    `DTR_${(me && me.name ? me.name : "employee").replace(/\s+/g, "_")}_${periodLabel(period).replace(/[^\w]+/g, "-")}.pdf`;

  /* a real anchor with a prepared blob URL survives sandboxes that block scripted popups */
  useEffect(() => {
    if (view !== "dtr" || !me) return;
    let dead = false;
    const t = setTimeout(async () => {
      let logo = null;
      if (cfg.logo) { try { logo = await logoAsJpeg(cfg.logo); } catch (e) { logo = null; } }
      if (dead) return;
      const cap = schedCap(sched);
      let dSum = 0, oSum = 0;
      const rows = days.map((d) => {
        const r = recFor(me.id, iso(d));
        const dm = dayMinutes(r, sched), om = otMinutes(r);
        dSum += dm; oSum += om;
        return {
          date: `${MON[d.getMonth()].slice(0, 3)} ${d.getDate()}`,
          sun: d.getDay() === 0,
          leave: !!r.leave,
          times: SLOTS.map((s) => (r[s.k] ? disp(r[s.k], true) : "")),
          day: dm ? fmtDay(dm, cap) : "",
          ot: om ? fmtDur(om) : "",
          note: r.note || "",
        };
      });
      try {
        const bytes = buildDtrPdf({
          co: cfg.co || DEF.co, dept: cfg.dept || DEF.dept, title: cfg.title || DEF.title, logo,
          name: me.name || "", position: me.position || "", site, period: periodLabel(period),
          rows, dayTotal: fmtDay(dSum, cap), otTotal: fmtDur(oSum),
        });
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        if (dead) { URL.revokeObjectURL(url); return; }
        setPrintHref((old) => { if (old) URL.revokeObjectURL(old); return url; });
      } catch (e) { setPrintHref(""); }
    }, 200);
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, me, perStart, site, cfg, tickN]);

  function printableDoc() {
    const clone = buildPrintable();
    if (!clone) return null;
    const parts = [
      "<!DOCTYPE html>", "<html>", "<head>", '<meta charset="utf-8">',
      "<title>Daily Time Record</title>",
      "<sty" + "le>" + SHEET_CSS + "@page{size:A4 portrait;margin:9mm} html,body{margin:0;padding:0;background:#fff} .sheet{width:auto;margin:0;padding:0;box-shadow:none}</sty" + "le>",
      "</head>", "<bo" + "dy>", clone.outerHTML, "</bo" + "dy>", "</html>",
    ];
    return parts.join("");
  }

  function doPrint() {
    const clone = buildPrintable();
    if (!clone) return;
    let w = null;
    try { w = window.open("", "_blank"); } catch (e) { w = null; }
    if (w && w.document) {
      const st = w.document.createElement("style");
      st.textContent = SHEET_CSS + "@page{size:A4 portrait;margin:9mm} .sheet{width:auto;margin:0;padding:0}";
      w.document.head.appendChild(st);
      w.document.title = "Daily Time Record";
      w.document.body.style.margin = "0";
      w.document.body.appendChild(clone);
      setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 400);
      return;
    }
    try { window.print(); } catch (e) { say("Printing is blocked here — use Download copy"); }
  }
  function doDownload() {
    const html = printableDoc();
    if (!html) return;
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      a.download = dtrFileName();
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      say("Downloaded — open it, then press Ctrl+P");
    } catch (e) { say("Download blocked — use the link instead"); }
  }

  /* ---- logo upload ---- */
  async function onLogo(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = await scaleImage(f, 260, "image/png");
      setCfg((p) => ({ ...p, logo: data }));
      say("Logo saved");
    } catch (err) { say("That file could not be read as an image"); }
  }

  async function onPhoto(i, e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const data = await scaleImage(f, 360, "image/jpeg", 0.82);
      setRoster((p) => p.map((emp, j) => (j === i ? { ...emp, photo: data } : emp)));
      say("Photo saved");
    } catch (err) { say("That file could not be read as an image"); }
  }

  /* ---- roster editing ---- */
  const setEmp = (i, field, val) =>
    setRoster((p) => p.map((e, j) => (j === i ? { ...e, [field]: field === "id" ? val.replace(/\s/g, "") : val } : e)));
  const addEmp = () => setRoster((p) => [...p, { id: "", name: "", position: "", site: "", photo: "", role: "viewer" }]);
  const adminsBesides = (i) => roster.filter((e, j) => j !== i && e.role === "admin" && (e.id || e.name)).length;
  const setRole = (i, val) => {
    if (val !== "admin" && adminsBesides(i) === 0) { say("Keep at least one admin, or nobody can open Settings"); return; }
    setRoster((p) => p.map((e, j) => (j === i ? { ...e, role: val } : e)));
  };
  const delEmp = (i) => {
    if (roster[i] && roster[i].role === "admin" && adminsBesides(i) === 0 && roster.length > 1) {
      say("Make someone else an admin before removing this one"); return;
    }
    setRoster((p) => (p.length > 1 ? p.filter((_, j) => j !== i) : [{ id: "", name: "", position: "", site: "", photo: "", role: "admin" }]));
  };

  /* ============================ render ============================ */
  const key = (k) => (view === k ? "on" : "");
  let dTot = 0, oTot = 0;

  return (
    <div className="qm">
      <style>{CSS + SHEET_CSS + PRINT_CSS}</style>
      <div className="inner">
        <div className="top noprint">
          <div className="mark">
            {cfg.logo ? <img src={cfg.logo} alt="" /> : (cfg.co || "QM").slice(0, 2).toUpperCase()}
          </div>
          <div className="brand">{cfg.co || "QM Builders"}<small>Daily Time Record</small></div>
          <div className="nav">
            {onBack && <button className="out" onClick={onBack}>Back to Project Ledger</button>}
            <button className={view === "punch" || view === "lock" ? "on" : ""} onClick={() => setView(me ? "punch" : "lock")}>Punch</button>
            {me && <button className={key("dtr")} onClick={() => setView("dtr")}>My DTR</button>}
            {isAdmin && <button className={key("settings")} onClick={() => setView("settings")}>Settings</button>}
            {me && <button className="out" onClick={signOut}>Sign out</button>}
          </div>
          <div className="clock">
            {disp(`${p2(clock.getHours())}:${p2(clock.getMinutes())}`, true)} · {clock.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
          </div>
        </div>

        {storeFail && <div className="banner noprint">Saving is unavailable right now, so changes won't be kept. Reload the page to try again.</div>}

        {/* ---------- LOCK ---------- */}
        {view === "lock" && (
          <div className="card lock">
            <div className="lockL">
              <div className="lockText">
                <div className="eyebrow">{clock.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
                <h1>Enter your<br />ID number</h1>
                <input
                  className="pinbox" inputMode="numeric" autoComplete="off" placeholder="----" maxLength={8}
                  aria-label="ID number" value={pin}
                  onChange={(e) => { setPin(e.target.value); setLockMsg(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") signIn(); }}
                />
                <div className={"whois" + (lockMsg ? " bad" : "")}>
                  {match ? (<><strong>{match.name || "(no name)"}</strong><span>{match.position || ""}</span></>) : lockMsg}
                </div>
              </div>
              <div className="lockPhoto">
                <div className={"frame" + (match && match.photo ? "" : " empty")}>
                  {match && match.photo
                    ? <img src={match.photo} alt={match.name || "Employee"} />
                    : <span className="ph">{match ? "No photo\non file" : "Photo"}</span>}
                </div>
                <div className="cap">{match ? `ID ${match.id}` : "Awaiting ID"}</div>
              </div>
            </div>
            <div className="lockR">
              <div className="pad">
                {["1","2","3","4","5","6","7","8","9","⌫","0","ENTER"].map((t) => (
                  <button
                    key={t} type="button" className={t === "ENTER" ? "go" : ""}
                    onClick={() => {
                      if (t === "ENTER") return signIn();
                      setLockMsg("");
                      if (t === "⌫") return setPin((p) => p.slice(0, -1));
                      setPin((p) => (p.length < 8 ? p + t : p));
                    }}
                  >{t}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------- PUNCH ---------- */}
        {view === "punch" && me && (
          <div className="card">
            <div className="whohd">
              {me.photo && <img className="avatar" src={me.photo} alt="" />}
              <h2>{me.name || "(no name)"}</h2>
              <div className="meta">{[me.position, me.site].filter(Boolean).join("  ·  ")}  ·  ID {me.id}</div>
              <div className="datepick">
                <span className="lbl">Record for</span>
                <div className="dprow">
                  <button className="dpbtn" onClick={() => {
                    const d = new Date(viewDate + "T00:00");
                    setCalMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                    setCalOpen((o) => !o);
                  }}>
                    {new Date(viewDate + "T00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </button>
                  {!isToday && <button className="dptoday" onClick={() => { setPunchDate(todayStr); setCalOpen(false); }}>Today</button>}
                </div>
                {calOpen && (
                  <>
                    <div className="calmask" onClick={() => setCalOpen(false)} />
                    <div className="calpop">
                      <div className="calhd">
                        <button onClick={() => setCalMonth((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>‹</button>
                        <span>{MON[calMonth.getMonth()]} {calMonth.getFullYear()}</span>
                        <button onClick={() => setCalMonth((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>›</button>
                      </div>
                      <div className="calgrid">
                        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((w) => <div className="dow" key={w}>{w}</div>)}
                        {Array.from({ length: new Date(calMonth.getFullYear(), calMonth.getMonth(), 1).getDay() })
                          .map((_, i) => <div key={"b" + i} />)}
                        {Array.from({ length: new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate() })
                          .map((_, i) => {
                            const ds = iso(new Date(calMonth.getFullYear(), calMonth.getMonth(), i + 1));
                            const cls = [
                              hasRecord(ds) ? "has" : "",
                              ds === viewDate ? "sel" : "",
                              ds === todayStr ? "today" : "",
                            ].filter(Boolean).join(" ");
                            return (
                              <button key={ds} className={cls} disabled={ds > todayStr}
                                onClick={() => { setPunchDate(ds); setCalOpen(false); }}>
                                {i + 1}
                              </button>
                            );
                          })}
                      </div>
                      <div className="calleg"><i /> has punches recorded</div>
                    </div>
                  </>
                )}
              </div>
            </div>
            {rec.leave ? (
              <div className="leavecard">
                <div>
                  <strong>On leave</strong>
                  <span>No punches are recorded for this date. It prints as ON LEAVE across the time columns of your DTR.</span>
                </div>
                <button onClick={clearLeave}>Cancel leave</button>
              </div>
            ) : (
            <div className="strip">
              {SLOTS.map((s) => (
                <div key={s.k} className={"slot" + (rec[s.k] ? " done" : "") + (nextSlot && nextSlot.k === s.k ? " next" : "")}>
                  <div className="k">{s.label}</div>
                  <div className="v">{rec[s.k] ? disp(rec[s.k], true) : "--:--"}</div>
                  <button
                    className="ed" type="button"
                    onClick={() => setEditing({ slot: s, dateStr: viewDate, value: rec[s.k] ? disp(rec[s.k], true) : "" })}
                  >{rec[s.k] ? "edit" : "set"}</button>
                </div>
              ))}
            </div>
            )}
            <div className="act">
              <div>
                {!isToday && !rec.leave && (
                  <div className="pastnote">
                    <strong>Back-filling {new Date(viewDate + "T00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</strong>
                    The live punch button is off for past dates. Use <em>set</em> or <em>edit</em> on each slot above, or the button below, and type the time you actually worked.
                  </div>
                )}
                {!rec.leave && isToday && (nextSlot ? (
                  <button className={"big" + (nextSlot.k === "pmOut" || nextSlot.k === "otOut" ? " warn" : "")} onClick={() => punch(nextSlot)}>
                    {nextSlot.btn}<small>{nextSlot.sub}</small>
                  </button>
                ) : (
                  <button className="big" disabled>All punched for today<small>Nothing left to record. Come back tomorrow.</small></button>
                ))}
                {!rec.leave && nextSlot && (
                  <button className="ot" onClick={() => setEditing({ slot: nextSlot, dateStr: viewDate, value: "" })}>
                    Enter {nextSlot.label} manually
                  </button>
                )}
                {!rec.leave && !nextSlot && !isToday && (
                  <div className="hint" style={{ marginBottom: 10 }}>All six punches are filled for this date.</div>
                )}
                {!rec.leave && isToday && nextSlot && nextSlot.k === "otIn" && (
                  <button className="ot" onClick={signOut}>No overtime today</button>
                )}
                {!rec.leave && (
                  <button className="ot leavebtn" onClick={markLeave}>Mark this date as leave</button>
                )}
                <div className="tally">
                  <div>
                    <span className="lbl">Day credit{isToday ? " today" : ""}</span>
                    <span className="n">{fmtDay(dayMinutes(rec, sched), schedCap(sched))}</span>
                  </div>
                  <div><span className="lbl">Overtime{isToday ? " today" : ""}</span><span className="n">{fmtDur(otMinutes(rec))}</span></div>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  A full day ({fmtDur(schedCap(sched))} between {disp(sched.amStart, true)}–{disp(sched.amEnd, true)} and{" "}
                  {disp(sched.pmStart, true)}–{disp(sched.pmEnd, true)}) counts as 1.00 day. Overtime is counted in hours.
                </div>
              </div>
              <div>
                <span className="lbl">{isToday ? "Today's accomplishment" : "Accomplishment for this date"}</span>
                <textarea className="note" value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="What you finished. Required before you can time out." />
                <div className="hint" style={{ marginTop: 6 }}>Saved automatically. This fills the activities column on your DTR.</div>
              </div>
            </div>
          </div>
        )}

        {/* ---------- DTR ---------- */}
        {view === "dtr" && me && (
          <>
            <div className="card noprint" style={{ marginBottom: 16 }}>
              <h2 className="sec">My DTR</h2>
              <p className="sub">
                {me.name || me.id}{me.position ? " — " + me.position : ""}. Times come from the punches recorded under ID {me.id}.
              </p>
              <div className="ctl">
                <div>
                  <span className="lbl">Payroll period</span>
                  <select value={perStart} onChange={(e) => setPerStart(e.target.value)}>
                    {periods.map((p) => <option key={iso(p.s)} value={iso(p.s)}>{periodLabel(p)}</option>)}
                  </select>
                </div>
                <div>
                  <span className="lbl">Project site</span>
                  <input value={site} onChange={(e) => setSite(e.target.value)} placeholder="Project site" />
                </div>
                {printHref
                  ? <a className="btn" href={printHref} download={dtrFileName()}>Print / Save PDF</a>
                  : <button className="btn" disabled style={{ opacity: 0.5 }}>Preparing PDF…</button>}
                <button className="btn ghost" onClick={doPrint}>Print from browser</button>
              </div>
              <p className="hint">
                <strong>Print / Save PDF</strong> downloads a real PDF, already laid out for A4 portrait — open it and print, or
                send it as-is. <strong>Print from browser</strong> is an alternative that may be blocked, since this page runs inside a
                restricted frame; the PDF download always works. Any cell below can be corrected before you export.
              </p>
            </div>

            <div className="sheetwrap">
              <div className="sheet shadow" ref={sheetRef}>
                <table className="hdr">
                  <tbody>
                    <tr>
                      <td className="logoc" rowSpan={3}>
                        {cfg.logo ? <img src={cfg.logo} alt="" /> : <span className="ph">{(cfg.co || "QM").slice(0, 2).toUpperCase()}</span>}
                      </td>
                      <td className="co" colSpan={2}>{cfg.co || DEF.co}</td>
                    </tr>
                    <tr><td className="lab" colSpan={2}><span className="k">Department:</span>{cfg.dept || DEF.dept}</td></tr>
                    <tr><td className="lab" colSpan={2}><span className="k">Form Title:</span>{cfg.title || DEF.title}</td></tr>
                  </tbody>
                </table>

                <table className="flds">
                  <tbody>
                    <tr>
                      <td className="fk">NAME OF EMPLOYEE</td><td className="fv"><span className="ul">{me.name || ""}</span></td>
                      <td className="gap" />
                      <td className="fk" style={{ width: "34mm" }}>PROJECT SITE</td><td className="fv"><span className="ul">{site}</span></td>
                    </tr>
                    <tr>
                      <td className="fk">POSITION</td><td className="fv"><span className="ul">{me.position || ""}</span></td>
                      <td className="gap" />
                      <td className="fk" style={{ width: "34mm" }}>PAYROLL PERIOD</td><td className="fv"><span className="ul">{periodLabel(period)}</span></td>
                    </tr>
                  </tbody>
                </table>

                <table className="dtr">
                  <colgroup>
                    <col style={{ width: "9.4%" }} />
                    <col style={{ width: "7.6%" }} /><col style={{ width: "7.6%" }} />
                    <col style={{ width: "7.6%" }} /><col style={{ width: "7.6%" }} />
                    <col style={{ width: "7.6%" }} /><col style={{ width: "7.6%" }} />
                    <col style={{ width: "6%" }} /><col style={{ width: "9%" }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th rowSpan={3}>DATE</th>
                      <th colSpan={4}>REGULAR DAY</th>
                      <th colSpan={2} rowSpan={2}>OVERTIME<br />REGULAR DAY</th>
                      <th colSpan={2}>TOTAL</th>
                      <th rowSpan={3}>DAILY WORK ACTIVITIES / ACCOMPLISHMENT</th>
                    </tr>
                    <tr>
                      <th colSpan={2}>AM</th><th colSpan={2}>PM</th>
                      <th rowSpan={2}>DAY</th><th rowSpan={2}>OVERTIME</th>
                    </tr>
                    <tr><th>IN</th><th>OUT</th><th>IN</th><th>OUT</th><th>IN</th><th>OUT</th></tr>
                  </thead>
                  <tbody>
                    {days.map((d) => {
                      const ds = iso(d);
                      const r = recFor(me.id, ds);
                      const dm = dayMinutes(r, sched), om = otMinutes(r);
                      dTot += dm; oTot += om;
                      return (
                        <tr key={ds}>
                          <td className="dt">
                            {MON[d.getMonth()].slice(0, 3)} {d.getDate()}
                            {d.getDay() === 0 && <span className="sund"> SUN</span>}
                          </td>
                          {r.leave ? (
                            <>
                              <td className="leave" colSpan={4}>ON LEAVE</td>
                              <td /><td />
                            </>
                          ) : SLOTS.map((s) => (
                            <td key={s.k}>
                              <input
                                key={ds + s.k + (r[s.k] || "")}
                                defaultValue={r[s.k] ? disp(r[s.k], true) : ""}
                                onBlur={(e) => {
                                  const reset = () => { e.target.value = r[s.k] ? disp(r[s.k], true) : ""; };
                                  const raw = e.target.value.trim();
                                  const t = raw ? parseTime(raw, s.mer) : "";
                                  if (t === null) { say("Could not read that time"); reset(); return; }
                                  if ((r[s.k] || "") === (t || "")) return;
                                  if (t) {
                                    const issue = orderIssue(r, s.k, t);
                                    if (issue) { say(issue); reset(); return; }
                                  }
                                  writeRec(me.id, ds, (rr) => { if (t) rr[s.k] = t; else delete rr[s.k]; });
                                }}
                              />
                            </td>
                          ))}
                          <td className="num">{dm ? fmtDay(dm, schedCap(sched)) : ""}</td>
                          <td className="num">{om ? fmtDur(om) : ""}</td>
                          <td className="actc">
                            <div
                              className="cell" contentEditable suppressContentEditableWarning
                              key={ds + "note" + (r.note || "")}
                              onBlur={(e) => {
                                const v = e.currentTarget.textContent.trim();
                                if (v === (r.note || "")) return;
                                writeRec(me.id, ds, (rr) => { rr.note = v; });
                              }}
                            >{r.note || ""}</div>
                          </td>
                        </tr>
                      );
                    })}
                    {Array.from({ length: Math.max(0, 21 - days.length) }).map((_, i) => (
                      <tr key={"pad" + i}>{Array.from({ length: 10 }).map((__, j) => <td key={j} />)}</tr>
                    ))}
                    <tr className="tot">
                      <td colSpan={6} />
                      <td>TOTAL</td>
                      <td>{fmtDay(dTot, schedCap(sched))}</td>
                      <td>{fmtDur(oTot)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>

                <table className="sig">
                  <tbody>
                    <tr>
                      <td className="ln">EMPLOYEE SIGNATURE</td><td className="sp" />
                      <td className="ln">SUPERVISOR / DEPT MANAGER</td><td className="sp" />
                      <td className="ln">GENERAL MANAGER</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ---------- SETTINGS ---------- */}
        {view === "settings" && !isAdmin && (
          <div className="card">
            <h2 className="sec">Settings locked</h2>
            <p className="sub">
              Only employees with the <strong>Admin</strong> role can change the form header, work schedule, and employee list.
              Sign in with an admin ID to make changes.
            </p>
            <button className="btn" onClick={() => { setMe(null); setView("lock"); }}>Go to sign in</button>
          </div>
        )}

        {view === "settings" && isAdmin && (
          <div className="card">
            <h2 className="sec">Settings</h2>
            <p className="sub">Form header and the people who punch on this system. Changes save as you type — there is no save button to miss.</p>

            <h3 className="s2 first">Form header</h3>
            <p className="hint" style={{ marginBottom: 16 }}>Appears at the top of every printed DTR.</p>
            <div className="logoRow">
              <div>
                <span className="lbl">Logo</span>
                <div className="logoPrev">
                  {cfg.logo ? <img src={cfg.logo} alt="Logo" /> : <span className="none">No logo</span>}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <label className="btn ghost sm" style={{ display: "inline-block" }}>
                    Upload<input type="file" accept="image/*" hidden onChange={onLogo} />
                  </label>
                  <button className="btn ghost sm" onClick={() => setCfg((p) => ({ ...p, logo: "" }))}>Remove</button>
                </div>
                <div className="hint" style={{ marginTop: 8, maxWidth: 190 }}>PNG or JPG, scaled to fit the form's logo box.</div>
              </div>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="grid3">
                  <div><span className="lbl">Company name</span>
                    <input value={cfg.co} placeholder={DEF.co} onChange={(e) => setCfg((p) => ({ ...p, co: e.target.value }))} /></div>
                  <div><span className="lbl">Department</span>
                    <input value={cfg.dept} placeholder={DEF.dept} onChange={(e) => setCfg((p) => ({ ...p, dept: e.target.value }))} /></div>
                  <div style={{ gridColumn: "1/-1" }}><span className="lbl">Form title</span>
                    <input value={cfg.title} placeholder={DEF.title} onChange={(e) => setCfg((p) => ({ ...p, title: e.target.value }))} /></div>
                </div>
                <div className={"saved" + (flash === "cfg" ? " on" : "")} style={{ marginTop: 12 }}>Saved</div>
              </div>
            </div>

            <h3 className="s2">Work schedule</h3>
            <p className="hint" style={{ marginBottom: 16 }}>
              Regular hours are counted only inside these two windows and cap at {fmtDur(schedCap(sched))} a day, so an early
              arrival or a late finish doesn't inflate the regular total — that time belongs in overtime.
            </p>
            <div className="grid3">
              {[
                ["amStart", "Morning in"],
                ["amEnd", "Out for lunch"],
                ["pmStart", "Back from lunch"],
                ["pmEnd", "Out for the day"],
              ].map(([k, label]) => (
                <div key={k}>
                  <span className="lbl">{label}</span>
                  <input
                    type="time" value={sched[k]}
                    onChange={(ev) => setCfg((p) => ({ ...p, sched: { ...(p.sched || SCHED_DEF), [k]: ev.target.value } }))}
                  />
                </div>
              ))}
            </div>
            <div className={"saved" + (flash === "cfg" ? " on" : "")} style={{ marginTop: 12 }}>Saved</div>

            <h3 className="s2">Employees</h3>
            <p className="hint" style={{ marginBottom: 16 }}>
              The ID number is what they type on the punch screen, so keep them unique. <strong>Admin</strong> can open this
              Settings tab; <strong>Viewer</strong> can only punch and print their own DTR. At least one admin is required.
            </p>
            <table className="roster">
              <thead>
                <tr>
                  <th style={{ width: "78px" }}>Photo</th>
                  <th style={{ width: "11%" }}>ID number</th>
                  <th style={{ width: "22%" }}>Name of employee</th>
                  <th style={{ width: "20%" }}>Position</th>
                  <th style={{ width: "20%" }}>Project site</th>
                  <th style={{ width: "12%" }}>Role</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {roster.map((e, i) => (
                  <tr key={i}>
                    <td>
                      <label className="photocell" title="Upload a photo">
                        {e.photo ? <img src={e.photo} alt="" /> : <span>Add</span>}
                        <input type="file" accept="image/*" hidden onChange={(ev) => onPhoto(i, ev)} />
                      </label>
                      {e.photo && (
                        <button className="photoclear" onClick={() => setRoster((p) => p.map((emp, j) => (j === i ? { ...emp, photo: "" } : emp)))}>
                          Remove photo
                        </button>
                      )}
                    </td>
                    <td><input value={e.id} inputMode="numeric" placeholder="1001" onChange={(ev) => setEmp(i, "id", ev.target.value)} /></td>
                    <td><input value={e.name} placeholder="Full name" onChange={(ev) => setEmp(i, "name", ev.target.value)} /></td>
                    <td><input value={e.position} placeholder="e.g. Systems Analyst" onChange={(ev) => setEmp(i, "position", ev.target.value)} /></td>
                    <td><input value={e.site} placeholder="e.g. Head Office" onChange={(ev) => setEmp(i, "site", ev.target.value)} /></td>
                    <td>
                      <select className="rolesel" value={e.role === "admin" ? "admin" : "viewer"} onChange={(ev) => setRole(i, ev.target.value)}>
                        <option value="viewer">Viewer</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td className="x"><button onClick={() => delEmp(i)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <button className="btn ghost" onClick={addEmp}>Add employee</button>
              <span className={"saved" + (flash === "roster" ? " on" : "")}>Saved</span>
            </div>
            <p className="hint" style={{ marginTop: 16 }}>Everything here is shared by everyone who opens this page.</p>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="box">
            <h3>{editing.value ? "Correct" : "Set"} {editing.slot.label}</h3>
            <p>Type it like 8:05 or 5:10 PM.</p>
            <input
              autoFocus defaultValue={editing.value}
              onKeyDown={(e) => { if (e.key === "Enter") applyEdit(e.currentTarget.value, false); if (e.key === "Escape") setEditing(null); }}
              id="qm-edit-input"
            />
            <div className="row">
              <button className="del" onClick={() => applyEdit("", true)}>Clear</button>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button className="pri" onClick={() => applyEdit(document.getElementById("qm-edit-input").value, false)}>Save</button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="modal" onClick={(e) => { if (e.target === e.currentTarget) setConfirm(null); }}>
          <div className="box">
            <h3>{confirm.title}</h3>
            <p style={{ marginBottom: 0 }}>{confirm.body}</p>
            <div className="row">
              <button onClick={() => setConfirm(null)}>Cancel</button>
              <button className="pri" onClick={confirm.onYes}>{confirm.yes || "Confirm"}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
