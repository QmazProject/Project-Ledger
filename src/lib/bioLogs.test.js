/* Bio logs: reading a device export, placing taps into the DTR's boxes, and taking
   them into a day. Fixtures are made-up IDs and times shaped like the device's .dat
   export — never a real employee's log. */

import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  rowsFromText, rowsFromWorkbook, readBioRows, normalizeBioId, bioIdClashes, tapsForEmployee,
  placeTaps, compareSlots, replaceableSlots, bioCoverage, coverageMessage, applyBioTimes,
  bioApplyIssue, tapsToKeep, bioDownloadText, deviceSerialOf, fileRange,
} from "./bioLogs.js";

const SCHED = { amStart: "08:00", amEnd: "12:00", pmStart: "13:00", pmEnd: "17:00" };
const SEP = { start: "2026-09-13", end: "2026-09-27" };

/* one device line: ID, M/D/YYYY H:MM, then verify, state, work code, reserved */
const line = (id, date, time, state) => {
  const [y, m, d] = date.split("-").map(Number);
  return `${id}\t${m}/${d}/${y} ${time}\t1\t${state}\t1\t0`;
};
const dat = (...lines) => lines.join("\r\n") + "\r\n";
const read = (text) => readBioRows(rowsFromText(text));
const placed = (text, id = "1234", period = SEP) => placeTaps(tapsForEmployee(read(text).taps, id), SCHED, period).days;

test("the device's .dat export reads into taps, copies and all", () => {
  const r = read(dat(
    line("1234", "2026-09-15", "7:51", 0),
    line("1234", "2026-09-15", "7:51", 0),
    line("1234", "2026-09-15", "12:09", 1),
    line("4321", "2026-09-15", "20:01", 5),
    line("101010", "2026-09-15", "13:46", "0\t3"),
  ));
  assert.equal(r.error, "");
  assert.equal(r.taps.length, 5);
  assert.deepEqual(r.taps[0], {
    id: "1234", rawId: "1234", date: "2026-09-15", time: "07:51", kind: "in", code: "0",
    raw: "1234\t9/15/2026 7:51\t1\t0\t1\t0",
  });
  assert.deepEqual(r.taps.map((t) => t.kind), ["in", "in", "out", "otOut", "in"]);
});

test("every state code the device writes has a meaning", () => {
  const kinds = [0, 1, 2, 3, 4, 5].map((s) => read(line("1", "2026-09-15", "9:00", s)).taps[0].kind);
  assert.deepEqual(kinds, ["in", "out", "out", "in", "otIn", "otOut"]);
  assert.equal(read(line("1", "2026-09-15", "9:00", 7)).error, "not-bio", "an unknown state is not guessed");
});

test("headers, titles and blank lines are skipped; a file with no taps is refused", () => {
  const r = read("Attendance export\r\n\r\nID\tTime\tVerify\tState\r\n" + line("1234", "2026-09-15", "7:51", 0));
  assert.equal(r.taps.length, 1);
  assert.equal(r.skipped, 2);
  assert.equal(read("name,amount\r\nrice,12\r\n").error, "not-bio");
  assert.equal(read("").error, "not-bio");
});

test("comma, space-separated and spelled-out exports read the same", () => {
  assert.deepEqual(read("1234,9/15/2026 7:51,1,0,1,0").taps.map((t) => [t.time, t.kind]), [["07:51", "in"]]);
  assert.deepEqual(read("1234 9/15/2026 5:10 PM 1 1 1 0").taps.map((t) => [t.time, t.kind]), [["17:10", "out"]]);
  const words = read("1234\tJuan\t2026-09-15 07:51:00\tC/In\r\n1234\tJuan\t2026-09-15 20:01:00\tOverTime Out");
  assert.deepEqual(words.taps.map((t) => [t.date, t.time, t.kind]), [["2026-09-15", "07:51", "in"], ["2026-09-15", "20:01", "otOut"]]);
});

test("dates are month-first like the device, day-first only when they must be, never mixed", () => {
  assert.equal(read(line("1", "2026-09-05", "8:00", 0)).taps[0].date, "2026-09-05", "5 Sep, read month-first");
  const dayFirst = read("1\t28/8/2026 8:00\t1\t0\t1\t0\r\n1\t5/9/2026 8:00\t1\t0\t1\t0");
  assert.equal(dayFirst.dateOrder, "day-first");
  assert.deepEqual(dayFirst.taps.map((t) => t.date), ["2026-08-28", "2026-09-05"]);
  assert.equal(read("1\t28/8/2026 8:00\t1\t0\t1\t0\r\n1\t8/28/2026 8:00\t1\t0\t1\t0").error, "mixed-dates");
  assert.equal(read("1\t2/30/2026 8:00\t1\t0\t1\t0").error, "not-bio", "an impossible date is skipped");
});

test("an Excel export reads like the text one, whatever its sheets are called", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Report"], []]), "Cover");
  const ws = XLSX.utils.aoa_to_sheet([
    ["AC-No.", "Time", "Verify", "State", "Code", "Res"],
    [1234, new Date(2026, 8, 15, 7, 51), 1, 0, 1, 0],
    ["01234", "9/15/2026 17:10", 1, 1, 1, 0],
  ], { cellDates: true });
  XLSX.utils.book_append_sheet(wb, ws, "Logs 2");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const r = readBioRows(rowsFromWorkbook(XLSX, buf));
  assert.deepEqual(r.taps.map((t) => [t.id, t.date, t.time, t.kind]),
    [["1234", "2026-09-15", "07:51", "in"], ["1234", "2026-09-15", "17:10", "out"]]);
});

test("IDs match without leading zeros, and a clash is found rather than guessed", () => {
  assert.equal(normalizeBioId("006571"), "6571");
  assert.equal(normalizeBioId(" 0 "), "0");
  assert.equal(normalizeBioId("A-01"), "A-01");
  const taps = read(dat(line("6571", "2026-09-15", "7:51", 0), line("6572", "2026-09-15", "7:52", 0))).taps;
  assert.deepEqual(tapsForEmployee(taps, "006571").map((t) => t.rawId), ["6571"]);
  const roster = [{ id: "006571" }, { id: "6571" }, { id: "006572" }];
  assert.deepEqual(bioIdClashes(roster, "006571").map((e) => e.id), ["6571"]);
});

test("a normal day fills the four regular boxes in order", () => {
  const d = placed(dat(
    line("1234", "2026-09-15", "7:51", 0), line("1234", "2026-09-15", "12:09", 1),
    line("1234", "2026-09-15", "12:10", 0), line("1234", "2026-09-15", "17:10", 1),
  ))["2026-09-15"];
  assert.deepEqual(d.slots, { amIn: "07:51", amOut: "12:09", pmIn: "12:10", pmOut: "17:10" });
  assert.deepEqual(d.notes, []);
});

test("short days are placed by the time of day, not just by order", () => {
  const two = placed(dat(line("1234", "2026-09-15", "7:51", 0), line("1234", "2026-09-15", "17:10", 1)))["2026-09-15"];
  assert.deepEqual(two.slots, { amIn: "07:51", pmOut: "17:10" });
  const early = placed(dat(line("1234", "2026-09-15", "8:00", 0), line("1234", "2026-09-15", "8:08", 1)))["2026-09-15"];
  assert.deepEqual(early.slots, { amIn: "08:00", amOut: "08:08" });
  assert.deepEqual(placed(line("1234", "2026-09-15", "13:05", 0))["2026-09-15"].slots, { pmIn: "13:05" });
  assert.deepEqual(placed(line("1234", "2026-09-15", "17:05", 1))["2026-09-15"].slots, { pmOut: "17:05" });
  assert.deepEqual(placed(line("1234", "2026-09-15", "3:50", 0))["2026-09-15"].slots, { amIn: "03:50" }, "an early In stays on its day");
});

test("overtime: OT out is taken, OT in is never invented", () => {
  const d = placed(dat(line("1234", "2026-09-15", "7:38", 0), line("1234", "2026-09-15", "20:01", 5)))["2026-09-15"];
  assert.deepEqual(d.slots, { amIn: "07:38", otOut: "20:01" });
  assert.deepEqual(d.notes, ["No OT in on the bio log. Type your OT in yourself."]);
  const late = placed(dat(
    line("1234", "2026-09-15", "8:07", 0), line("1234", "2026-09-15", "17:15", 1),
    line("1234", "2026-09-15", "18:00", 0), line("1234", "2026-09-15", "21:10", 1),
  ))["2026-09-15"];
  assert.deepEqual(late.slots, { amIn: "08:07", pmOut: "17:15", otIn: "18:00", otOut: "21:10" }, "an In after PM out is OT in");
});

test("a check out is never OT out: a second Out replaces the PM out, and the first is noted", () => {
  const d = placed(dat(
    line("1234", "2026-09-15", "8:07", 0), line("1234", "2026-09-15", "17:15", 1), line("1234", "2026-09-15", "18:10", 1),
  ))["2026-09-15"];
  assert.deepEqual(d.slots, { amIn: "08:07", pmOut: "18:10" });
  assert.deepEqual(d.notes, ["earlier Out 5:15 PM; the last Out is the PM out"]);
});

test("someone who only taps In and Out gets AM out at lunch and PM out at night, whatever the schedule", () => {
  // the pattern from a real cut-off: lunch a little after noon, one check out at night
  const taps = dat(
    line("1234", "2026-09-28", "7:53", 0), line("1234", "2026-09-28", "12:06", 1),
    line("1234", "2026-09-28", "12:18", 0), line("1234", "2026-09-28", "22:04", 1), line("1234", "2026-09-28", "22:04", 1),
  );
  const now = { start: "2026-09-28", end: "2026-10-12" };
  const want = { amIn: "07:53", amOut: "12:06", pmIn: "12:18", pmOut: "22:04" };
  assert.deepEqual(placed(taps, "1234", now)["2026-09-28"].slots, want);
  const noonPm = { ...SCHED, pmStart: "12:00" };
  const d = placeTaps(tapsForEmployee(read(taps).taps, "1234"), noonPm, now).days["2026-09-28"];
  assert.deepEqual(d.slots, want, "a PM start at noon doesn't turn lunch into PM out");
  // a double-tapped lunch Out is still lunch
  const twice = placeTaps(tapsForEmployee(read(dat(
    line("1234", "2026-09-28", "7:53", 0), line("1234", "2026-09-28", "12:06", 1), line("1234", "2026-09-28", "12:07", 1),
    line("1234", "2026-09-28", "12:18", 0), line("1234", "2026-09-28", "17:03", 1),
  )).taps, "1234"), noonPm, now).days["2026-09-28"];
  assert.deepEqual(twice.slots, { amIn: "07:53", amOut: "12:07", pmIn: "12:18", pmOut: "17:03" });
  // leaving early and coming back only after hours is not lunch: that In starts overtime
  const back = placed(dat(
    line("1234", "2026-09-28", "7:53", 0), line("1234", "2026-09-28", "16:30", 1),
    line("1234", "2026-09-28", "18:00", 0), line("1234", "2026-09-28", "21:00", 1),
  ), "1234", now)["2026-09-28"];
  assert.deepEqual(back.slots, { amIn: "07:53", pmOut: "16:30", otIn: "18:00", otOut: "21:00" });
});

test("after midnight: an OT out closes the previous day as OT out, an Out as a PM out that can't be taken", () => {
  const days = placed(dat(
    line("1234", "2026-09-15", "7:33", 0),
    line("1234", "2026-09-16", "2:08", 5),
    line("1234", "2026-09-16", "7:41", 0), line("1234", "2026-09-16", "12:04", 1), line("1234", "2026-09-16", "12:20", 0),
    line("1234", "2026-09-17", "0:03", 1), line("1234", "2026-09-17", "0:03", 1),
  ));
  assert.equal(days["2026-09-15"].slots.otOut, "02:08");
  assert.ok(days["2026-09-15"].notes.includes("OT out tapped after midnight (Sep 16, 2:08 AM)"));
  assert.deepEqual(days["2026-09-15"].pastMidnight, [], "OT out may run past midnight");
  const d = days["2026-09-16"];
  assert.deepEqual(d.slots, { amIn: "07:41", amOut: "12:04", pmIn: "12:20", pmOut: "00:03" });
  assert.deepEqual(d.pastMidnight, ["pmOut"]);
  assert.deepEqual(d.notes, ["Out tapped after midnight (Sep 17, 12:03 AM). Only OT out can go past midnight in the DTR — type your OT in and OT out yourself."]);
  assert.equal(days["2026-09-17"], undefined);
  // shown against the DTR, but never offered: the DTR can't keep a PM out past midnight
  const status = compareSlots({ amIn: "07:41", amOut: "12:04", pmIn: "12:30", pmOut: "17:00", otIn: "18:00", otOut: "00:03" }, d.slots);
  assert.equal(status.pmOut, "diff");
  assert.deepEqual(replaceableSlots(status, d), ["pmIn"]);
  // an Out early in the morning after that morning's In stays on its own day
  assert.deepEqual(placed(dat(line("1234", "2026-09-15", "7:30", 0), line("1234", "2026-09-15", "7:58", 1)))["2026-09-15"].slots,
    { amIn: "07:30", amOut: "07:58" });
});

test("double taps: the later one wins and both show; further taps are noted, never dropped", () => {
  const d = placed(dat(
    line("1234", "2026-09-15", "7:40", 0), line("1234", "2026-09-15", "7:42", 0),
    line("1234", "2026-09-15", "17:10", 1), line("1234", "2026-09-15", "17:12", 1),
  ))["2026-09-15"];
  assert.deepEqual(d.slots, { amIn: "07:42", pmOut: "17:12" }, "a second Out within 5 minutes is not OT");
  assert.deepEqual(d.notes, ["double tap 7:40 AM / 7:42 AM", "double tap 5:10 PM / 5:12 PM"]);
  const extra = placed(dat(line("1234", "2026-09-15", "7:40", 0), line("1234", "2026-09-15", "7:50", 0)))["2026-09-15"];
  assert.deepEqual(extra.slots, { amIn: "07:40" });
  assert.deepEqual(extra.notes, ["extra tap 7:50 AM (In)"]);
});

test("copies of a tap count once, and OT out beats Out at the same minute", () => {
  const d = placed(dat(
    line("1234", "2026-09-15", "7:51", 0), line("1234", "2026-09-15", "7:51", 0), line("1234", "2026-09-15", "7:51", 0),
    line("1234", "2026-09-15", "23:06", 1), line("1234", "2026-09-15", "23:06", 5),
  ))["2026-09-15"];
  assert.deepEqual(d.slots, { amIn: "07:51", otOut: "23:06" });
  assert.equal(d.notes.filter((n) => n.startsWith("double") || n.startsWith("extra")).length, 0);
});

test("a tap on the first morning that closes the day before is kept out of the period", () => {
  const taps = tapsForEmployee(read(dat(line("1234", "2026-09-13", "1:30", 5), line("1234", "2026-09-13", "7:55", 0))).taps, "1234");
  const res = placeTaps(taps, SCHED, SEP);
  assert.deepEqual(res.days["2026-09-13"].slots, { amIn: "07:55" });
  assert.deepEqual(res.beforePeriod.map((t) => t.time), ["01:30"]);
});

test("each box compares as match, different, bio only or DTR only", () => {
  const status = compareSlots(
    { amIn: "08:00", amOut: "12:05", pmOut: "17:00", otIn: "18:00" },
    { amIn: "07:51", amOut: "12:05", pmIn: "12:31", pmOut: "17:10" },
  );
  assert.deepEqual(status, { amIn: "diff", amOut: "match", pmIn: "bioOnly", pmOut: "diff", otIn: "dtrOnly", otOut: "" });
  assert.deepEqual(replaceableSlots(status), ["amIn", "pmIn", "pmOut"]);
});

test("coverage says what the file reaches, in plain words", () => {
  const all = read(dat(line("9", "2026-08-28", "8:00", 0), line("1234", "2026-09-20", "8:00", 0), line("9", "2026-09-28", "8:00", 0))).taps;
  const mine = tapsForEmployee(all, "001234");
  assert.deepEqual(fileRange(all), { first: "2026-08-28", last: "2026-09-28" });
  assert.equal(bioCoverage(all, mine, SEP).state, "full");
  assert.equal(coverageMessage(bioCoverage(all, mine, SEP), SEP, "001234"), "This file covers all of Sep 13 – Sep 27.");
  const now = { start: "2026-09-28", end: "2026-10-12" };
  assert.equal(coverageMessage(bioCoverage(all, mine, now), now, "001234"),
    "This file covers Aug 28 – Sep 28. Sep 29 – Oct 12 have no bio logs.");
  const later = { start: "2026-10-13", end: "2026-10-27" };
  assert.equal(coverageMessage(bioCoverage(all, mine, later), later, "001234"),
    "This file covers Aug 28 – Sep 28. It doesn't cover Oct 13 – Oct 27.");
  assert.equal(coverageMessage(bioCoverage(all, [], SEP), SEP, "005555"), "No bio logs for ID 005555 in this file.");
  assert.equal(coverageMessage(bioCoverage([], [], SEP), SEP, "001234"), "This file doesn't look like a ZKTeco bio log.");
});

test("taking bio times keeps what they replaced, and the first typed value stays on record", () => {
  const day = { amIn: "08:00", pmOut: "17:00", src: { amIn: "manual", pmOut: "manual" }, note: "Formworks" };
  const bio = { amIn: "07:51", pmIn: "12:31", pmOut: "17:10" };
  assert.deepEqual(applyBioTimes(day, bio, ["amIn", "pmIn"]), ["amIn", "pmIn"]);
  assert.deepEqual([day.amIn, day.pmIn, day.pmOut], ["07:51", "12:31", "17:00"], "only the chosen boxes");
  assert.deepEqual(day.bioWas, { amIn: "08:00" }, "an empty box leaves no 'was'");
  day.src.amIn = "bio";
  applyBioTimes(day, { amIn: "07:49" }, ["amIn"]);
  assert.deepEqual(day.bioWas, { amIn: "08:00" }, "bio over bio keeps the typed value");
  assert.deepEqual(applyBioTimes(day, { amIn: "07:49" }, ["amIn", "otIn"]), [], "nothing left to change");
});

test("bio times are refused on leave, out of order, or for a PM out with no accomplishment", () => {
  const bio = { amIn: "07:51", pmOut: "17:10" };
  assert.match(bioApplyIssue({ leave: true }, bio, ["amIn"], SCHED, ""), /marked leave/);
  assert.match(bioApplyIssue({ holiday: true }, bio, ["amIn"], SCHED, ""), /marked holiday/);
  assert.match(bioApplyIssue({ amOut: "07:30" }, bio, ["amIn"], SCHED, ""), /AM in can.t be later than AM out/);
  assert.equal(bioApplyIssue({}, bio, ["pmOut"], SCHED, ""), "Write your accomplishment first");
  assert.equal(bioApplyIssue({ note: "Formworks" }, bio, ["pmOut"], SCHED, ""), null);
  assert.equal(bioApplyIssue({}, bio, ["pmOut"], SCHED, "typing it now"), null);
  assert.equal(bioApplyIssue({}, bio, ["amIn"], SCHED, ""), null, "AM in needs no accomplishment");
  assert.equal(bioApplyIssue({ amIn: "07:51" }, bio, ["amIn"], SCHED, ""), "Nothing to change on this day.");
});

test("a saved upload keeps the period's taps and the next morning's overnight OT out", () => {
  const taps = read(dat(
    line("1234", "2026-09-12", "8:00", 0),
    line("1234", "2026-09-20", "8:00", 0),
    line("1234", "2026-09-28", "1:15", 5),
    line("1234", "2026-09-28", "7:55", 0),
  )).taps;
  assert.deepEqual(tapsToKeep(taps, SEP, SCHED).map((t) => `${t.date} ${t.time}`), ["2026-09-20 08:00", "2026-09-28 01:15"]);
});

test("a download is the device's own layout and reads back the same", () => {
  const text = dat(line("1234", "2026-09-15", "17:10", 1), line("1234", "2026-09-15", "7:51", 0));
  const taps = read(text).taps;
  const out = bioDownloadText(taps);
  assert.equal(out, dat(line("1234", "2026-09-15", "7:51", 0), line("1234", "2026-09-15", "17:10", 1)));
  assert.deepEqual(read(out).taps.map((t) => [t.time, t.kind]), [["07:51", "in"], ["17:10", "out"]]);
  // a tap read from Excel has no device line: one is written in the device's layout
  const synth = bioDownloadText([{ id: "1234", rawId: "01234", date: "2026-09-15", time: "20:01", kind: "otOut", code: "OverTime Out" }]);
  assert.equal(synth, "01234\t9/15/2026 20:01\t1\t5\t1\t0\r\n");
});

test("the device serial comes from the export's file name", () => {
  assert.equal(deviceSerialOf("A3B7233860061_attlogs.dat"), "A3B7233860061");
  assert.equal(deviceSerialOf("september logs.xlsx"), "");
});
