# PROJECT LEDGER — Replication Blueprint

> **Purpose of this document.** A complete, storage-agnostic specification of the Project Ledger web application: its architecture, data model, business rules, every screen and dialog, and every user flow. It is written so that an AI assistant (or a developer) can rebuild the application **without** the original backend (Supabase) and **without** the Daily Time Record (DTR) subsystem that ships beside it in the original repository.
>
> **How to use it in a Claude chat.** Paste this whole file (or upload it to a Project as knowledge). Then ask for the build in stages, in this order: (1) storage adapter + domain modules, (2) app shell + auth screens, (3) the ledger page (header, filters, KPIs, table), (4) targets + target tracking, (5) dialogs (audit, manage targets, admin, previous data), (6) import/export. Section 12 is an acceptance checklist you can hand back to the assistant after each stage.
>
> **Attached appendices.** The `appendix/` folder beside this file holds the original pure-logic modules (no backend dependency). They encode exact formulas, validation messages and import rules and should be copied into the rebuild verbatim rather than re-implemented from prose. Section 11 lists them.

---

## 0. Scope and exclusions

**In scope** — everything a signed-in user sees and does in the Project Ledger:

- Username/password sign-in, password recovery, forced temporary-password change.
- The ledger page: header, startup status, Excel import panel, filter bar, KPI tiles, money meters, status chart, group chart, SWA monitor, virtualised editable projects table, target tracking panel.
- Inline editing with per-row save, save-all, keyboard shortcut, unsaved-changes guard.
- Targets (single-target inline mode and multiple-targets mode with a Manage Targets dialog), target history.
- Field-level audit trail with per-cell right-click history and whole-project history.
- Excel import (additive merge of two workbook types), CSV export, upload archive.
- Dataset restore points ("Previous data").
- Add project by hand, admin delete project / target / audit entries (with purge logs).
- Presence (who has the ledger open), named per-user permissions, admin user management.
- PWA install prompt, splash, service worker.

**Out of scope (do not build):**

- The DTR / Staff Logbook / employee roster / timekeeping subsystem and anything that references it (a hidden double-tap on the login screen opened it in the original; drop that gesture).
- Supabase specifically. Replace with a **local storage adapter** (in-memory + `localStorage`/IndexedDB, or a tiny Node/Express + SQLite backend). The adapter contract is in §9.
- hCaptcha. Treat CAPTCHA as disabled; keep the admin toggle as a no-op flag if you like.
- Vercel deployment specifics.

**Stack of the original** (replicate the same unless told otherwise): React 19, Vite, Tailwind CSS v4 (via the Vite plugin, utilities only), inline styles with a token object for colour/typography, `xlsx` (SheetJS) loaded dynamically for import, no router library, Node's built-in `node:test` for pure-module tests.

---

## 1. Architecture overview

### 1.1 Layers

```
┌──────────────────────────────────────────────────────────────┐
│ App shell  (App.jsx, AuthGate, SignIn, ResetPassword, PWA)    │
├──────────────────────────────────────────────────────────────┤
│ ProjectLedger page component (state, loaders, handlers)       │
│   ├─ presentational components (Panel, Kpi, Meter, FilterBar,  │
│   │    LedgerTable, TargetAnalysis, SwaMonitor, charts, modals) │
│   └─ lazily-loaded dialogs (AuditModal, TargetsModal,          │
│        AdminPanel, DatasetHistoryModal)                        │
├──────────────────────────────────────────────────────────────┤
│ Domain modules (pure, tested): targets, targetHistory,         │
│   panelData, projectImport, swaMonitor, virtualWindow, shared  │
├──────────────────────────────────────────────────────────────┤
│ Storage adapter  (was Supabase: tables + RPCs + edge functions │
│   + file bucket)  →  replace with local adapter, §9            │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 Core data flow

1. **Imported dataset** — one shared document holding every project parsed from Excel workbooks (`{ version: 2, coll: CollectionRow[], dim: [identity, MasterRecord][], legacy: [baseKey, identity][] }`). Imports are additive; the dataset is snapshotted to a *version* before every import or restore.
2. **Manual values** — one record per project ID holding hand-typed overrides (status, contract, engineer, SWA %, remarks, NTP date, completion date). Rendered **on top of** workbook values; the workbook value keeps moving underneath and its changes are audited.
3. **Targets** — zero or more deliverables per project, each with scope ("Balance Work"), quantity, unit, dates, actual output, remarks, archive flag. Completion date is **system-stamped** when actual output reaches target quantity and cleared if it later falls below.
4. **Audit** — one append-only row per changed field per save, for project-level and target-level changes, plus event rows (project created, target created/archived/restored). Grouped by `batch_id`.
5. **Render-time merge** — `row = { ...workbookRow, ...handCreatedValues, ...manualOverrides, ...unsavedDraft }` plus derived target summaries. Filters, KPIs, charts, totals and export are computed over the merged rows.

### 1.3 Key invariants (keep these in the replica)

1. The join key for manual values, targets and audit is `id = "RawId - Year"` (e.g. `QMB-014 - 2025`), normalised through `projectKey()` (upper-case, apostrophes removed, whitespace collapsed). `displayId` (year-free) is display only.
2. Failures are never rendered as empty collections. A failed load shows "unavailable" and locks writes; a failed parse throws rather than returning an empty grid (an empty grid would merge as a mass deletion).
3. Imports add and update, never remove. Blank workbook cells never overwrite existing values. Removal is an explicit, permission-gated admin action with a required reason and a purge log.
4. Every write carries audit rows in the same transaction. Update operations compute the diff **in the storage layer** against the current record; a client-supplied "changed fields" list is never trusted for targets.
5. Money is counted once per project. Targets *reference* their project; they never copy `bal`/`contract`, so money can never be summed per target.
6. Permission and role checks are enforced in the storage layer, not only hidden in the UI.
7. No app role deletes directly; deletion goes through functions that copy rows to a purge log first.

---

## 2. Visual identity and design tokens

Light theme only. No dark mode exists. Everything is inline styles from a token object `T` plus Tailwind utilities for spacing/flex/text size.

```js
export const T = {
  paper: "#E9EDE7",    // page background (with a 28px graph-paper grid of 1px ruleSoft lines)
  paper2: "#F4F7F2",   // inset surfaces, table headers, inputs, inverse text on ink buttons
  panel: "#FFFFFF",    // cards
  ink: "#16211C",      // primary text, primary buttons, emphasis borders
  inkSoft: "#4C5B53",  // secondary text
  inkFaint: "#7F8D84", // tertiary text, disabled, placeholders
  rule: "#C6CEC4",     // 1px borders
  ruleSoft: "#DEE4DA", // row dividers, grid lines
  collected: "#0E5B57",// teal-green: primary action, positive, "collected", on-track
  works: "#9A4B12",    // burnt amber: warnings, unbilled works, at-risk money
  retention: "#6E6014",// olive: retention
  cash: "#3C6E9E",     // steel blue: loading/info, cash balance
  bad: "#8C2F26",      // brick red: errors, overdue, suspended
};
export const DISPLAY = '"Archivo","Helvetica Neue",system-ui,sans-serif';          // headings/labels: UPPERCASE, letter-spacing .04–.09em, weights 600–800, 9.5–14px
export const BODY    = '"IBM Plex Sans",system-ui,-apple-system,sans-serif';       // prose, text inputs, 12–14px
export const MONO    = '"IBM Plex Mono",ui-monospace,Menlo,monospace';            // numbers, IDs, captions, 10–13px
```

Ad-hoc tints: `#E4EFEC` collected tint (success, COMPLETED), `#F0F6F4` drop-zone hover, `#F2F6F1` collection-column cell bg, `#FBFCFA` editable cell bg, `#F7FAF6` quiet/done row, `#F3F8F4` new-row tint, `#FBEEEC` error tint, `#FDF3EA` warning tint, `#E8F0F7` blue tint (NOT YET AWARDED), `#FFF4C2`/`#D2A21C`/`#765900` ongoing amber, `#F0CB45`/`#C79E1E` critical pill, `#C28A00` editable column header text, overlays `rgba(22,33,28,.35–.58)`.

Shape rules: radius **2px** on controls, cards and dialogs; **999** on pills/badges; 50% on dots. 1px borders in `rule`/`ruleSoft`; emphasis borders `2px solid ink` under the page header, table head and above table foot. Panel shadow `0 10px 26px -20px rgba(22,33,28,.6)`; menu shadow `0 18px 40px -20px rgba(22,33,28,.55)`; dialog shadow `0 18px 50px rgba(0,0,0,.25)`.

Typography idioms: panel titles `text-[11px] uppercase tracking-widest` DISPLAY 700; KPI labels 10px uppercase DISPLAY 600 inkSoft; KPI values `text-xl` MONO 600; captions 10–11px MONO inkFaint; table body 11.5–12px; table headers 10px DISPLAY uppercase.

Formatters (copy from `appendix/shared.js`):

```
money(n)   → "—" if null/NaN; else sign + "₱" + |n| rounded to 0dp, en-US grouping      (₱1,234,567)
compact(n) → ≥1e9 "₱x.xxB" · ≥1e6 "₱x.xM" · ≥1e3 "₱xK" · else money(n)
qty(n)     → "—" if blank/NaN; else en-US, max 2 decimals
pct(n)     → "—" if null/NaN; else (n*100).toFixed(1)+"%"       // n is a FRACTION: 0.101 → "10.1%"
fmtDate(s) → "" if blank; parse `${s}T00:00:00`; invalid → raw s; else en-GB "dd MMM yyyy" (08 Oct 2026)
formatUploadDateTime(v) → "—" if invalid; Intl dateStyle "medium", timeStyle "short"
```

z-index ladder: filter bar 20 (sticky), AuditModal 20, TargetsModal 24, AdminPanel 25, TargetHistory 26, uploads sub-modal 28, DeleteProject/AddProject/SWA zoom/PasswordChange 30, UnsavedReload 40, AccessModal 40, DatasetHistory 45, ID context menu 50, LazyDialog fallback/error 60.

Responsive: single column, `max-width 1480px`, 16px side padding, `flex-wrap` everywhere, KPI grids `repeat(auto-fit, minmax(168px,1fr))`. At `max-width: 640px`: dashboard grid becomes one column; toolbar action buttons collapse to 40px icon-only buttons; filter bar becomes static, stacked, full-width controls with 44px min-height; filter menus ≤ 60vh.

Accessibility: dialogs `role="dialog" aria-modal aria-labelledby`; startup banner `role=status|alert`; disabled filter bar uses `inert`; icon buttons have `aria-label`; native `title` tooltips everywhere; `prefers-reduced-motion` disables animations.

---

## 3. App shell and authentication

### 3.1 Bootstrap

- `index.html`: title "Project Ledger System", manifest link, apple-touch-icon, `theme-color #12233A`, self-hosted fonts stylesheet (`/fonts/fonts.css`, woff2, `font-display: swap`), `<div id="root">`.
- `main.jsx`: imports global CSS (`@import "tailwindcss"` + splash keyframes + mobile overrides), registers `/sw.js` in production, renders `<StrictMode><App/></StrictMode>`.
- **StrictMode double-mount** is handled by a request de-duplication helper `once(key, start)` (module-level `Map<string, Promise>`; entry removed on settle only if it is still the same promise). Keys: `"dataset"`, `` `manual:${userId}:${attempt}` ``, `` `targets:…` ``, `` `profile:…` ``, `` `permissions:…` ``.

### 3.2 `App`

No router. State: `showPwaSplash` (true only when running as installed PWA: `display-mode: standalone` or iOS `navigator.standalone`; shows `<PwaSplash/>` for 2.4s). Then:

```jsx
<AuthGate>
  {(user, signOut) => <ProjectLedger key={user.id} user={user} onSignOut={signOut} />}
</AuthGate>
```

### 3.3 `AuthGate`

State: `session`, `checking` (true at start), `recovery`.

1. On mount: read the persisted session; `activate(session, isRecovery = location.pathname === "/reset-password")`. Subscribe to auth state changes (sign-in, sign-out, refresh, expiry, PASSWORD_RECOVERY).
2. `activate`: if no session or recovery → clear user, set `recovery`, route. Else set session, route.
3. `setRoute`: `history.replaceState` to `/reset-password` | `/project-ledger` | `/login` (keep only the `?ledgerMetrics=1` query param). Serve `index.html` for every path.
4. Render: `checking` → full-screen "Loading…" (DISPLAY, uppercase, letter-spaced, paper bg). Recovery or `/reset-password` → `<ResetPassword/>` if a session exists else `<SignIn/>`. No session → `<SignIn/>` + `<PwaInstallPrompt/>`. Else `children(user, signOut)`.
5. `signOut` clears the **local** session only (never fails if the server session is already gone).

### 3.4 `SignIn` screen

Layout: full-viewport centred card, max-width 400, paper background with the 28px grid; white panel, 1px rule border, layered shadow, and an animated red "runner" dash travelling around the border (SVG rect, `stroke-dasharray 260 740`, 3s linear loop, drop-shadow glow). Header: `<h1>` "PROJECT LEDGER" (DISPLAY 800, 20px, uppercase, letter-spaced) and subtitle "`<Company>` — sign in to continue".

Fields (MONO inputs, paper2 bg, 1px rule border → ink on focus; uppercase 10px labels):

- **Username** (text, autofocus, `autocomplete=username`).
- **Password** (hidden; small mono "show/hide" toggle on the label row). Hidden entirely in Forgot mode.
- Error box `role=alert`: red text on `#FBEEEC`, 3px left border. Notice box `role=status`: teal text on `#E4EFEC`.
- Primary button (ink bg, paper2 text, uppercase, letter-spaced): "Sign in" / "Signing in…" or, in Forgot mode, "Send recovery link" / "Sending…".
- Secondary text button: "Forgot password?" ↔ "Back to sign in" (toggles mode, clears messages).
- Footer hint (11px faint): normal → "Please use your `<ERP>` username and password to proceed."; forgot → "Users without an active email must contact an administrator for a temporary password."

Rules:

- Empty username → "Enter your username."; empty username or password (sign-in mode) → "Enter your username and password."
- Forgot: call the `password-recovery` operation; **always** show notice "If the username exists, a recovery link has been sent. Please check the registered email." (existence is never leaked).
- Sign in: call `auth-login` with `trim().toLowerCase()` username. On `{ session }` → set the session (the auth listener swaps to the app; button stays disabled). On failure: clear password, show mapped message:
  - contains "invalid login credentials" → "That username and password don't match an account."
  - "email not confirmed" → "This account hasn't been confirmed yet. Ask the administrator to confirm it."
  - "too many requests" / "rate limit" → "Too many attempts. Wait a moment and try again."
  - "failed to fetch" / "network" → "Can't reach the server. Check your internet connection."
  - else raw message or "Sign in failed. Try again."

### 3.5 `ResetPassword` screen

Centred white form, max-width 400, padding 22. `<h1>` "SET NEW PASSWORD" (DISPLAY 800, 19px). Paragraph "Choose a new password for your Project Ledger account." Fields: New password, Confirm password (`type=password`, `minLength 6 maxLength 8`). Validation: length 6–8 else "Password must be between 6 and 8 characters."; mismatch → "Passwords do not match." Submit → update the current user's password; success → `location.replace("/project-ledger")`. Button "Save new password" / "Saving…".

### 3.6 Forced temporary-password change (`PasswordChangePanel`, inside the ledger)

Shown as a blocking overlay (z 30, `rgba(22,33,28,.4)`) when `profile.force_password_change` is true. Form 420px, panel bg, 1px ink border, padding 22. Title "CHANGE TEMPORARY PASSWORD" (DISPLAY 14). Copy: "An administrator assigned a temporary password. Choose a private password to continue." Two password inputs (placeholders "New password (6–8 characters)", "Confirm password"; MONO 13, paper2). Error `role=alert`. Full-width ink button "Change password" / "Saving…". Validation as §3.5. On submit: `complete-password-change { password }` then clear the user's `force_password_change` flag. Success state: 58px collected circle with white ✓ (keyframes scale .35→1.12→1, .55s), heading "Password changed successfully", "Returning to Project Ledger…", `onDone` after 1800ms (which unlocks the ledger).

### 3.7 PWA install prompt and splash

- **PwaInstallPrompt**: only on the login screen and only when not standalone. Opens 3s after mount; captures `beforeinstallprompt`; closes on `appinstalled`. Fixed bottom-right card ≤360px, white, 1px ink border, × dismiss. 44px app icon, title "INSTALL APPLICATION", text "Install Project Ledger for faster access to the ledger." (original mentioned DTR; drop it), full-width ink button "Install application" / "Preparing install…", mono hint line (`aria-live`). Behaviour: deferred prompt exists → `prompt()`; accepted → close; dismissed → "Installation was cancelled. Click Install application to try again."; no deferred prompt → platform hint (iOS: "tap Share in Safari, choose Add to Home Screen, then tap Add."; Android: "open the browser menu (⋮) and choose Install app or Add to Home screen."; desktop: "use the install icon in the address bar or browser menu.").
- **PwaSplash**: full-viewport, 96px icon (rounded 24, scale/rotate-in 1.1s), wordmark "Project Ledger" in italic serif with a typewriter reveal (`max-width 0 → 14ch`, 14 steps, 1.55s, teal blinking caret ×3), caption "PROJECT LEDGER SYSTEM" (mono 10px, .28em tracking, fades in at 1.65s). Reduced motion → everything static.
- **Manifest**: name "Project Ledger", short_name "PL", standalone, background `#DDE1E3`, theme `#12233A`, 192/512 icons.
- **Service worker** (`project-ledger-shell-v3`): precache `/`, `/index.html`, manifest, icons; `skipWaiting`, `clients.claim`, delete older shell caches. Fetch: same-origin GET only; **never cache API/data paths**; navigations network-first with cached `index.html` fallback; static assets (`/assets/`, `/icons/`, `/fonts/`, manifest, favicons) stale-while-revalidate.

---

## 4. Data model (storage-agnostic)

Conventions: `actor` = the signed-in user id, always resolved from the session, never from the request body. Dates are ISO `YYYY-MM-DD` strings; percentages are stored as **fractions**. Business timezone for stamping completion dates: **Asia/Manila**. "Access rule" = what the storage layer must enforce.

### 4.1 `profiles`

```
id                        uuid  PK (= auth user id)
username                  text  NOT NULL UNIQUE, lower-case, /^[a-z0-9][a-z0-9._-]{2,31}$/
role                      text  'user' | 'admin'   default 'user'
force_password_change     bool  default false
multiple_targets_enabled  bool  default false       -- per-user feature flag
created_at                timestamptz
```

On account creation auto-insert a profile with username `user-<first 8 hex of id>`. Access: a user reads their own row (admins read all); a user may update only their own `username`; role and flags change only through admin operations. Helpers: `get_login_email(username)` (anonymous-callable: maps username → the internal login email, or null), `is_project_admin()`, `complete_password_change()` (clears the actor's flag).

### 4.2 `project_manual_updates` — hand-typed project-level values

```
project_id        text PK          -- the "RawId - Year" string the row was first saved under
status            text             -- override of imported status; null = show imported
contract_amount   numeric          -- override; null = show imported
engineer          text             -- override; null/"" = show imported
swa               numeric          -- override, FRACTION; null = show imported
remarks           text             -- project remarks ("Remarks" column)
ntp_date          date             -- panel-only; never imported
completion_date   date             -- panel-only; never imported
updated_by        uuid NOT NULL
updated_at        timestamptz NOT NULL
```

Access: any signed-in user reads all; insert/update allowed when `updated_by = actor`; no delete (only via `admin_delete_project`). The client upserts this record directly and writes its own audit rows (source `panel`). Helper `project_audit_id(project_id)` returns the stored `project_id` of the existing row whose `projectKey` matches, else the input — so one project keeps one history even if its ID spelling changed.

### 4.3 `project_manual_update_audit` — one row per changed field

```
id                   bigint identity PK
project_id           text NOT NULL        -- no FK; audit must survive deletion of the manual row
column_name          text NOT NULL        -- display label, e.g. 'Status' (history lookups match on this)
field_key            text                 -- stable key, e.g. 'status'
old_value            text
new_value            text
changed_by           uuid NOT NULL
changed_by_username  text NOT NULL        -- denormalised, fallback 'Unknown user'
changed_at           timestamptz NOT NULL
target_id            uuid  FK → project_targets (no cascade: a target cannot be deleted while audit exists)
target_scope         text
action               text  'create' | 'update' | 'archive' | 'restore'
source               text  'panel' | 'target_modal' | 'excel' | 'migration'
batch_id             uuid                 -- groups all rows of one save or one import
indexes: (project_id, column_name, changed_at desc); (target_id, changed_at desc); (batch_id)
```

Access: read all; insert when `changed_by = actor`; no update/delete except `admin_delete_audit_entries`.

**Label ↔ key dictionary (must match exactly):**

| field_key | column_name | level |
|---|---|---|
| status / contract / note / engineer / swa | Status / Contract / Remarks / Senior engineer / SWA % | project (panel) |
| ntpDate / completionDate | NTP date / Completion date | project (panel only) |
| project | Project | project creation event |
| name / district / license / category / location / office | Project name / District / License / Category / Location / Implementing office | import |
| billpct / net / cg / cr / bal / netbal | Billed % / Collected (net) / Balance works / Retention / Balance for collection / Net balance | import |
| target | Target | target create/archive/restore event |
| scope | Scope  (shown on screen as "Balance Work") | target |
| target_qty / unit / start_date / target_completion / actual_output / actual_completion | Target qty / Unit / Start date / Target completion / Actual output / Actual completion | target |
| remarks | Target remarks  (deliberately not "Remarks") | target |

### 4.4 `project_targets`

```
id                 uuid PK
project_id         text NOT NULL   -- display spelling ("RawId - Year" or legacy bare id)
project_key        text NOT NULL   -- projectKey(project_id); the join
scope              text            -- "Balance Work"; optional
target_qty         numeric  ≥ 0 or null
unit               text
start_date         date
target_completion  date     ≥ start_date or null
actual_completion  date     SYSTEM-SET only, ≥ start_date
actual_output      numeric  ≥ 0 or null
remarks            text
archived_at        timestamptz     -- soft removal
archived_by        uuid
created_by / created_at / updated_by / updated_at
indexes: (project_key) where archived_at is null; (project_key, target_completion)
```

Access: read all; insert when `created_by = actor`; update when `updated_by = actor`; no delete. **All writes go through the three operations in §9.4** so audit lands in the same transaction.

Multiple-targets guard (before insert, before update of `archived_at`/`project_key`): if the actor's `multiple_targets_enabled` is false and the write would leave **more than one active** target on the project → error `Multiple targets are disabled for your account. Ask an administrator to enable the feature.`

### 4.5 `project_ledger_dataset` (single document) + versions + restore audit

```
project_ledger_dataset            -- exactly ONE record, id = 'current'
  payload               json      -- { version: 2, coll: [...], dim: [[identity, record]...], legacy: [[baseKey, identity]...] }
  source_label          text      -- e.g. "Imported 612 · master.xlsx, collectibles.xlsx • QMB-014 - 2025 added"
  project_count         int
  uploaded_by           uuid
  uploaded_by_username  text
  uploaded_at           timestamptz

project_ledger_dataset_versions   -- immutable restore points: copy of the replaced dataset
  id, payload, source_label, project_count, uploaded_by, uploaded_by_username, uploaded_at,
  saved_reason  'before_import' | 'before_restore',
  saved_by, saved_by_username, saved_at

project_ledger_dataset_restore_audit
  id, version_id, restored_by, restored_by_username, restored_at,
  previous_source_label, restored_source_label, project_count
```

Access: read all; writes only via `save_project_ledger_import` and `restore_project_ledger_version`.

### 4.6 `project_ledger_uploads` + private file store

```
id, uploaded_by uuid, original_filename text, storage_path text UNIQUE ('<userId>/<uuid>/<safe filename>'), uploaded_at
```

Access: a user may only insert rows/files under their own id folder (xlsx/xls/xlsm). No app read — admins read through the `admin-users` operation (list + 60-second signed URL). Local replacement: per-user folder on disk or IndexedDB blob store.

### 4.7 `security_settings` (single row `id=1`): `captcha_enabled bool default true`. Readable by everyone (pre-login); writable only by the admin operation. For the replica default to `false`.

### 4.8 `password_recovery_attempts`: `username PK, attempts int, window_started_at, locked_until`. Service-only. Rule (`consume_password_recovery(username)`): max **2** recovery sends per **15-minute** window per username; the third attempt sets `locked_until = now + 15 min` and is refused; the caller never learns whether the username exists.

### 4.9 `project_ledger_presence`: `user_id PK, username, first_seen_at, last_seen_at`. One row per user (not per tab); never deleted on tab close; expires by age. Read only by admins directly; the app reads via `list_ledger_presence`.

### 4.10 `project_ledger_permissions`: `(user_id, permission) PK, granted_by, granted_by_username, granted_at`. `permission ∈ {add_project, delete_project, delete_audit, view_presence, view_duplicates, previous_data}`. Admins hold all six implicitly (no rows needed). Read: own rows or admin. Write only via `set_ledger_permission` (admin only — holders cannot pass permissions on).

| permission | label | detail | enforced in storage layer? |
|---|---|---|---|
| `add_project` | Add project | Create a project by hand in the Projects panel. | No (UI only; import is a dataset write every user can make) |
| `delete_project` | Delete project | Permanently delete a project, its targets, audit history and hand-typed values. Also covers deleting a single target. | Yes |
| `delete_audit` | Delete audit trail | Delete individual audit entries, or a whole cell's history. | Yes |
| `view_presence` | See who is signed in | Show the list of users with the panel open, in the header. | Yes |
| `view_duplicates` | View duplicate Project IDs | Right-click the ID column or header to list Project IDs appearing more than once. | No (pure client arithmetic) |
| `previous_data` | Previous data | Restore the shared ledger to an earlier saved state. | Yes |

### 4.11 Purge logs (append-only, never written by the app directly)

```
project_target_purge_log : target_id, project_id, project_key, target_scope, reason, purged_by_uid, purged_by_username, purged_at, audit_rows_deleted, payload { target, audit[] }
project_audit_purge_log  : audit_id, project_id, column_name, target_id, reason, purged_by_uid, purged_by_username, purged_at, payload (row)
project_purge_log        : project_ids[], project_keys[], reason, purged_by_uid, purged_by_username, purged_at, targets_deleted, audit_rows_deleted, manual_rows_deleted, payload { targets[], audit[], manual[] }
```

Admins may read the audit and project purge logs; the target purge log is service-only.

---

## 5. Domain rules

### 5.1 Canonical project key

```js
projectKey(v) = String(v ?? "").toUpperCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim()
// "qmb-014" → "QMB-014";  "O'BRIEN-2" → "OBRIEN-2";  "  QMB   14 " → "QMB 14";  null → ""
```

Implement the same function in the storage layer (`project_key`). Use it only as a join key; never rewrite display IDs.

### 5.2 Assembled project row (output of `assembleProjects`, before manual overlay)

```
identity   "BASEKEY - YEAR" | "BASEKEY"      normalised join identity
baseKey    normalised ID without year;  rawId  as spelled;  year  number|null
id         displayProjectId(rawId, year) = "RawId - 2025"   ← THE join key for manual/targets/audit
displayId  cleanText(rawId)                                  ← shown in the ID column
name, district, license, engineer, category, location        (placeholders: "" / "UNSPECIFIED" / "UNSPECIFIED" / "UNASSIGNED" / "UNSPECIFIED" / "UNSPECIFIED")
status     collection.status || master.status || "UNSPECIFIED"
swa        fraction|null;  office  collection.office || "NONE";  yearStr  String(year) | "UNSPECIFIED"
contract   collection.contract ?? master.contract ?? null
billpct, gross, net, cg, cc, cr, bal, netbal   number|null   (from the Collectibles sheet)
remarks    collection.remarks || ""
isLatestYear, inQmb, inLicenses, qmbOverlap (= inQmb && inLicenses), collectionAvailable
manualValues  {field: value} | null   (set when the project was created by hand)
_hay       lower-cased search haystack
```

Rows sorted by `id`. Collectibles rows attach to a master record by exact identity when they carry a year, otherwise to the base ID's **newest** master year; a collection row with no master becomes a collection-only row.

### 5.3 Render-time merge and derived fields

```
merged = { ...importedRow, ...(row.manualValues || {}), ...(manualEntry.values || {}) }; Object.assign(merged, drafts[row.id])
auditId   = manualEntry.storedId || row.id
auditIds  = unique([row.id, storedId, legacyBaseKey])          // every spelling this project's records may be filed under
manualFields = keys that have a typed override
targets   = union of targets under projectKey(id) and under the legacy base key (dedupe by target id)
targetsUnavailable = targets failed to load
targetSummary = assessProjectTargets(merged)                      // { tracked, drafts, archived, worst, active, atRisk, nextDue, delivered }
primaryTarget = selectPrimaryTarget(targets)                      // single-target mode
targetTotals  = aggregateProjectTargets(merged) → aggTargetQty, aggActualOutput, aggStartDate, aggTargetCompletion, unitsMixed
targetCount   = multipleTargetsEnabled ? tracked.length : min(tracked.length, 1)
hasTarget     = targetsUnavailable ? "Targets unavailable" : count > 0 ? "With target" : "No target"
scope, target_qty, unit, start_date, target_completion, actual_output, remarks  ← copied from primaryTarget (or "") for inline columns
_hay += status, contract, note, engineer, name, district, category, location, live target scopes, live target remarks
```

### 5.4 Status contract

- Allowed: `["UNSPECIFIED", "NOT YET AWARDED", "ONGOING", "COMPLETED", "SUSPENDED"]` (lifecycle order).
- Precedence: manual override > Collectibles STATUS > master status > `UNSPECIFIED`. Import normalisation: upper/trim/collapse; `ON-GOING` and `ON GOING` → `ONGOING`.
- Blank displays as UNSPECIFIED but **nothing is written** until a user picks. An unrecognised non-blank legacy value shows as a disabled "current" option.
- Project status is **never** auto-derived from targets, NTP date or completion date.
- Status tones: UNSPECIFIED paper2/`#C6CEC4`/`#7F8D84`; NOT YET AWARDED `#E8F0F7`/cash/cash; ONGOING `#FFF4C2`/`#D2A21C`/`#765900`; COMPLETED `#E4EFEC`/collected/collected; SUSPENDED `#FBEEEC`/bad/bad (bg/border/text).

### 5.5 Manual override rules

- `status`, `contract`, `engineer`, `swa`: null = no override. Engineer is normalised (collapse whitespace, trim, UPPERCASE); a blank engineer means "show imported". Dates (`ntpDate`, `completionDate`): blank clears.
- Save validation: non-blank non-numeric contract → `Contract must be a numeric amount.`
- `buildManualSave` (appendix `panelData.js`): refuses when manual values failed to load (`Saved project updates could not be loaded, so saving is blocked — a save now would overwrite stored values with blanks. Reload the page and try again.`); untouched fields keep stored values (never sent as null); the first override audits against the imported value, later ones against the stored value; retyping engineer in different case is not a change.
- Audit rows for `[status "Status"], [contract "Contract"], [note "Remarks"], [engineer "Senior engineer"], [swa "SWA %"], [ntpDate "NTP date"], [completionDate "Completion date"]` only when in `changedFields` and `String(old ?? "") !== String(new ?? "")`, `action: "update"`, `source: "panel"`, one `batch_id` per save. Last write wins per record (no revision check on manual rows).

### 5.6 Percent handling

SWA % and Billed % are **fractions** in storage. Typing converts: `fractionFromPercent("10.1") = Number((10.1/100).toFixed(10))`; display `percentFromFraction(0.101) = "10.1"`. Round-trip stable for `10.1, 0.5, 99.99, 33.33, 7`.

### 5.7 Targets — state and standing (appendix `targets.js`)

```
isArchived(t)  = Boolean(t.archived_at)
isTrackable(t) = !archived && (num(target_qty) !== null || Boolean(target_completion))     // zero qty is trackable
isDraft(t)     = !archived && !trackable                                                    // stored but not tracked anywhere
isTargetDone(t)= actual_completion truthy || (qty !== null && output !== null && output >= qty)
isOutstanding  = !archived && trackable && !done

selectPrimaryTarget(targets): drop archived; pool = outstanding if any else all active;
  sort: trackable before draft; has-start before no-start; earlier start_date; earlier target_completion (missing → "9999-12-31"); created_at; id. Return first or null.

assessTarget(project, t, today):
  target   = num(target_qty); actual = num(actual_output) ?? (target !== null ? 0 : null)
  days     = daysUntil(target_completion)            // null if no due date
  elapsed  = start ? max(0, −daysUntil(start)) : null
  remaining= max(0, target − actual);  progress = target ? min(actual/target, 2) : null
  done     = isTargetDone(t)
  capacity = elapsed>0 && actual>0 ? actual/elapsed : null          // units per day achieved
  canDeliver = capacity && days>0 ? capacity*days : null
  needRate = remaining!==null && days>0 ? remaining/days : null
  pace     = capacity!==null && needRate ? capacity/needRate : null
  lateDays = done ? daysBetween(due, finish) : null;  onTime = done && finish && due && finish <= due
  bucket/rank: done ? (onTime ? "Delivered on time"/5 : "Delivered"/4)
             : days<0 ? "Overdue"/0 : days<=3 ? "Critical"/1 : "On track"/3   (no deadline → On track)
  urgency  = days===null ? 1 : days<0 ? 2.2 : days<=30 ? 1.6 : days<=90 ? 1.2 : 1
  shortfall= progress!==null && progress<1 ? 1−progress : (days<0 && !done ? 0.25 : 0)
  paceDrag = pace!==null && pace<1 ? 1+(1−pace) : 1
  score    = bucket==="Overdue" ? project.bal*urgency : shortfall*project.bal*urgency*paceDrag   // ranking only
BUCKETS = ["Overdue","Critical","On track","Delivered on time","Delivered"];  AT_RISK = ["Overdue","Critical"]
aggregateProjectTargets: sums (qty, output) over all active incl. delivered/drafts; dates = earliest among OUTSTANDING only; unit = single common unit else "" with unitsMixed=true
atRiskExposure(tracked): money = Σ project.bal counted ONCE per distinct projectKey
```

Validation (`validateTarget`): `target_qty`/`actual_output` non-blank → `"<Label> must be a number."` if NaN, `"<Label> cannot be negative."` if < 0; dates unparseable → `"<Label> is not a valid date."`; completion before start → `target_completion: "Target completion cannot fall before the start date."`. Scope is optional. Warnings (`targetWarnings`): `Actual output is above the target quantity.`; `A zero target quantity is delivered when an Actual output is saved.`

**Storage-side completion rules (must live in the adapter):**

- Create: `actual_completion = today (Asia/Manila)` iff `target_qty !== null && actual_output !== null && actual_output >= target_qty`; the client's `actual_completion` input is ignored. Error if completion < start: `Start date cannot be after the automatic completion date.`
- Update: lock the record. Errors: `That target no longer exists. Reload and try again.` / `That target belongs to a different project.` / `This target is archived. Restore it before editing.` Stamp completion iff currently null **and actual_output changed** and output ≥ qty (changing qty alone never stamps). Clear completion iff stamp present and output no longer reaches qty (**reversible**). If no field differs → write nothing, return 0. Audit one row per changed field (`source: "target_modal"`), including "Actual completion" when set or cleared.
- Archive/restore: one event row (`column 'Target'`, `action 'archive'|'restore'`, old/new = scope or `(no scope)`); no-op if already in that state.

### 5.8 Target history grouping (appendix `targetHistory.js`)

Group audit rows into events by `batch:<batch_id>` (fallback `legacy:<target_id>:<changed_at>:<changed_by>`); event time = earliest row; the `field_key === "target"` row sets the action and is not listed as a field; fields sorted in `TARGET_HISTORY_FIELDS` order (unknown keys last); events newest first.

### 5.9 Excel import rules (appendix `projectImport.js`) — summary; the module is authoritative

- Sheet tabs are matched by **tab name containing** `QMB PROJECT`, `QM LICENSE`, or `COLLECTIBLE` (file name never checked). A workbook with none is rejected with a 6-line instruction log and the ledger is unchanged.
- Header row = first of the first 12 rows containing a cell including `PROJECT ID`. Columns matched exact-then-partial against allowlists per sheet (see module). Headings like NTP / COMPLETION DATE are deliberately not mapped.
- Master sheets: skip blank ID or `TOTAL`; year must be an integer within `2022..currentYear`, else skipped and counted. Within one upload **QM LICENSES wins** over QMB PROJECTS; a later upload outranks an earlier one. License names repaired (`QMB`/`QM BUIDERS`/`QM BUILDER` → `QM BUILDERS`, etc.).
- Collectibles: year optional; first occurrence of `(baseKey, year)` wins; yearless rows attach to the newest master year.
- Folding into the existing dataset is **additive**: `mergeMasterDimensions` never removes, blank incoming cells never overwrite, hand-typed values are kept and counted as `keptManual` when the workbook disagrees; `mergeCollectionRows` replaces matched rows whole.
- `importedChanges(prev, next)` yields one `{project_id, field_key, column_name, old_value, new_value}` per differing `IMPORT_AUDIT_FIELDS` value (for new projects, null/placeholder values are skipped). Stored with `source: "excel"`.
- Hand-created projects (`buildManualProject`): errors `Project ID is required.`, `Year is required.`, `Year must be between 2022 and <currentYear>, the range an import accepts.`, `Contract amount cannot be negative.`, `SWA % cannot be negative.`; `addProjectToStore` refuses duplicates: `<RawId - Year> already exists in the ledger. Edit it instead, or delete it first.`
- `duplicateProjectIds(rows)` groups by baseKey → `{groups:[{baseKey, displayId, count, years, repeatedYear, identities}], identities:Set, rowCount}`.
- `appendDatasetNote(label, note, keep=3)` → `base • +N earlier changes • n1 • n2 • n3`.

### 5.10 SWA monitor rules (appendix `swaMonitor.js`)

Points = rows with both `swa` and `billpct` non-null. `swaP = swa*100`, `billP = billpct*100`, `lag = swaP − billP` (rounded to 6dp). `unbilled` = lag > 5 (sorted desc); `overbilled` = lag < −5; `avgSwa` = contract-weighted mean of swaP; `unbilledMoney` = Σ `cg` over unbilled; `missing` = rows − points. `swaBands(points)` = 10 deciles of swaP accumulating `bal` (100% in the top band).

### 5.11 Load-state machine (appendix `panelData.js`)

`{status: "loading"|"ready"|"failed", value, error}`; `settleLoad(allSettledEntry)` never converts a failure into an empty collection; `isReady` requires a non-null value. `ledgerReadiness`: `coreReady = dataset && manual && profile`; `mutationsReady = coreReady && !forcePasswordChange`; `targetMutationsReady = mutationsReady && targets`. Fails closed.

---

## 6. The ledger page — layout and components

Page frame: `background T.paper` with graph-paper grid, `color T.ink`, `font BODY 14px`, `min-height 100vh`; inner `mx-auto max-w-[1480px] px-4 pb-16`.

```
<header>                                   §6.1
<LedgerStartupStatus/>                     §6.2
<ImportPanel/>                             §6.3
if dataset empty → <EmptyLedger/>          §6.4
else:
  <FilterBar/> (sticky)                    §6.5
  duplicate banner (when in duplicate view) §6.6
  selection summary strip                  §6.6
  KPI grid (6 tiles)                       §6.7
  dashboard grid 7fr/3fr: Panel "Where the money sits" (2 Meters) | StatusChart   §6.8
  <GroupChart/>                            §6.9
  <SwaMonitor/>                            §6.10
  save-message banner                      §6.11
  <LedgerTable/>                           §7
  <TargetAnalysis/>                        §6.12
  dialogs (lazy)                           §8
<PasswordChangePanel/> when forced         §3.6
```

### 6.1 Header

Flex, wrap, `items-end justify-between`, `pt-5 pb-3`, `border-bottom 2px solid ink`. Left: `<h1>` "Project Ledger" (DISPLAY 800 uppercase 2xl, letter-spacing .045em) + subtitle (xs, inkSoft) "Filter by district, license, senior engineer, category, location — read collectibles, balance for collection, balance works and status." Right (MONO 11px, right-aligned): `"{N | —} projects loaded"` over `"master from QMB Projects + QM Licenses"`; then `PresenceStrip` (if `view_presence`); then **User management** button (admins only; MONO 10px, paper2, 1px rule) → AdminPanel; then **SIGN OUT** (uppercase, .08em) → clear presence (fire-and-forget) then sign out.

### 6.2 Startup status (`LedgerStartupStatus`)

Five load slices: "Latest ledger", "Saved updates", "Targets", "Account settings", "Access controls". Renders nothing when all ready. Critical = dataset, manual, profile; secondary = targets, permissions. Title precedence: dataset loading → "Loading the latest ledger from the server…"; dataset failed → "Could not load the latest ledger from the server."; any critical failed → "Project Ledger is read-only until required data is available."; critical loading → "Applying saved updates and checking account settings…"; secondary failed → "The ledger is ready — some secondary features are unavailable."; else "The ledger is ready — finishing secondary features…". Section `role=alert|status`, bg `#FBEEEC` when critical failed else paper2, 4px left border bad/cash, 16px spinner ring while loading. One chip per slice (MONO 10.5, bordered; "Ready" / "Loading" / "Unavailable"; failed chips red with inline underlined **Retry** that re-runs just that load). Error texts listed underneath in red 10.5px.

### 6.3 Import panel (`ImportPanel`)

Header row: MONO 11.5 "Data source: **{sourceLabel}** · {uploadedBy}". Right: optional **Previous data** button (outlined; shown when `previous_data`; title "Restore the shared ledger as it was before an earlier Excel update") and a toggle **Update from Excel** / **Close** (filled ink when open; hidden when `forceOpen`, i.e. the dataset is loaded but empty).

Body (when open): drop zone `rounded-sm px-4 py-7 text-center`, `2px dashed` border (collected + bg `#F0F6F4` while dragging; rule on paper2 otherwise). Heading "Drop the two workbooks here" (DISPLAY 700 uppercase). Paragraph explaining the two workbooks, that imports add and update, that hand-typed values are retained and that workbook changes are recorded as "Excel updated" in the audit trail. Line (11px faint): "Sheet tabs read: QMB PROJECTS · QM LICENSES · COLLECTIBLES — a file with none of these tabs is rejected and the ledger is left unchanged." Hidden `<input type=file accept=".xlsx,.xls,.xlsm" multiple>`; button **Choose files** / "Reading…" / "Waiting for server…" (disabled). Disabled-reason line beneath when writes are locked. Log box (paper2, MONO 11.5): each line prefixed `! ` (warn, red) or `· ` (inkSoft).

### 6.4 Empty state (`EmptyLedger`)

Centred card `px-6 py-12`. Title (DISPLAY 800 uppercase, text-base): "Preparing the latest projects…" (loading; three skeleton bars 88/72/94% wide, 12px, ruleSoft) / "Latest ledger unavailable" / "No project data yet". Hints: "Use the drop zone above to import the workbooks." or, when unavailable, "The application remains available, but project data and all shared-data actions stay locked until Retry succeeds."

### 6.5 Filter bar (`FilterBar`)

Sticky `top-0 z-20`, panel bg, border, shadow, `px-3 pb-3 pt-2.5`. While the duplicate view is open: `inert`, opacity .45, grayscale (kept visible on purpose).

- **Search** (width 220, min 160, max 320, flex 1): label "Search" (9.5px uppercase .09em); `<input type=search placeholder="ID, project name, remarks…">` with password-manager opt-out attributes; border turns ink when non-empty.
- **One dropdown per dimension** (`DIMS`):

  | key | label | width |
  |---|---|---|
  | district | District | 190 |
  | category | Project category | 190 |
  | license | License | 260 |
  | yearStr | Project year | 140 |
  | engineer | Senior engineer | 210 |
  | office | Implementing office | 250 |
  | location | Location | 220 |
  | status | Status | 160 |
  | hasTarget | Targets | 150 |

  Trigger: full-width `px-2.5 py-1.5 text-xs`; active selection → filled ink with paper2 text; open → focus ring `0 0 0 2px collected33`; shows summary ("All" / the single value / "N selected"), a count badge, and ▲/▼. Menu: absolute `z-30 mt-1 p-2`, width `max(dim.w, 230)`, border ink, shadow; a find box (autofocus) when > 8 options; list `max-h-64 overflow-auto` of checkbox rows (accent collected, truncated name with title, MONO count; zero-count rows at opacity .4); "No match."; **Clear {label}** when active. Options sorted by count desc then name. Outside mousedown or Escape closes.
- **Clear all** button (faded unless any filter/search active).

Facet counts: `countsFor(dim)` counts rows passing every *other* dimension and the search, so a dropdown shows how many rows each value would leave.

### 6.6 Duplicate banner and selection strip

- Duplicate banner (only in duplicate view): bg `#FDF3EA`, border works, 4px left border, MONO 12: **Duplicate Project IDs** · `{groups} ID(s) on {rowCount} rows` [· `{n} with the same ID twice in one year` in red] — "filters above are disabled in this view". Right: **Back to all projects**.
- Selection strip: paper2, 1px rule, 4px ink left border, MONO 12 inkSoft: `<b>{rows}</b> of {records} projects` then `› no filters applied` or `› {label}: {values joined by ", " if ≤2 else "N selected"}` per active dimension, and `› search: {q}`.

### 6.7 KPI tiles (`Kpi`: card, 3px top border in colour, label 10px uppercase, value `text-xl` MONO, meta 10.5px MONO faint)

Sums over the **filtered** rows: `contract, gross, net, cg, cc, cr, bal, netbal`; `other = max(0, contract − gross − cg)`.

1. **Projects** — `rows.length`, meta `of {records.length}`
2. **Contract amount** — `compact(contract)`, meta `money(contract)`
3. **Collected (net)** — `compact(net)`, colour collected, meta `pct(net/contract) + " of contract"`
4. **Balance for collection** — `compact(bal)`, works, meta `net {compact(netbal)}`
5. **Balance works** — `compact(cg)`, works, meta `pct(cg/contract) of contract`
6. **Retention held** — `compact(cr)`, retention, meta `money(cr)`

### 6.8 "Where the money sits" panel (two `Meter`s) and StatusChart

`Meter`: label as KPI; `h-7` bar with 1px ink border on paper2; segment width = `max(0,v)/Σmax(0,v) * 100%`; `title "{label} — {money(v)}"`; legend swatches + bold MONO values.

- "Contract amount — billed vs works still to do": Billed gross (gross, collected), Balance works (cg, works), Unaccounted (other, ruleSoft). Legend: Billed gross `money(gross)` + `pct(gross/contract)`, Balance works + pct, Contract `money(contract)`.
- "Balance for collection — what it is made of": Unbilled works (cg, works), Cash balance (cc, cash), Retention (cr, retention). Legend adds Total `money(bal)` and `"net " + money(netbal)`.

**StatusChart** (right column): per status `{n, bal}` sorted by bal desc; horizontal bar width `bal/max` in collected; value `compact(bal)`; "N project(s)".

### 6.9 GroupChart ("group by" any `DIMS` key, default `district`)

Per group `{n, net, cg, cr, bal}`; sorted by `bal` desc; top 12. Constants `PLOT=172, HEAD=15, BAR=157, COLW=66`; `max = max(1, …max(bal, net))`; bar height `max(v>0?1:0, v/max*BAR)`. Two bars per group: a stacked balance bar (retention `cr` on top of works `cg`, total = bal) and a collected `net` bar. Labels via `compact()`. Y ticks at 1, .5, 0 of max. Legend: unbilled works (works), retention (retention), collected (collected), "left column = balance for collection · top 12 of N". Horizontal scroll on narrow screens.

### 6.10 SWA monitor (`SwaMonitor`)

Panel "SWA monitoring — accomplishment against billing". Right slot: caption `"{plotted} plotted[ · {n} without SWA]"`, a magnifier button (scatter mode only; "View the scatter full size"), toggle buttons **scatter** / **spread** (selected = ink bg, paper2 text; default scatter).

Empty: "No projects with both an SWA % and a billing figure in this selection." Else KPI row: **Avg SWA** (`x.x%`, "weighted by contract"), **Done, not billed** (count, works, "accomplishment leads billing by 5pt+"), **Value to invoice** (`compact(unbilledMoney)`, works, meta money), **Billed ahead of work** (count, retention, "billing leads accomplishment by 5pt+").

- **Scatter**: SVG viewBox 962×398, `PAD {l:54, r:18, t:18, b:50}`, plot 890×330. `x(v) = 54 + v/100*890`, `y(v) = 398 − 50 − v/100*330`. Gridlines at 0/25/50/75/100 (dashed `2 4`), parity diagonal, parity band polygon `[(0,0),(0,5),(95,100),(100,100),(100,95),(5,0)]` filled collected @ .08; region labels "BILLED AHEAD OF WORK" (retention, top-left) and "WORK DONE, NOT BILLED" (works, bottom-right); axis titles "SWA % — PHYSICAL ACCOMPLISHMENT" / "BILLED %". Bubbles sorted by `bal` desc (big drawn first), `r = 3 + sqrt(bal/maxBal)*9`, tone works/retention/collected by lag, `<title>` = `"{id}\nSWA x.x% · billed y.y%\nbalance works ₱…\n{district} · {engineer}"`. Legend: below the line — work done, not billed; within 5pt of parity — the shaded band; billed ahead of work; "bubble size = balance for collection".
- **Zoom overlay** (z 30): dialog `width min(96vw,1180px)`, `height min(94vh,940px)`; header + ×; body `SwaScatterMap`; footer legend; Escape/backdrop closes. Map toolbar: **−** (÷1.5, disabled k≤1), **+** (×1.5, disabled k≥24), **Reset**, `k.toFixed(1)×`, hint "scroll or double-click to zoom · drag to pan · hover a bubble for its project". Wheel zooms ×1.16 per notch about the cursor; double-click ×2 (shift/alt ÷2); drag pans when k>1. `zoomAbout(focus, k')`: `k' = clamp(k', 1, 24)`; `pan' = k'===1 ? {0,0} : clamp(focus − (focus − pan)·(k'/k))`; pan clamp allows 25% overscroll of the plot. Bubbles rendered with `r/k` and `strokeWidth 1/k` so screen size is constant; tick step `k≥8: 2, k≥3: 5, else 10`. Minimap (k>1 only): 108×108 bottom-right, dots r 1.1, viewport rectangle, click re-centres.
- **Spread**: heading "Balance for collection by SWA band"; 10 decile bars `lo–hi%`; width `bal/bandMax`; colour lo≥90 collected, lo≥50 retention, else works; labels `compact(bal)` and `{n} proj`. Footnote: "Money sitting in low-SWA bands is exposed — little has been built, yet it is carried as collectible. High bands are close to done and should convert quickly."

### 6.11 Save-message banner

Above the table when non-empty. Messages starting with "Could" → `role=alert`, red on `#FBEEEC`; else inkSoft on paper2. `px-3 py-2 text-xs`.

### 6.12 Target tracking panel (`TargetAnalysis`)

Panel "Target tracking and priority". Right caption: `showing {priority} of {tracked} target(s) across {projectsTracked} of {rows} projects[ · {drafts} draft(s) not tracked]`.

States: targets unavailable → "Targets could not be loaded, so nothing can be tracked here." + "This is not the same as having no targets — reload the page to try again."; none tracked → "No targets set yet. Open **Manage targets** on any row above and add one with a **Target qty** or a **Target completion** date." + amber "N draft target(s) is/are waiting for a quantity or a deadline."

KPI row (`minmax(150px,1fr)`): **Targets tracked** ("across N project(s)"); **Achieved on time** (collected; "N delivered, not confirmed on time" or "every delivery on time"); **Not yet achieved** ("N overdue · N critical · N on track"); **Overdue targets** (bad; "past completion date"); **Collection at risk** (works; `compact(risk.money)`; "N target(s) · N project(s) · ₱…" or "no targets at risk").

"Where they stand": `h-6` stacked bar (1px ink border, paper2) with segment width `count/tracked` per bucket in `BUCKET_COLOR`, titles `"{bucket} — n target(s)"`, legend with counts.

Worklist header "Work these first — on-track and completed targets are listed underneath" + **▾ Show all N** / **▴ Show top 10** (only when > 10). `ranked = [rank ≤ 1 (action items), On track, done sorted by project.bal desc]`; collapsed shows the first 10. Container `overflow-x-auto`, or `overflow-auto max-height 560` when expanded. Table 11.5px, sticky header (paper2, DISPLAY 9.5 uppercase):

| # | Project | District / engineer | Standing | Target qty | Actual | Done | Pace | Due | Balance Work | Balance to collect | Priority |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ✓ if done, — if On track, else 1-based index | displayId MONO 600, title = name | | pill (`pillStyle`) | `qty` + faint unit | `qty` + unit | `round(progress*100)%` red <100 else collected; — if null | `pace.toFixed(2)×` red <1, collected ≥1, faint null; title explains capacity/need/deliverable or "Set a start date to measure the daily rate" | `fmtDate(due)` then `· {finish} (Nd late | on time)` if done (or "· completion date not set"), else `· Nd left` / `· Nd late` (red when overdue) | scope, wrap, max-width 210 | `money(project.bal)`; title "one figure for the project, not per target" | — for done/on-track; else `h-2` bar `score/bucketMax[bucket]` in bucket colour |

Done/on-track rows bg `#F7FAF6`. Pills: `PILL_BASE` inline-block width 112, centred, `2px 6px`, radius 999, 10px/13px; Overdue filled bad/white 700; Critical filled `#F0CB45`/ink border `#C79E1E` 700; others outlined in `BUCKET_COLOR` weight 500. `BUCKET_COLOR = { Overdue: bad, Critical: "#D2A21C", "On track": collected, "Delivered on time": collected, Delivered: inkSoft }`.

Footnote (MONO 10 faint): one row per target; opens at 10; On track = deadline more than 3 days away and not yet reached; Critical = within 3 days; Overdue = passed; delivered when Actual output reaches Target qty; the system records the date of the first qualifying save permanently in the audit trail; priority ranks overdue and critical first; Balance to collect belongs to the project; drafts are tracked nowhere.

### 6.13 Presence strip (`PresenceStrip`, header; requires `view_presence`)

`presence = { users: [{user_id, username, seconds_ago}], error }`. Error → red dot + "signed in: unavailable" (title = error). No other users → faint dot + user glyph + "only you". Else a pill button: pulsing dot (tone: `seconds_ago ≤ 75` → collected else works), user glyph, first *other* user's name (max-width 130, ellipsis), `+N user(s)`. Hover/focus/click opens a popover (min-width 232, max-height 300): header "N signed in"; rows (dot, name bold unless you, "(you)", `sinceLabel`); footer "Anyone whose browser cannot reach the database does not appear, so treat this as a minimum." `sinceLabel(s) = s<60 ? "just now" : s<3600 ? "N min ago" : "N h ago"`. Heartbeat every **45s**, list refresh every **30s**, window **150s**.

---

## 7. The projects table (`LedgerTable`)

### 7.1 Toolbar (panel header right slot)

`(N)` row count (MONO faint) · **▸ Show collection detail (5)** / **▾ Hide collection detail (5)** toggle (border collected; off = `#E4EFEC` bg with ring; on = filled collected; DISPLAY 700 uppercase 10.5) · **+ Add project** (if `add_project`) · **Save changes (N)** / "Saving…" with floppy icon (filled collected when dirty; `aria-label` includes "Ctrl+S" or "⌘S" by platform) · **Export filtered CSV** with download icon (disabled when read-only). On mobile the two action buttons collapse to icons.

### 7.2 Columns

Base `COLS` in order (key · label · width · editable type · flags):

| key | label | w | edit | flags |
|---|---|---|---|---|
| displayId | ID | 88 | — | sticky left |
| yearStr | Year | 58 | — | sorts on `year` |
| district | District | 116 | — | |
| license | License | 138 | — | |
| engineer | Senior engineer | 148 | text | override survives import |
| category | Category | 116 | — | |
| location | Location | 128 | — | |
| status | Status | 126 | status (select) | |
| contract | Contract | 104 | amount | money |
| ntpDate | NTP date | 126 | date | panel-only |
| completionDate | Completion date | 126 | date | panel-only |
| swa | SWA % | 82 | pct | centred |
| billpct | Billed % | 82 | — | pct |
| net | Collected (net) | 106 | — | money, group collection |
| cg | Balance works | 106 | — | money, group collection |
| cr | Retention | 106 | — | money, group collection |
| bal | Balance for collection | 106 | — | money, group collection |
| netbal | Net balance | 106 | — | money, group collection |
| targetSummary | Targets | 150 | — | targets cell; sorts on `targetCount` |
| note | Remarks | 150 | text | wrap |

`INLINE_TARGET_COLS` **replace** `targetSummary` when the user's multiple-targets flag is **off** (and the project `note` column is hidden; the target's remarks column is shown instead):

| scope · Balance Work · 168 · text · wrap | target_qty · Target qty · 84 · qty · centred | unit · Unit · 64 · text | start_date · Start date · 126 · date | target_completion · Target completion · 126 · date | actual_output · Actual output · 88 · qty · centred | remarks · Remarks · 138 · text · wrap |
|---|---|---|---|---|---|---|

`MULTI_TARGET_COLS` are **appended after** `targetSummary` when the flag is **on** (read-only aggregates): `aggTargetQty` "Total target qty" (88, qty), `aggStartDate` "Earliest Start date" (112, date), `aggTargetCompletion` "Earliest target completion" (120, date; hint "The earliest target completion still outstanding. Targets already delivered are skipped."), `aggActualOutput` "Total output qty" (92, qty). No unit aggregate (units may be mixed; a qty aggregate with mixed units shows an amber `*`).

Effective columns:

```
COLS.flatMap(c => c.targets ? (multi ? [c, ...MULTI_TARGET_COLS] : INLINE_TARGET_COLS) : [c])
    .filter(c => multi || c.k !== "note")
    .filter(c => !c.group || showCollection)
```

### 7.3 Header, sorting, context menu

`<th>` sticky top, paper2, `border-bottom 2px ink`, DISPLAY 10px uppercase .06em, width locked to `c.w`, cursor pointer. Editable column headers are amber `#C28A00` with a red `*`. Alignment: centred flag → centre; numeric (money, pct, qty aggregates, amount/pct/qty editors) → right; else left. Sort glyphs ▲ asc / ▼ desc / ↕ inactive. Default sort `{ key: "bal", dir: -1 }`; clicking toggles direction on the same key, otherwise sets desc. Comparison: numbers `((x ?? −∞) − (y ?? −∞)) * dir`, else `localeCompare`. A final "Save" header (width 46, not sortable).

**ID context menu** (right-click on the ID header or an ID cell; requires `view_duplicates`): fixed, `left: min(x, innerWidth − 260)`, z 50, min-width 240, border ink. Items: **View duplicate Project IDs** with count (`…` while computing; amber when > 0; disabled at 0) + helper text ("Checking duplicate Project IDs in the background…" / "Project IDs appearing on more than one row, across years or otherwise." / "No Project ID appears more than once."); from a cell also **Project history** (right: displayId; "Every recorded change to this project, including its creation."). Closes on mousedown, scroll, Escape. Duplicates are computed lazily on idle (`requestIdleCallback`, timeout 3000).

### 7.4 Body and cells

Scroll container `overflow-auto max-height 620`; table `border-collapse separate; border-spacing 0; width 100%; font-size 12`. **Virtualised** (§10.1): spacer rows above/below, rows keyed `id|index`, heights measured per id (default 34, overscan 8). Totals, export and filters always use the full array.

Cell base: `padding 6px 9px`, `border-bottom 1px ruleSoft`, `vertical-align top`, width locked, overflow hidden; collection-group cells bg `#F2F6F1`.

1. Targets summary cell (`TargetSummaryCell`): unavailable → dashed "Unavailable" (title "…Reload the page."); else a full-width left-aligned button: border bucket tone (or ruleSoft), bg `BUCKET_COLOR[worst] + "14"` or panel; line 1 MONO 11.5 600 `"+ Add target"` (faint, when 0 active) or `"N target(s) ›"`; line 2 MONO 10 detail `[worst bucket lower-cased (only Overdue/Critical), "N draft(s)"].join(" · ")`. Opens Manage Targets.
2. Aggregate cells: read-only MONO 11.5 inkSoft; "Unavailable" if targets failed; `—` if empty; dates `fmtDate`, qty `qty()`.
3. Inline target cells when targets unavailable → "Unavailable" cell (paper2, MONO 10.5).
4. Editable cells → `<EditCell>` inside a td with bg `#FBFCFA` and `padding 3px 5px`; clicking the td focuses the inner control; title = read-only reason when locked; right-click → audit history for that cell (target fields pass `targetId = primaryTarget.id`).
5. Money → MONO right `money(v)`; empty → "None" when the collection group has no data for that row, else `—`; right-click audit (cursor help) if auditable.
6. Percent → MONO right `pct(v)`.
7. Default text → ellipsis. The sticky **ID cell** (left 0, panel bg, z 2, right border, MONO 600 11.5): title `[displayId, name, (admin && qmbOverlap) "Also exists in QMB PROJECTS; QM LICENSES values are used"].join(" — ")`; admin overlap marker `ⓘ` (amber); **×** delete button floated right (faint → red on hover; title `Delete {id} and everything recorded against it`; requires `delete_project`); right-click → ID menu (or audit menu when not permitted).
8. **SaveCell** per row (width 46): 24×22 button; unsaved → floppy glyph in collected on `#E4EFEC`; saved → faint check, not button-like; saving → "…". Labels "Save changes for {id}" / "No unsaved changes for {id}" / "Saving {id}…".

### 7.5 `EditCell` behaviour

Props `{ value, type, onChange, wrap, disabled, align }`; types `text | qty | amount | pct | date | status`. **Controlled; every keystroke calls `onChange`** (the parent holds drafts keyed by row id so virtualised rows can unmount without losing edits). Enter/Escape only blur; validation happens at save time.

- `amount`: blurred shows `money(toNum(v))` (raw if non-numeric); focused shows raw; input filtered to `[0-9.]` with a single dot.
- `pct`: value is a fraction; blurred shows `percentFromFraction(v) + "%"`; focused shows typed text; emits `fractionFromPercent(text)`. Title "Type the percentage itself — 10.1 is 10.1%".
- `qty`: text input, `inputMode=decimal`, right-aligned, unfiltered.
- `date`: native `<input type=date>`.
- `text` + `wrap`: auto-growing `<textarea rows=1>` (height = scrollHeight; re-fit on width change); Enter blurs (Shift+Enter newline).
- `status`: `<select aria-label="Project status">` toned per §5.4, MONO 11.5 700.
- Style: width 100%, 1px transparent border → collected on focus (ink for select), transparent bg → panel on focus, radius 2, `1px 4px`, 11.5px; BODY for text, MONO otherwise; disabled opacity .72.

### 7.6 Footer totals (`<tfoot>` sticky bottom, paper2, `border-top 2px ink`, MONO 600)

First cell "TOTAL"; district cell `"{N} projects"`; money cells `money(Σ)`; `swa` = contract-weighted average over rows with SWA: `pct(Σ swa·contract / Σ contract)`; `billpct` = `pct(Σ gross / Σ contract)`; `targetSummary` = "unavailable" if any row's targets failed, else `"{Σ targetCount} targets[ · N draft(s)]"`.

### 7.7 Read-only mode

While dataset, manual values or profile are not ready, or a password change is forced, the table is `readOnly` with `readOnlyReason` (shown as cell titles): "The latest shared ledger could not be loaded. Retry before changing shared data." / "Saved project updates are unavailable. Retry before editing or importing." / "Account settings are unavailable. Retry before editing or importing." / "Change the temporary password before editing shared data." / "Project Ledger is still confirming the latest shared data and account settings." Target cells are additionally read-only while targets are not ready.

---

## 8. Dialogs

All dialogs: fixed-inset overlay, centred flex, padding 16; card panel bg, 1px ink border (red for delete, works for unsaved), radius 2; backdrop mousedown closes unless busy; `role=dialog aria-modal`. Heavy dialogs are **lazy-loaded** (§10.2).

### 8.1 Add project (`AddProjectModal`, z 30, `min(640px,100%)`; requires `add_project`)

Title "Add a project". Fields: **Project ID*** (MONO, autofocus), **Year*** (digits only, default current year, width 110), **Status** (select, default UNSPECIFIED), then Project name (full width), District, License, Senior engineer, Category, Location, Contract amount (numeric), SWA % (numeric; typed as a percent). Note that text fields are stored upper-case. Error box `#FBEEEC`. Buttons Cancel / **Add project** ("Adding…"). Flow: `buildManualProject` → `addProjectToStore` → `saveDataset(store, appendDatasetNote(label, "{rawId} - {year} added"), [])` → `record_project_created(identity, "Created by hand[ — {name}]")`. Message: `Added {displayId}.` + either ` {held} hand-entered value(s) will stay on screen through every later import — a workbook that disagrees is recorded in that column's audit trail as an Excel update rather than applied.` or ` Every field was left blank, so a later import will fill them.` Failure → `Could not save the new project: {err}`.

### 8.2 Delete project (`DeleteProjectModal`, z 30, `min(620px,100%)`, `2px solid bad`, header `#FBEEEC`; requires `delete_project`)

Title "Permanently delete {id}". Sections: **Imported values that will be deleted (N)** (label/value table excluding placeholders UNSPECIFIED/UNASSIGNED/NONE); **Targets** (N live, N archived, scopes or "(no Balance Work)"); **Audit history** ("Counting entries…" / "N entr(y|ies) across: {columns}" / "No recorded changes."; counted live by `project_id in auditIds` ∪ `target_id in targetIds`); **Hand-typed values**; required **Reason** (placeholder "e.g. wrong Project ID typed into the 2026 workbook"). Buttons Cancel / **Delete permanently** (enabled only when the count finished, reason non-blank, not busy). Flow: (1) `admin_delete_project(auditIds, reason)` → counts; (2) `removeProjectFromStore(store, identity)`, `saveDataset(next, appendDatasetNote(label, "{id} deleted"), [])`; (3) reload manual values and targets. Message `Deleted {id}: {t} target(s), {a} audit entr(y|ies), {m} manual row(s) and {c} collection row(s). Recorded in the purge log; the imported values remain in Previous data.`

### 8.3 Unsaved-changes reload guard (`UnsavedReloadModal`, z 40, `min(520px,100%)`, `2px solid works`, header `#FDF3EA`)

Triggered by F5 / Ctrl+R / Cmd+R when drafts exist (and `beforeunload` is armed). "Unsaved changes" — "You have **N unsaved change(s)** across **N row(s)**. Reloading now discards them — typing in a cell stores nothing until it is saved." Lists the first 8 row ids + "… and N more". Buttons Cancel / **Reload and lose them** (red outline) / **Save, then reload** (filled collected, autofocus; "Saving…"; if any save fails the prompt closes and the error message stays).

### 8.4 Audit trail (`AuditModal`, z 20, `min(680px,100%)`, `max-height 80vh`)

Opened by right-clicking a cell (`field` set) or "Project history" (`field = null`). Query: audit rows where `project_id in auditIds`, ordered `changed_at desc`; plus `column_name = AUDIT_FIELD_LABELS[field]` when a field is given; plus `target_id = targetId` for target cells. Header `AUDIT TRAIL · {display label | "Whole project"}` + `Project ID: {displayId}` + ×. States: "Loading audit history…"; `Could not load audit history: {err}`; empty "No saved changes for this cell yet." / "Nothing has been recorded against this project yet."

Columns: When (`toLocaleString`, MONO 10.5) | Column (whole-project view only) | Activity ("Project created" collected · "Excel updated" works · "Manual edit" inkSoft) | User | Previous value | New value (bold; `auditValue` formats SWA as %) | Delete (if `delete_audit`). Admin purge: per-row **Delete** and **Delete all N shown** → `confirmPermanentDelete(what, "{n} audit entr(y|ies) for {displayId}.")` (native confirm → prompt for reason → alert "A reason is required. Nothing was deleted." if blank) → `admin_delete_audit_entries(ids, reason)`; notice `{n} audit entr(y|ies) deleted and recorded in the purge log.` Bar text: "Deleted entries are copied to the purge log with your name and reason."

### 8.5 Manage targets (`TargetsModal`, z 24, `min(1120px,100%)`, `max-height 86vh`; only when the user's multiple-targets flag is on and targets are writable)

Header: "MANAGE TARGETS" + `{displayId}[ — {name}]`; right: **History** (disabled with no stored targets) and ×. Sub-line (MONO 10.5 faint): `{district} · {engineer} · Status {status} · Contract {money} · project information, edited on the ledger row` (project fields are read-only here).

Table columns (EditCell types): Balance Work (text, 200, wrap) · Target qty (qty, 92) · Unit (text, 80) · Start date (date, 132) · Target completion (date, 132) · Actual output (qty, 96) · Remarks (text, 190, wrap) · Actions (96). `actual_completion` is not editable (system-stamped). Per-cell error text (red 10px) under inputs; error cell bg `#FBEEEC`; new rows bg `#F3F8F4`; archived rows opacity .55 as plain text; a warnings row (works, 10px) under rows with warnings. Actions: **Archive** (stored) / **Discard** (new) or **Restore** / **Restoring** (archived, pending toggle); **History** (link; not for new rows); **Delete** (admin, red link; immediate). `<tfoot>` "Total" | `qty(Σ target_qty)` | unit (common unit or "mixed" in works with title) | | | `qty(Σ actual_output)`. Below: **+ ADD TARGET** (collected outline on `#E4EFEC`), **Show archived (N)** checkbox when applicable, caption "Every field is optional. A target with no quantity and no completion date stays a draft and is not tracked." Footer bar: status `"{live} target(s)[ · N unsaved change(s)]"` or message (red `role=alert` when starting with "Could"/"Fix"); **Cancel**; **Save changes (N)**.

Local model: rows from `project.targets` with nulls → `""`; new rows `id: "new:N", _isNew`; flags `_archive`, `_restore`. `changedRows()` → creates (new and not archived), archives (`_archive` on a live row), restores (`_restore` on an archived row), updates (any `TARGET_FIELDS` value differs by `String(blankToNull(v) ?? "")`). Handlers: Archive asks `Archive {scope || "this target"}? It stops counting towards tracking but stays on record and can be restored.`; Delete → `confirmPermanentDelete(name, "The target and every audit entry recorded against it will be destroyed. Archiving keeps it on record instead.")` → `admin_delete_project_target` → message `Deleted {name} and {n} audit entr(y|ies). Recorded in the purge log.`; Save → "Nothing to save." / validate → "Fix the highlighted fields before saving." / `saveTargets({projectId, creates, updates, archives, restores})` → `Targets for {projectId}: {n added, n updated, n archived, n restored}.` then reload targets; Close with pending → `Discard unsaved target changes?`.

**Target history** (nested, z 26): loads audit rows by `target_id in ids` (never by project id), newest first. Header "TARGET HISTORY"; a `Show [All targets (N) | per-target]` select when > 1 target. Columns: When | Target (all view) | Column | Activity (`Target created/updated/archived/restored`, "Ledger row edit" for source panel, else "Manual edit"; tone create collected, update cash, archive faint, restore works) | User | Previous value | New value (dates via `fmtDate`). Empty: "No saved targets yet. History starts once a target is saved." / "No recorded changes yet. Every save from this point on is listed here." Footer: "One row per change; a single save is the rows sharing a timestamp. Archiving keeps a target and its history on record — nothing here is ever deleted."

### 8.6 Previous data (`DatasetHistoryModal`, z 45, `min(760px,100%)`; admins open it, `previous_data` enables restore)

Loads the newest 25 versions. Copy: "Each entry is the complete imported ledger saved immediately before an Excel update or restore. Restoring changes imported project and collection data only; manual edits, targets and audit history stay as they are." States: "Loading restore points…"; `Could not restore data: {err}`; empty "No restore point exists yet. The system creates the first one immediately before the next successful Excel update." Rows (alternating panel/paper2): caption `Saved before a restore | Saved before an Excel update · {dateTime}`, bold `source_label || "No source label"`, meta `{project_count} projects · originally uploaded by {username}[ · {uploaded_at}]`, button **RESTORE THIS DATA** ("Restoring…"; others faded). Confirm: `Restore the shared Project Ledger to “{label}”?\n\nThe current imported data will be backed up first. Manual edits, targets and their audit history will not be changed.` Then `restore_project_ledger_version(id)`, reload dataset, log `Restored previous shared data: {label}. Manual edits, targets and audit history were retained.`

### 8.7 User management (`AdminPanel`, z 25, `min(1100px,100%)`, `max-height 85vh`; admins only)

On open: `admin-users { action: "list" }` and `list_ledger_permissions()`. Top card **Live CAPTCHA protection** — "Require hCaptcha on sign-in and password recovery." toggle **Enabled** / **Disabled** (keep as a flag; no CAPTCHA in the replica).

Users table: Username (MONO) | Email | Role (text) | Status ("Blocked" red / "Active" collected) | Temporary password (`<input type=password minLength 6 maxLength 8 placeholder "6–8 characters">`) | Data (spreadsheet icon with upload count; opens the uploads viewer) | Multiple targets (**Enabled**/**Disabled** toggle → `set-multiple-targets`; message `Multiple targets enabled|disabled for {name}.`; if it is the current user the ledger switches mode immediately and closes any open Manage Targets dialog) | Access (key icon + `all` for admins or `{granted}/6`; opens AccessModal) | Actions: **Reset** (validates 6–8 → `Enter a temporary password between 6 and 8 characters.`; → `reset-password`; message `Temporary password created for {username}.`; button shows "Created ✓") and **Block**/**Unblock**.

**AccessModal** (z 40, `min(600px,100%)`): title `ACCESS · {username}`; subtitle for admins "Administrators hold every permission. Change the role to grant these individually." else "Each permission is granted separately and takes effect the next time this user loads the panel." One checkbox row per permission (label bold 12.5, detail 11 inkSoft; non-enforced ones carry a **UI only** tag in works colour). Admin rows checked and disabled. Toggle → `set_ledger_permission`; error `Could not change access: {err}`.

**Uploaded Excel files** (z 28, `min(980px,100%)`): `list-uploads` → table Excel title | Uploaded date and time | **View** / **Download**. View fetches the file (`file-url`), parses it with the dynamically loaded xlsx library and previews the selected sheet (first 100 rows × 30 columns, MONO 10, first row bold, `max-height 330`); footnote "Preview shows the first 100 rows and 30 columns of the selected sheet." Errors `The workbook could not be opened ({status}).`

### 8.8 Lazy dialog wrapper (`LazyDialog`)

Fallback (`role=status`): card "Loading {label}…" + **Cancel**. Error (`role=alert`): "{label} could not be downloaded." + "The rest of the ledger is unaffected — your projects, edits and unsaved changes are all still there. Check the connection and try again." + **Retry** / **Close**. Both on a z 60 shade `rgba(12,20,16,.42)`; card radius 10, max 460px. Retry creates a **new** `React.lazy()` instance (React memoises a rejected promise). Labels: "the audit trail", "Manage targets", "User management", "Previous data".

---

## 9. Storage adapter contract (replaces Supabase)

Implement a module exporting `isConfigured: true` and these operations. Every mutating operation is **transactional** (data + audit all-or-nothing), resolves `actor` and `username` (fallback `"Unknown user"`) from the session, and enforces the access rules of §4. Errors are thrown with the exact messages given; the UI displays them verbatim.

### 9.1 Auth and account

| operation | input → output | rules |
|---|---|---|
| `getSession()`, `onAuthStateChange(cb)`, `setSession(s)`, `signOut()`, `updateUser({password})` | | session persisted locally; `signOut` local scope |
| `auth-login { username, password }` | `{ session }` | lower/trim username; both required → `Username and password are required.`; unknown or wrong → `Invalid username or password.` (never reveal existence) |
| `password-recovery { username }` | always `{ ok: true }` | rate limit §4.8; issue a one-time reset token to `/reset-password` |
| `complete-password-change { password }` | `{ ok }` | requires session; 6–8 chars → `Password must be between 6 and 8 characters.`; requires `force_password_change = true` else `A temporary password change is not pending.`; set password then clear the flag |
| `loadProfile(userId)` | `{ username, role, force_password_change, multiple_targets_enabled }` | missing → `Your account settings were not found.` |
| `my_ledger_permissions()` | `string[]` | admin → all six; error → `Could not read your access.` |

### 9.2 Dataset

| operation | behaviour |
|---|---|
| `loadDataset()` | the `current` record or `null`; returns `{ store: deserialise(payload), label, username, at }`. Client wraps in `once("dataset")` and an **8s timeout** (`The saved ledger did not respond within 8s`). |
| `save_project_ledger_import(payload, source_label, project_count, changes[])` → timestamp | lock `current`; insert a version copy (`before_import`); upsert `current` with payload/label/count/actor/username/now; for each change with non-blank `project_id`, `old_value ≠ new_value` and `field_key` in the import whitelist (`name, district, license, engineer, category, location, status, contract, swa, office, billpct, net, cg, cr, bal, netbal`) insert an audit row (`action update`, `source excel`, one batch). Any signed-in user may call it. |
| `loadDatasetVersions()` | newest 25 by `saved_at` |
| `restore_project_ledger_version(versionId)` → timestamp | require `previous_data`; missing → `restore point no longer exists`; lock; version copy (`before_restore`); `current` ← version payload with label `Restored previous data[ · {version.source_label}]`; insert restore audit |
| `archiveLedgerUpload(file, userId)` | store the original file under `<userId>/<uuid>/<safe name>` (sanitise: replace `/ \` and control chars with `_`, collapse whitespace, keep last 160 chars, fallback `workbook.xlsx`) and insert the uploads row |

Dataset serialisation: `{ version: 2, coll, dim: [...dim.entries()], legacy: [...legacy.entries()] }`; deserialise back into Maps.

### 9.3 Manual values and audit

| operation | behaviour |
|---|---|
| `loadManual()` | all rows → `Map<projectKey(project_id), { storedId: project_id, values }>`; `values.note = remarks` always; `status/contract/swa` only when non-null; `engineer` only when non-blank; `ntpDate/completionDate` only when truthy |
| `saveManualRow(storedId, values, previous, changedFields)` | validate contract; upsert `{ project_id, status: clean||null, contract_amount, remarks, engineer: normalised||null, swa, ntp_date, completion_date, updated_by, updated_at }`; insert audit rows per §5.5 |
| `loadAudit({ projectIds, field?, targetId? })` | rows ordered `changed_at desc` with the filters of §8.4 |
| `loadTargetHistory(targetIds)` | rows where `target_id in ids`, newest first |
| `record_project_created(project_id, summary?)` | require actor (`You must be signed in to create a project.`), non-blank id (`A project ID is required.`); one audit row `column 'Project', key 'project', action 'create', source 'panel'`, new value = summary or id |

### 9.4 Targets

| operation | behaviour |
|---|---|
| `loadTargets()` | all rows → `Map<project_key, Target[]>` each sorted by `target_completion` asc (null → `"9999"`), then `created_at` |
| `create_project_target(project_id, scope, target_qty, unit, start_date, target_completion, _ignored, actual_output, batch_id, remarks)` → id | require actor (`You must be signed in to add a target.`), non-blank project (`A target must belong to a project.`); trim text (`""` → null); multiple-targets guard §4.4; completion rule §5.7; audit: one event row ('Target', create) + one row per non-null initial field |
| `update_project_target(target_id, project_id, …same fields…)` → changed count | §5.7 update rules; audit per changed field (`source target_modal`) |
| `set_project_target_archived(target_id, project_id, archived, batch_id)` → bool | §5.7; event row only |
| `saveTargets({ projectId, creates, updates, archives, restores })` (client helper) | one `batch_id` per save; sequential calls; blank → null, numbers via `numOrNull`; error message = thrown message |
| `admin_delete_project_target(target_id, reason)` | require `delete_project` (`You do not have access to delete a target. Ask an administrator to grant Delete project.`); reason required; copy target + its audit to the target purge log; delete audit then target; return `{ audit_rows_deleted }` |
| `admin_delete_audit_entries(ids[], reason)` → count | require `delete_audit`; empty → 0; copy to audit purge log; delete |
| `admin_delete_project(project_ids[], reason)` | require `delete_project`; reason and ids required (`No project was named. Nothing was deleted.`); keys = distinct projectKey of ids; collect targets by key, audit by `project_id in ids OR target_id in those targets`, manual rows by `project_id in ids`; write project purge log with payload; delete audit → targets → manual; return `{ targets_deleted, audit_rows_deleted, manual_rows_deleted }` |

### 9.5 Presence and permissions

| operation | behaviour |
|---|---|
| `record_ledger_presence()` | upsert actor row: `last_seen_at = now`; `first_seen_at = now` if previous `last_seen_at` older than 5 min; username from profile. Silent on failure (client warns once in console). |
| `list_ledger_presence(within = 150)` | require `view_presence` (`You do not have access to see who is signed in.`); rows with `last_seen_at > now − max(within, 30)s`, ordered by username, with `seconds_ago` from the **server** clock |
| `clear_ledger_presence()` | delete actor row (fire-and-forget on sign-out) |
| `set_ledger_permission(user_id, permission, granted)` | admin only (`Only an administrator can change access.`) |
| `list_ledger_permissions()` | admin only (`Only an administrator can read access settings.`) |

### 9.6 Admin users operation (`admin-users { action, … }`; admin only → `Administrator access required.`)

`list` → `{ captcha_enabled, users: [{ id, email, username, role, force_password_change, multiple_targets_enabled, banned_until, last_sign_in_at, upload_count }] }` · `list-uploads { user_id }` → `{ uploads: [{ id, original_filename, uploaded_at }] }` · `file-url { upload_id, download? }` → `{ url }` (short-lived) · `set-captcha { enabled }` · `set-multiple-targets { user_id, enabled }` · `reset-password { user_id, temporary_password }` (6–8 → `Temporary password must be between 6 and 8 characters.`; sets password and `force_password_change = true`) · `ban` / `unban { user_id }` · unknown → `Unknown action.`; missing user id → `User ID is required.`

---

## 10. Non-functional mechanics

### 10.1 Row virtualisation (appendix `virtualWindow.js`; hook `useVirtualRows`)

```
computeVirtualWindow({ count, scrollTop, viewportHeight, heightAt(i), estimate = 34, overscan = 8 }) → { start, end, padTop, padBottom }
heightOf(i) = measured(i) > 0 ? measured : estimate
walk start while offset + h <= top (stop at count−1); walk end while filled < bottom
first = max(0, start − overscan); last = min(count, end + overscan)
padTop = Σ heightOf(0..first−1); padBottom = Σ heightOf(last..count−1)   // invariant: total height preserved
```

Hook: `scroll` (passive) and container `ResizeObserver` coalesced to one rAF read; one shared `ResizeObserver` over row elements keyed by **project id** (so re-sorting keeps measurements); update only when `|Δh| > 0.5`; `measureRef(key)` returns a cached ref callback with cleanup; estimate = average measured height (fallback 34). Drafts live in the parent so unmounted rows keep unsaved values.

### 10.2 Code-splitting

Dynamically import: the xlsx library (`loadXlsx()`, memoised; failure resets the memo and throws `Excel tools could not be downloaded. Check the connection and retry.`), AuditModal, TargetsModal, AdminPanel, DatasetHistoryModal. Each behind `LazyDialog` with a fresh `lazy()` on retry. Never statically import a module you also import dynamically. Keep loader functions at module scope so re-renders don't restart downloads.

### 10.3 Timing and polling constants

| constant | value |
|---|---|
| dataset load timeout | 8 000 ms |
| secondary loads timeout | 12 000 ms |
| presence heartbeat / list poll / window / green-dot threshold | 45 000 ms / 30 000 ms / 150 s / 75 s |
| password success → unlock | 1 800 ms |
| worklist collapsed rows / expanded max height | 10 / 560 px |
| table max height | 620 px |
| virtual row estimate / overscan | 34 px / 8 |
| duplicate scan | on idle, timeout 3 000 ms |
| CSV object URL revoke | 1 500 ms |

### 10.4 Startup metrics (optional)

A privacy-safe timing module (`startLedgerTiming(stage) → finish({outcome})`, `ledgerReadiness`) with an allowlist of safe numeric/boolean fields, exposed on `window.__PROJECT_LEDGER_STARTUP_METRICS__` and logged only with `?ledgerMetrics=1`. May be stubbed.

---

## 11. Flows (end to end)

### 11.1 Startup

1. Session established → in parallel: `loadDataset` (8s timeout, gates the screen), `loadManual`, `loadTargets`, `loadProfile`, `my_ledger_permissions` (12s each, each independently settled via `settleLoad`).
2. `applyDataset`: null → empty store, label "No data yet · upload the workbooks to begin", import panel forced open; else store + `label || "{n} projects"` + `"uploaded by {username} · {fmtDate(at)}"`. Failure → label "Latest ledger unavailable", dataset failed.
3. Profile sets `username`, `role`, `forcePasswordChange`, `multipleTargetsEnabled`. Permissions feed `can(p)` (loading/failed = deny).
4. When `coreReady` and signed in: presence heartbeat starts (first beat deferred to idle), and if `view_presence` the list poll starts.
5. Retry buttons reset one slice to loading and bump its attempt counter (the `once` key includes the attempt).

### 11.2 Inline edit and save

1. Typing in an EditCell → `drafts[id][field] = value` (ignored unless `mutationsReady`; target fields also need `targetMutationsReady`). `dirtyIds`, `dirtyCount` derive from drafts.
2. `saveRow(id)`: split the draft into project fields vs inline target fields (`scope, target_qty, unit, start_date, target_completion, actual_output, remarks`). Build the manual plan with `buildManualSave`; build the target plan: `after = { ...(primaryTarget || { ...emptyTarget(), project_id: id, scope: "Primary target" }), ...targetDraft }`, `validateTarget(after, { isNew: !primary })` → first error aborts with `Could not save {id}: {msg}`; plan = update if a primary exists else create.
3. Run `saveTargets(plan)` then `saveManualRow(...)`; update the manual map in memory; if targets changed, reload all targets (`Targets saved, but the list could not be reloaded: {err}` on failure); drop the draft; message `Saved changes for {id}.` Errors → `Could not save {id}: {err}`.
4. `saveAll()` runs `saveRow` sequentially over dirty ids. **Ctrl/Cmd+S** (not with Alt/Shift; ignored while any dialog is open): not ready → `Could not save: the latest shared ledger and account settings are not confirmed.`; nothing dirty → `No unsaved changes.`; else save all.
5. `beforeunload` is armed while `dirtyCount > 0`; F5/Ctrl+R/Cmd+R open the Unsaved-changes dialog (§8.3).

### 11.3 Excel import

1. Locked → log `! Import is locked until the latest shared ledger and account settings are confirmed.`
2. `loadXlsx()`; per file: parse; `classifyWorkbookSheets`; log `"{name} — {n} sheets"`. Unrecognised → the 6-line instruction log. Collectibles → `readCollectiblesWorkbook` → `mergeCollectionRows` → `Collectibles: {added} new, {updated} updated, {retained} kept from earlier uploads`. Master → `readMasterWorkbook` → `mergeMasterDimensions` → `Projects: {added} new, {updated} updated, {retained} kept from earlier uploads` and, if any, `{n} hand-entered value(s) kept — the workbook differed and was not applied`. No usable rows → `! {name}: the sheet tab was found but no usable project rows were read from it`. Parse error → `! {name}: could not be read ({err})`.
3. If anything accepted: rebuild rows, extend legacy assignments, log `Consolidated: {n} Project ID-Year records · {matched} matched to Collectibles · {masterOnly} master-only`; label `Imported {count} · {file names}`; show immediately; `changes = importedChanges(before, after)`; `save_project_ledger_import` → `Saved to the shared ledger — {n} projects are now what everyone sees` and `{n} changed Excel field(s) recorded in audit history`; archive each accepted file → `{n} original workbook(s) added to your upload history` (or `! {name}: ledger data was saved, but the original workbook could not be archived ({err})`). Save failure → uploadedBy `not saved — visible in this browser only`, `! Shown here but NOT saved for other users: {err}`.
4. Nothing accepted → `! Nothing was imported — the shared ledger is unchanged. Fix the sheet tab names above and upload again.`

### 11.4 CSV export (filtered rows)

Columns: ID (`displayId`), Year, Project name, then every table column except ID/Targets/Remarks/Year, then Targets (`targetCount`), then Balance Work, Target qty, Unit, Start date, Target completion, "Completion date (automatic)" (`actual_completion`), Actual output, then Remarks (`note`). Target columns are filled only when the project has exactly one live target (single-target mode: the primary target). Targets unavailable → `targetCount = "unavailable"`. Quote a value containing `"`, `,` or newline (double inner quotes). UTF-8 with BOM, `text/csv;charset=utf-8`, filename `project-collectibles-filtered.csv`.

### 11.5 Filtering, search, duplicates

`passes(r)`: every active dimension set contains `r[dim]` and `_hay.includes(query.toLowerCase())`. `rows = duplicateView ? records ∩ duplicates.identities : records.filter(passes)`. Toggling a value flips membership; Clear all also clears the search. Duplicate view disables the filter bar and shows the banner.

### 11.6 Add project, delete project, restore — see §8.1, §8.2, §8.6.

### 11.7 Sign-out

`clear_ledger_presence()` fire-and-forget, then local sign-out immediately.

---

## 12. Acceptance checklist

**Domain modules (copy appendices, run their tests with `node --test`)**
- [ ] `projectKey` cases from §5.1 pass; `assessTarget` pinned values: 400/1000 done, 30 days elapsed, 30 left → capacity 13.33, needRate 20, pace 0.67.
- [ ] `fractionFromPercent`/`percentFromFraction` round-trip `10.1, 0.5, 99.99, 33.33, 7`.
- [ ] Import: a workbook with no recognised tab is rejected and the dataset is unchanged; a repeat upload adds 0; blank cells never overwrite; QM LICENSES wins within one upload.

**Storage adapter**
- [ ] Creating a target with `actual_output ≥ target_qty` stamps today's date; raising `target_qty` above output on update clears it; changing only qty never stamps; a no-op update writes no audit.
- [ ] A non-admin without `multiple_targets_enabled` cannot create a second active target.
- [ ] Import writes a version copy first and one `excel` audit row per changed whitelisted field; restore writes a `before_restore` version and a restore audit row.
- [ ] Admin delete project requires a reason, removes targets/audit/manual rows, writes the purge log; a non-admin without `delete_project` is refused with the exact message.
- [ ] Presence rows expire by age; `list_ledger_presence` is refused without `view_presence`.

**UI**
- [ ] Sign-in → ledger; forgot password always shows the neutral notice; temporary password forces the change panel and blocks edits until done.
- [ ] Startup banner shows per-slice chips with Retry; table is read-only with the right reason until core slices are ready.
- [ ] Filter dropdowns show facet counts; selection strip and KPIs update with filters; footer SWA is contract-weighted.
- [ ] Editing a cell marks the row dirty; Save per row, Save all, Ctrl+S; F5 with unsaved changes opens the guard dialog.
- [ ] Right-click a cell → audit trail for that cell; right-click ID → duplicates menu / project history.
- [ ] Single-target mode shows inline target columns; enabling the flag in User management switches to the Targets summary cell + aggregates and the Manage Targets dialog.
- [ ] Target tracking panel buckets, pills, pace and priority bars match §5.7; "Collection at risk" counts each project once.
- [ ] SWA scatter zoom/pan/minimap works; spread view shows 10 bands.
- [ ] Import log lines match §11.3 verbatim; CSV export columns match §11.4.
- [ ] Table scrolls smoothly with 500+ rows (virtualised) while totals use all rows.

---

## 13. Appendix files (copy verbatim into `src/lib` / `src/ledger`)

| file | contents | depends on |
|---|---|---|
| `appendix/targets.js` | project key, standing/pace/score, aggregation, validation, primary-target selection | — |
| `appendix/targetHistory.js` | audit rows → grouped events | targets.js |
| `appendix/panelData.js` | load-state machine, `buildManualSave`, percent conversions, normalisers | — |
| `appendix/projectImport.js` | all Excel parsing, merging, manual projects, duplicates, import audit diff | — (needs a `sheet_to_json` injected via `setWorkbookSheetReader`) |
| `appendix/swaMonitor.js` | SWA analysis and bands | — |
| `appendix/virtualWindow.js` | virtual window math | — |
| `appendix/mergeSave.js` | generic revision-checked merge loop (optional; use it if your adapter supports revisions) | — |
| `appendix/shared.js` | theme tokens `T`, fonts, formatters, status options, permissions list, audit label maps, pill styles, `once`, `confirmPermanentDelete` | projectImport.js, targets.js |
| `appendix/theme.js` | the same tokens for the auth screens | — |
| `appendix/useVirtualRows.js` | the React hook over `virtualWindow.js` | react |
| `appendix/EditCell.jsx` | the editable cell component | shared.js, panelData.js, projectImport.js |
| `appendix/*.test.js` | the original unit tests (Node test runner) | |

The appendix folder is self-contained: `cd appendix && node --test *.test.js` runs all 179 original tests and they pass. Everything else in this document (components, dialogs, handlers, adapter) is to be implemented from the specification above.
