/* ==================================================================
   Target standing and aggregation.

   Pure functions, no React and no Supabase, so the arithmetic that decides
   what is overdue and how much money is at risk can be exercised directly.
   `today` is injectable for the same reason — a standing that depends on the
   wall clock cannot be checked twice with the same answer.

   The one rule that shapes this whole file: a tracked entry holds a
   *reference* to its project, never a copy of its fields. Spreading the
   project row into each target is what makes a project's balance summable
   once per target, and the resulting figure looks entirely plausible while
   being three times too large. Keeping the reference means no aggregate can
   make that mistake, because the field is not there to sum.
================================================================== */

const DAY = 86400000;

/** Canonical project ID for matching. Mirrors public.project_key() in SQL.
 *  Display IDs are never rewritten — this is only ever a join key.
 *  Case and apostrophes are the real divergence; whitespace is already
 *  collapsed consistently by the workbook readers on both paths. */
export const projectKey = (value) =>
  String(value ?? "").toUpperCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();

export const todayMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

const parseDay = (s) => {
  if (!s) return null;
  const t = Date.parse(String(s).slice(0, 10) + "T00:00:00");
  return isNaN(t) ? null : t;
};

/** days from today until `date`; negative once it has passed */
export function daysUntil(date, today) {
  const t = parseDay(date);
  return t === null ? null : Math.round((t - today) / DAY);
}

/** days from `from` to `to`; positive means `to` falls after `from` */
export function daysBetween(from, to) {
  const a = parseDay(from), b = parseDay(to);
  return a === null || b === null ? null : Math.round((b - a) / DAY);
}

const num = (x) =>
  x === null || x === undefined || x === "" || isNaN(Number(x)) ? null : Number(x);

/* ---------------- standing ---------------- */

export const BUCKETS = ["Overdue", "Critical", "On track", "Delivered on time", "Delivered"];

/** The two standings that put money at risk. "Behind target" used to sit here
 *  but was never assigned by any branch — the scoring was simplified at some
 *  point and the bucket was left behind. It has been removed rather than
 *  carried forward. */
export const AT_RISK_BUCKETS = ["Overdue", "Critical"];

/** A target enters the tracking analysis once it has a quantity or a deadline.
 *  Anything else is a draft: stored, listed and editable, but with nothing to
 *  measure a standing against. */
export function isTrackable(target) {
  if (!target || target.archived_at) return false;
  return num(target.target_qty) !== null || Boolean(target.target_completion);
}

export const isArchived = (target) => Boolean(target && target.archived_at);

/** The legacy table can show one target only. Choose it predictably without
 *  mutating the server-ordered list: nearest completion date first, undated
 *  targets last, then the oldest stored target as the stable tie-breaker.
 *  Archived targets are retained in storage but are never selected. */
export function selectPrimaryTarget(targets) {
  const active = (Array.isArray(targets) ? targets : []).filter((target) => !isArchived(target));
  active.sort((a, b) => {
    const dueA = a.target_completion || "9999-12-31";
    const dueB = b.target_completion || "9999-12-31";
    return String(dueA).localeCompare(String(dueB))
      || String(a.created_at || "").localeCompare(String(b.created_at || ""))
      || String(a.id || "").localeCompare(String(b.id || ""));
  });
  return active[0] || null;
}

/** A target that exists but cannot be tracked yet — typically one where
 *  somebody has named the scope and not yet filled in the numbers. */
export function isDraft(target) {
  return Boolean(target) && !isArchived(target) && !isTrackable(target);
}

/** Standing for one target. `project` is kept as a reference for display and
 *  for the priority weight; none of its fields are copied onto the result. */
export function assessTarget(project, t, today) {
  const target = num(t.target_qty);
  const recordedActual = num(t.actual_output);
  const actual = recordedActual !== null ? recordedActual : (target !== null ? 0 : null);

  const due = t.target_completion || "";
  const start = t.start_date || "";
  const finish = t.actual_completion || "";

  const days = daysUntil(due, today);
  const sinceStart = start ? daysUntil(start, today) : null;
  const elapsed = sinceStart === null ? null : Math.max(0, -sinceStart);
  const gap = target !== null && actual !== null ? target - actual : null;
  const remaining = gap !== null ? Math.max(0, gap) : null;
  const progress = target ? Math.min(actual / target, 2) : null;
  /* Even a zero-quantity target needs an explicit Actual output save. This
     keeps the standing aligned with the database event that supplies the
     automatic completion timestamp. */
  const done = Boolean(finish)
    || (target !== null && recordedActual !== null && recordedActual >= target);

  /* Demonstrated capacity: what the crew has actually produced per day since
     starting. Multiplied by the days left and compared against the quantity
     still outstanding, it answers whether the remaining time can absorb the
     remaining work rather than merely whether they are behind today. */
  const capacity = elapsed !== null && elapsed > 0 && actual !== null && actual > 0 ? actual / elapsed : null;
  const canDeliver = capacity !== null && days !== null && days > 0 ? capacity * days : null;
  const needRate = remaining !== null && days !== null && days > 0 ? remaining / days : null;
  const pace = capacity !== null && needRate ? capacity / needRate : null;

  /* "On time" is a claim about the day the work landed, so it is answered by
     the recorded completion date and never by today's date — measuring from
     today would relabel a target delivered early as late the moment its
     deadline rolled by. With no completion date there is no evidence either
     way, and it stays plain "Delivered". */
  const lateDays = done ? daysBetween(due, finish) : null;
  const onTime = done && !!finish && !!due && finish <= due;

  let bucket, rank;
  if (done) { bucket = onTime ? "Delivered on time" : "Delivered"; rank = onTime ? 5 : 4; }
  else if (days !== null && days < 0) { bucket = "Overdue"; rank = 0; }
  else if (days !== null && days <= 3) { bucket = "Critical"; rank = 1; }
  else { bucket = "On track"; rank = 3; }

  /* Overdue outranks everything, and within it the whole balance still to
     collect is the weight — a deadline already missed puts the full amount at
     risk. Elsewhere the weight is the share of target still outstanding,
     tightened by how far short the crew's rate falls. This is a *ranking*
     weight only; it is never summed. Money is totalled by atRiskExposure(),
     which counts each project once. */
  const balance = project?.bal || 0;
  const urgency = days === null ? 1 : days < 0 ? 2.2 : days <= 30 ? 1.6 : days <= 90 ? 1.2 : 1;
  const shortfall = progress !== null && progress < 1 ? 1 - progress
    : (days !== null && days < 0 && !done ? 0.25 : 0);
  const paceDrag = pace !== null && pace < 1 ? 1 + (1 - pace) : 1;
  const score = bucket === "Overdue"
    ? balance * urgency
    : shortfall * balance * urgency * paceDrag;

  return {
    id: t.id,
    projectId: project.id,
    /* What to print. `projectId` keeps the year because it is the join key and
       what the audit trail is filed under; this is the short spelling the
       panel shows. Falls back to the full ID for any caller that builds a
       project row without one. */
    projectDisplayId: project.displayId || project.id,
    projectKey: projectKey(project.id),
    project,                      // reference, never spread
    scope: t.scope || "",
    unit: t.unit || "",
    start, due, finish,
    target, actual, gap, remaining, progress, days, elapsed,
    capacity, canDeliver, needRate, pace,
    bucket, rank, score, done, onTime, lateDays,
  };
}

/* ---------------- per project ---------------- */

/** Splits one project's targets into the three states the UI needs. Drafts and
 *  archived targets are returned rather than dropped, so Manage Targets can
 *  render every stored target even though tracking ignores some of them. */
export function assessProjectTargets(project, options = {}) {
  const today = options.today ?? todayMs();
  const all = Array.isArray(project?.targets) ? project.targets : [];
  const tracked = [], drafts = [], archived = [];

  for (const t of all) {
    if (isArchived(t)) archived.push(t);
    else if (isTrackable(t)) tracked.push(assessTarget(project, t, today));
    else drafts.push(t);
  }

  const atRisk = tracked.filter((t) => AT_RISK_BUCKETS.includes(t.bucket));
  const upcoming = tracked
    .filter((t) => !t.done && t.due)
    .sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const worst = tracked.slice().sort((a, b) => a.rank - b.rank || b.score - a.score)[0] || null;

  return {
    all, tracked, drafts, archived, atRisk, worst,
    active: all.length - archived.length,
    nextDue: upcoming.length ? upcoming[0].due : "",
    delivered: tracked.filter((t) => t.done).length,
  };
}

/** Every trackable target across every project, ranked the way the worklist
 *  presents them, plus the drafts that were deliberately left out. */
export function assessTargets(records, options = {}) {
  const today = options.today ?? todayMs();
  const tracked = [], drafts = [];

  for (const project of records || []) {
    for (const t of Array.isArray(project.targets) ? project.targets : []) {
      if (isArchived(t)) continue;
      if (isTrackable(t)) tracked.push(assessTarget(project, t, today));
      else drafts.push({ project, target: t });
    }
  }

  tracked.sort((a, b) => a.rank - b.rank || b.score - a.score);
  return { tracked, drafts };
}

/* ---------------- money ---------------- */

/** Collection at risk.
 *
 *  Target counts and monetary exposure are different aggregations and are
 *  returned separately on purpose. A project with three overdue targets has
 *  three at-risk targets and one balance — reporting three balances would
 *  triple a real peso figure while looking entirely reasonable.
 *
 *  The balance is read once per project and never divided among its targets;
 *  there is no business rule allocating money to a target. */
export function atRiskExposure(tracked) {
  const atRisk = (tracked || []).filter((t) => AT_RISK_BUCKETS.includes(t.bucket));
  const byProject = new Map();

  for (const t of atRisk) {
    if (byProject.has(t.projectKey)) continue;
    byProject.set(t.projectKey, t.project?.bal || 0);
  }

  let money = 0;
  for (const balance of byProject.values()) money += balance;

  return { targetCount: atRisk.length, projectCount: byProject.size, money, targets: atRisk };
}

/** Distinct projects represented by a set of tracked targets. Used wherever a
 *  caption would otherwise say "projects" while counting targets. */
export function distinctProjectCount(tracked) {
  return new Set((tracked || []).map((t) => t.projectKey)).size;
}

/* ---------------- validation ---------------- */

/** What the panel calls `scope` on screen.
 *
 *  Deliberately not the label in TARGET_FIELDS below. That one is the string
 *  written into project_manual_update_audit.column_name — by the database
 *  functions, in SQL — and the audit trail is read back by matching on it.
 *  Renaming it would orphan every scope change ever recorded and every one
 *  recorded from here on, because the RPCs would keep writing 'Scope'. So the
 *  stored name stays, and only the display name changes. */
export const SCOPE_LABEL = "Balance Work";

/* field key -> the name this field is *stored* under in the audit trail */
export const TARGET_FIELDS = [
  ["scope", "Scope"],
  ["target_qty", "Target qty"],
  ["unit", "Unit"],
  ["start_date", "Start date"],
  ["target_completion", "Target completion"],
  ["actual_output", "Actual output"],
];

/** Actual completion is no longer editable: the database records it when an
 *  Actual output save first reaches Target qty. It remains in this history-only
 *  list so dates entered before that change keep their original place and
 *  label in the audit trail. */
export const TARGET_HISTORY_FIELDS = [
  ...TARGET_FIELDS.slice(0, 5),
  ["actual_completion", "Actual completion"],
  ...TARGET_FIELDS.slice(5),
];

const blank = (v) => v === null || v === undefined || String(v).trim() === "";

/** Validates one target as the modal would save it. `isNew` tightens the scope
 *  rule: newly created targets must be named, migrated ones legitimately have
 *  no scope yet and must stay editable regardless. */
export function validateTarget(values, { isNew = false } = {}) {
  const errors = {};

  if (isNew && blank(values.scope)) errors.scope = `${SCOPE_LABEL} is required for a new target.`;

  for (const [field, label] of [["target_qty", "Target qty"], ["actual_output", "Actual output"]]) {
    if (blank(values[field])) continue;
    const n = Number(values[field]);
    if (isNaN(n)) errors[field] = `${label} must be a number.`;
    else if (n < 0) errors[field] = `${label} cannot be negative.`;
  }

  for (const [field, label] of [
    ["start_date", "Start date"],
    ["target_completion", "Target completion"],
  ]) {
    if (!blank(values[field]) && parseDay(values[field]) === null)
      errors[field] = `${label} is not a valid date.`;
  }

  const start = values.start_date;
  if (!blank(start) && !errors.start_date) {
    if (!blank(values.target_completion) && !errors.target_completion
        && daysBetween(start, values.target_completion) < 0)
      errors.target_completion = "Target completion cannot fall before the start date.";
  }

  return errors;
}

/** Non-blocking observations shown beside a target in the modal. */
export function targetWarnings(values) {
  const warnings = [];
  const qty = num(values.target_qty), out = num(values.actual_output);
  if (qty !== null && out !== null && out > qty)
    warnings.push("Actual output is above the target quantity.");
  if (qty === 0)
    warnings.push("A zero target quantity is delivered when an Actual output is saved.");
  return warnings;
}
