/* The staff logbook is kept per department, and a department is the project site an
   employee works under. Sites are typed by hand, so "Head Office" and "head office "
   are one department: grouping is on a normalised key, and each group is shown with
   the spelling most of its members use. Nobody falls into a default department —
   staff with no site set form their own group, listed last. */

export const NO_SITE_KEY = "";

const tidy = (site) => String(site || "").trim().replace(/\s+/g, " ");
export const siteKey = (site) => tidy(site).toLowerCase();

/* `staff` keeps its order inside each group (the sheet's first-stamp order) */
export function groupStaffBySite(staff) {
  const groups = new Map();
  staff.forEach((emp) => {
    const key = siteKey(emp.site);
    if (!groups.has(key)) groups.set(key, { key, staff: [], spellings: new Map() });
    const g = groups.get(key);
    g.staff.push(emp);
    const shown = tidy(emp.site);
    g.spellings.set(shown, (g.spellings.get(shown) || 0) + 1);
  });
  return [...groups.values()]
    .map(({ key, staff: members, spellings }) => ({
      key,
      staff: members,
      /* a stable sort keeps the first-seen spelling when counts tie */
      label: [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }))
    .sort((a, b) => (a.key === NO_SITE_KEY) - (b.key === NO_SITE_KEY) || a.label.localeCompare(b.label));
}

/* the paper form holds a fixed number of rows; past that a group carries on to another page */
export const pagesOf = (members, perPage) => (members.length
  ? Array.from({ length: Math.ceil(members.length / perPage) }, (_, i) => members.slice(i * perPage, (i + 1) * perPage))
  : [[]]);

/* The site an employee is saved under when they type one: a site colleagues already
   use is taken in the spelling that department is listed under, so one department is
   not listed twice. */
export function canonicalSite(typed, roster, selfId) {
  const clean = tidy(typed);
  if (!clean) return "";
  const dept = groupStaffBySite((roster || []).filter((e) => e.id !== selfId))
    .find((g) => g.key === siteKey(clean));
  return dept ? dept.label : clean;
}
