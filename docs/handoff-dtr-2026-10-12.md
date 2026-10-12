# DTR System — session handoff (2026-10-12)

Paste this into a new session, or say: **"read docs/handoff-dtr-2026-10-12.md first"**.
It records what was changed and decided in the session that built the PM-out
accomplishment rule, the Staff Logbook page-range print, and **Upload Bio Logs**.
The code is the source of truth; if this file and the code disagree, trust the code.

---

## 0. Read first

- `CLAUDE.md` (CodeLedger protocol + data-safety rules) and **`docs/data-safety.md`** —
  mandatory before touching anything that writes DTR records. One row in
  `public.dtr_storage_dtr` holds an employee's **whole year**; a bad write destroys it.
- The `codeledger` CLI is **not installed** on this machine, so the CodeLedger steps in
  CLAUDE.md can't run. Inspect the code directly and say so.

## 1. How the user works (please follow)

- **The user commits and pushes manually. Never commit or push.**
- Explain things **in plain English, "like I'm five"**, short and concrete, with
  examples from their own data.
- For a new feature: restate the request clearly, list questions / suggestions /
  fail points, and **wait for approval before coding**.
- The app is in production (Vercel + Supabase). Never run destructive tests against
  the real Supabase (`.env.local` holds live keys).

## 2. Commit status

- Commit `24135fe` ("new featured push") already holds: PM-out rule, `npm test` fix,
  logbook page-range print, the whole Upload Bio Logs feature, the migration and its
  verification SQL, `.gitignore` entry, `docs/data-safety.md` bio section.
- **Not committed yet** (made after that push):
  - `src/lib/bioLogs.js`, `src/lib/bioLogs.test.js` — check-out mapping fix (§6)
  - `DTR System/dtr-system.jsx` — mapping fix hook-up + Hide bio / Preview with bio (§7)
  - `docs/handoff-dtr-2026-10-12.md` — this file
- Migration `supabase/migrations/20261012000000_dtr_bio_logs.sql`: **user pushed it**.
- Verification `supabase/verification/20261012_dtr_bio_logs_verification.sql`: run it in
  Supabase → SQL Editor (safe: acts as `anon`, uses employee `TEST-BIO`, rolls back).
  **Not confirmed in the session that it was run / passed** — ask.

## 3. PM out needs today's accomplishment (every path)

- Rule: a **PM out** can't be saved unless that date has an accomplishment (saved, or
  being typed on the Punch screen). Clearing a PM out needs nothing.
- Helper: `pmOutNeedsAccomplishment(key, t, rec, typedNote)` in `src/lib/dtrTime.js`.
- Enforced on: Punch button, Punch manual dialog, **My DTR grid** (onBlur →
  "Write your accomplishment first"), **Staff Logbook** `setLogTime` ("Write your
  accomplishment in Punch or My DTR first"), and bio "Use" (`bioApplyIssue`).
- The original bug: the toast was hidden behind the manual dialog. Fixed with
  `.qm .toast{z-index:80;pointer-events:none}`.
- **Open question never answered:** the Punch screen still also asks for the
  accomplishment on **OT out** (old behaviour). User said "PM out only". Ask whether
  to remove it from OT out.

## 4. Smaller fixes

- `npm test` = `node --test "src/lib/*.test.js"` (the old `node --test src/lib/`
  fails on Node 22). `docs/data-safety.md` §3 still mentions the old command (stale).
- `stampSources(day, before, source)` (in `dtrTime.js`) marks how each time got there:
  `day.src[slot]` = `"punch" | "manual" | "edited" | "bio"`. `writeRecLocked` now
  re-stamps after the conflict retry too (labels were lost on retry before).

## 5. Staff Logbook → Print logbook: choose pages

- Dialog "Pages": **Filled pages only** (default; only pages with employees) or
  **Page range** From/To (default 1–5). In a range, pages with no employees print
  **empty, like the blank sheet**; capped at `BLANK_MAX_SHEETS` per batch.
- Helpers in `src/lib/logbookGroups.js`: `pageRangeOf(from, to, max)` →
  `{from, to, asked}`, `pagesInRange(pages, from, to)` → `[{no, staff}]`.
- State in the jsx: `logbookPrintMode` ("filled" | "range"), `logbookFrom/To`,
  `logbookRange`, `logbookFilledCount`, `printLogbookNow`.
- Printed logbook: typed/edited times *italic* (old bug fixed), **bio times underlined**.

## 6. Upload Bio Logs (My DTR tab) — the big feature

### What the employee sees
- **Upload Bio Logs** button → pop-up names the present payroll cut-off (and the one
  being viewed if different). File name / sheet name don't matter.
- Accepts the **ZKTeco `.dat`** export (what IT gives — primary) and Excel
  (`.xlsx/.xls`, common layouts; `xlsx` package loaded on demand).
- Keeps **only the signed-in employee's taps**; IDs compared without leading zeros
  (`006571` = `6571`). Two roster IDs that collide → refused, fix IDs first.
- A **BIO** line under each date of the cut-off, colour-coded per box:
  green **match**, red **different**, yellow **only on bio**, grey **only on DTR**.
- Per day: **Use day**, tick boxes + **Use ticked**, **Keep** (and Undo).
  Bar: **Use bio logs for all N mismatched days** (confirm lists every change and
  every skipped day first), Save, History (N), Clear.
- Coverage message when the file doesn't (fully) cover the cut-off.
- **Admin viewing someone's DTR = compare only** (no ticks/buttons/save).
- Leave / holiday day: shows the mismatch, can't replace.
- Taps on a hidden Sunday → note in the bar. Early taps on the first morning that
  close the day before the cut-off → note, not used.
- The comparison is **screen only** (`.noprint`): never on the printed sheet or PDF.

### Saving (Supabase table `public.dtr_bio_logs`)
- One row = one employee's taps for **one payroll period** (plus next-morning outs of
  the last day). The device file itself is never stored.
- Re-upload allowed → newest row is compared; older rows are **History** with
  **Preview** and **Download** (`.dat` in device layout, `<id>_bio_<start>_<end>_<stamp>.dat`).
- **Clear** marks the newest row cleared (server time); no delete, ever. DTR times
  don't change on Clear.
- **Append-only by the database**: trigger `dtr_bio_logs_clear_only` + RLS + grants
  (select/insert; update only the cleared_* columns). Store: `src/lib/bioLogStore.js`.
- Before any **Use**, an unsaved upload is **auto-saved**; if that save fails, no time
  changes. No cloud configured at all (local dev) → Use works on the device copy and
  Save says it needs the cloud. Table missing → "Bio log saving isn't set up yet.
  Run the dtr_bio_logs migration on Supabase."

### Marks after "Use"
- Box marked `src = "bio"`; the replaced typed value kept in `day.bioWas[slot]`.
- My DTR box shows a small "was 8:00 AM" / "from bio" under the time (screen only).
- Staff Logbook shows bio times **underlined** (screen and print).
- Every Use goes through `ensureLog` → `bioApplyIssue` (leave/holiday, nothing to
  change, time order, PM-out accomplishment) → `writeRec(..., "bio")` (revision-checked).

### Placement rules (`placeTaps` / `placeDay` in `src/lib/bioLogs.js`)
- Device codes: **0 In, 1 Out, 2 break out, 3 break in, 4 OT in, 5 OT out**.
- Same minute repeated = one tap; an OT tap beats a plain one at the same minute.
- **In** → AM in; PM in after the AM out (or from noon); OT in after the PM out (or
  from PM end).
- **Out (code 1) = PM out** (fixed after the push, §6a). It is AM out only as the
  lunch break; OT out only when an In after the PM out (or an OT in) started overtime.
  Several Outs → the **last** one is the PM out, earlier one noted.
- **Code 5 → OT out**, code 4 → OT in. **OT in is never invented**; note says "No OT in
  on the bio log. Type your OT in yourself."
- **Double tap** (same kind ≤ 5 min) → later wins, small trail note. Further taps noted.
- An Out / OT out between midnight and the AM start with no In before it that morning
  belongs to the **previous day**.
- Employee's typed value counts until they choose bio.
- Dates: read month/day like the device; a file that is clearly day/month switches;
  a file mixing both is refused.

### 6a. Fix after the push: check-out went to OT out
- Reported with employee **006178**: check-outs after midnight (Sep 30 12:03 AM,
  Oct 2 2:03 AM) landed in **OT out**; a schedule with PM start at noon could also turn
  lunch into PM out and push the night Out into OT out.
- Now: code 1 is always PM out (lunch = AM out). Applies to **all employees**, every
  upload; saved uploads are re-placed on display (no re-upload needed).
- Limit: the DTR only lets **OT out** pass midnight (`orderIssue` in `dtrTime.js`), so
  an after-midnight check-out shows in **PM out, red, with no tick** (`pastMidnight`
  on the placed day; `replaceableSlots(status, placed)` leaves it out) and a note
  telling them to type OT in / OT out. Tooltip: "(after midnight — can't be used)".
- **Kept exception (ask if unsure):** Out 5:00 PM → In 6:00 PM → Out 10:00 PM gives
  OT in 6:00 PM / OT out 10:00 PM. User may prefer only codes 4/5 to fill OT boxes.
- Company DTR habit seen in 006178's PDF: PM out typed 5:00 PM, OT in 6:00 PM, OT out =
  real check-out. So on OT days the bio PM out shows red and the employee should **Keep**.

## 7. Hide bio / Preview with bio (My DTR) — not committed yet

- Button next to **Upload Bio Logs**, shown only when something bio is on screen
  (an active upload, or a time already taken from bio).
- **Hide bio**: hides the BIO lines and the "was / from bio" marks; the bar shrinks to
  "Bio logs hidden — file, saved/not saved … Nothing was cleared or changed." with
  **Save** (for an unsaved upload) and **Preview with bio**.
- Screen only, writes nothing. Remembered **per employee on that device**:
  `localStorage["dtr-bio-hidden"]` = JSON array of employee IDs.
- Code: `bioHiddenIds`, `bioHidden`, `showBio(show)`, `bioMarkDays` / `bioMarksHere`.

## 8. Where things are

| What | Where |
|---|---|
| Whole DTR UI | `DTR System/dtr-system.jsx` (single file) |
| Bio state / derived | search `---- bio logs` (state) and `bio logs: the comparison under each date` |
| Bio handlers | `bioUpload`, `bioSaveDraft`, `onBioSave`, `onBioClear`, `bioUseDays`, `onBioUseAll`, `bioDownload`, `renderBioRow`, `bioCompareDay`, `showBio` |
| Parsing / placing / comparing | `src/lib/bioLogs.js` (+ `bioLogs.test.js`) |
| Bio store (Supabase) | `src/lib/bioLogStore.js` (+ test) |
| Time rules, marks, PM-out rule | `src/lib/dtrTime.js` (+ test) |
| Logbook pages | `src/lib/logbookGroups.js` (+ test) |
| Bio table | `supabase/migrations/20261012000000_dtr_bio_logs.sql` |
| Bio table check | `supabase/verification/20261012_dtr_bio_logs_verification.sql` |
| Safety write-up | `docs/data-safety.md` → "Bio logs — a suggestion until the employee takes it" |
| Sample data (real, **gitignored**) | `DTR System/bio logs sample/` — `A3B7233860061_attlogs.dat` (30 employees; codes 0/1/5 only, 13 people used code 5, nobody code 4) and 006178's DTR PDF |

## 9. How it was verified (redo after changes)

- `npm test` → **302 pass**.
- Lint: `npx eslint .` → **39 problems, all pre-existing** (38 in `dtr-system.jsx`,
  1 in `bioLogs.js` line 68). Compare with the committed file:
  `git show "HEAD:DTR System/dtr-system.jsx" | npx eslint --stdin --stdin-filename "DTR System/dtr-system.jsx"`.
- Build: `npx vite build --outDir <temp folder>` (xlsx is its own chunk).
- Browser tests (the scripts lived in the old session's temp folder and are **gone**;
  rebuild if needed): `playwright-core` driving installed **Edge headless**
  (`channel: "msedge"`), Vite `createServer` with an **empty `envDir`** so no Supabase
  keys load (local-only); a fake Supabase module aliased in for the bio store.
  Open the page at its address (`/dtr/my-dtr`, …, see §11) and seed `sessionStorage`
  `dtr.session.employee=<id>`; `localStorage`: `dtr.local.dtr:roster`,
  `dtr.local.dtr:log:<id>:<year>`. Useful selectors: period
  `select[title="● marks a period with entries"]`, file input `.modal input.biofile`,
  rows `tr.biorow`, marks `.sheet .biowas`.
- Last results: bio 46/46 (fake cloud), check-out mapping 8/8, Hide bio 14/14,
  no-cloud 3/3, PM-out paths, logbook print — all passed.

## 10. Open items / known limits

1. Commit the uncommitted files (§2) — user does it.
2. Confirm the verification SQL was run and passed.
3. Ask: remove the accomplishment requirement from **OT out** on Punch?
4. Ask: keep the "In after PM out → OT in / OT out" exception?
5. `docs/data-safety.md` §3 still says `node --test src/lib/` (stale wording).
6. My DTR is 6px wider than a 390px phone even with no bio (pre-existing, sheet area).
7. Bio rows are readable with the app's public key (same login-free model as the
   other DTR tables) — that's why a row holds only one person's taps for one period.

## 11. Web addresses for the DTR pages (added later the same day, not committed)

- Every page has its own address: `/dtr/sign-in`, `/dtr/punch`, `/dtr/my-dtr`,
  `/dtr/their-dtr` (admin reading someone), `/dtr/logbook`, `/dtr/settings`. `/` stays
  Project Ledger (`/login`, `/project-ledger`, `/reset-password`). `vercel.json` already
  rewrites every path to `index.html`.
- Rules in `src/lib/dtrRoutes.js` (+ test): `dtrScreenFor(route, {signedIn, viewOnly,
  isAdmin})` — signed out → always sign-in (Settings only while nobody is set up);
  signed in → sign-in / unknown → Punch; viewing someone → their DTR / logbook / Settings.
- `App.jsx`: the address decides DTR vs ledger (the old `forlive.workspace` key is gone);
  popstate opens/closes the DTR. Double-tap / Ctrl+D pushes `/dtr`.
- `dtr-system.jsx`: tab click = `pushState`, sign in / sign out = `replaceState`; popstate
  re-checks the page; Back with a pop-up open closes it (Cancel) and stays, except a busy
  bio upload. Tab title per page. `dtr.session.view` is gone; `dtr.session.employee` now
  holds the **admin** while they view someone (fixes: refresh used to sign the admin in
  as that employee with full rights).
- Verified: `npm test` 311 pass; Edge headless 42/42 (local-only, empty `envDir`).

## 12. Sign-in page polish (same day, not committed)

- Card header "QM BUILDERS DTR RECORD" + "Version 1" tag (`.lockHead`, fixed text — bump
  the version by hand); footer "© Digitalization Team 2026" (`.lockFoot`).
- Recognised ID with a photo: green outer ring + photo fade/zoom in (`.frame.photo`,
  keyframes `lockRingIn` / `lockPhotoIn`); keyed by ID so it replays per new ID, not on
  the passcode step; off under reduce-motion.
- Passcode boxes (sign-in + Settings' Current/New/Repeat) are **not** `type="password"`
  any more: text drawn as dots (`-webkit-text-security`, `passcodeBox()`), because Chrome
  treated them as website logins and showed "found in a data breach" after every
  sign-in. Browsers without text dots keep a password box. Note: in that file `CSS` is
  the stylesheet string, so the check uses `globalThis.CSS`. Project Ledger's own login
  is a real password and is unchanged. Full write-up, incl. how to delete passcodes
  Chrome already saved: `docs/passcode-google-password-manager.md`.
