/* Every DTR page has its own web address, all under /dtr so none of them can clash
   with the Project Ledger's /login, /project-ledger and /reset-password. An address
   only says which page is wanted; it never proves who you are. Typing /dtr/punch while
   signed out still lands on the sign-in page, because the passcode is the only thing
   that opens an ID — dtrScreenFor decides what a request may actually show.

   "their-dtr" is not a page of its own: it is My DTR while an admin reads someone
   else's record. It gets its own address so the bar never claims "my-dtr" for a
   record that is not the viewer's. */

export const DTR_HOME = "/dtr";

const ROUTES = [
  { route: "lock", path: "/dtr/sign-in", title: "Sign in · DTR" },
  { route: "punch", path: "/dtr/punch", title: "Punch · DTR" },
  { route: "dtr", path: "/dtr/my-dtr", title: "My DTR" },
  { route: "their-dtr", path: "/dtr/their-dtr", title: "Their DTR" },
  { route: "logbook", path: "/dtr/logbook", title: "Staff logbook · DTR" },
  { route: "settings", path: "/dtr/settings", title: "Settings · DTR" },
];

const trimmed = (pathname) => String(pathname || "").replace(/\/+$/, "").toLowerCase();

export const isDtrPath = (pathname) => {
  const p = trimmed(pathname);
  return p === DTR_HOME || p.startsWith(`${DTR_HOME}/`);
};

/* "" for /dtr itself, an unknown /dtr/… address, or anywhere outside the DTR */
export const dtrRouteOf = (pathname) => (ROUTES.find((r) => r.path === trimmed(pathname)) || {}).route || "";

const routeOfScreen = (view, viewOnly) => (view === "dtr" && viewOnly ? "their-dtr" : view);
const entryOf = (view, viewOnly) => ROUTES.find((r) => r.route === routeOfScreen(view, viewOnly)) || ROUTES[0];

export const dtrPathOf = (view, viewOnly) => entryOf(view, viewOnly).path;
export const dtrTitleOf = (view, viewOnly) => entryOf(view, viewOnly).title;

/* The page a requested route may show, given who is signed in. Mirrors the tab buttons:
   - signed out → sign in; Settings only while nobody is set up yet (isAdmin)
   - signed in → never the sign-in page; it goes to Punch, as signing in does
   - reading someone else's DTR → their DTR or the logbook (Settings if admin);
     Punch is not theirs to press
   - their-dtr when nobody is being read (a refresh, Back after Close) → Settings,
     where the admin picked whom to view: who it was is not in the address. */
export function dtrScreenFor(route, { signedIn, viewOnly, isAdmin }) {
  const canSettings = !!isAdmin || (signedIn && !viewOnly);
  if (route === "settings" && canSettings) return "settings";
  if (!signedIn) return "lock";
  if (viewOnly) return route === "logbook" ? "logbook" : "dtr";
  if (route === "their-dtr") return "settings";
  return route === "dtr" || route === "logbook" ? route : "punch";
}
