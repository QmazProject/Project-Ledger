/* Each DTR page has its own address, and an address never opens a page its visitor may not see. */

import test from "node:test";
import assert from "node:assert/strict";
import { DTR_HOME, isDtrPath, dtrRouteOf, dtrPathOf, dtrTitleOf, dtrScreenFor } from "./dtrRoutes.js";

const signedOut = { signedIn: false, viewOnly: false, isAdmin: false };
const firstRun = { signedIn: false, viewOnly: false, isAdmin: true };
const employee = { signedIn: true, viewOnly: false, isAdmin: false };
const admin = { signedIn: true, viewOnly: false, isAdmin: true };
const adminReading = { signedIn: true, viewOnly: true, isAdmin: true };

test("every DTR page sits under /dtr, apart from the ledger's own addresses", () => {
  assert.equal(DTR_HOME, "/dtr");
  for (const p of ["/dtr", "/dtr/", "/dtr/punch", "/dtr/my-dtr", "/DTR/Punch", "/dtr/nonsense"]) {
    assert.equal(isDtrPath(p), true, p);
  }
  for (const p of ["/", "", "/login", "/project-ledger", "/reset-password", "/dtrx", "/dtr-old", undefined]) {
    assert.equal(isDtrPath(p), false, String(p));
  }
});

test("each screen has one address, and the address reads back as that screen", () => {
  const screens = [
    ["lock", false, "/dtr/sign-in"],
    ["punch", false, "/dtr/punch"],
    ["dtr", false, "/dtr/my-dtr"],
    ["dtr", true, "/dtr/their-dtr"],
    ["logbook", false, "/dtr/logbook"],
    ["logbook", true, "/dtr/logbook"],
    ["settings", false, "/dtr/settings"],
  ];
  for (const [view, viewOnly, path] of screens) {
    assert.equal(dtrPathOf(view, viewOnly), path, `${view} viewOnly=${viewOnly}`);
  }
  assert.equal(dtrRouteOf("/dtr/sign-in"), "lock");
  assert.equal(dtrRouteOf("/dtr/punch"), "punch");
  assert.equal(dtrRouteOf("/dtr/my-dtr"), "dtr");
  assert.equal(dtrRouteOf("/dtr/their-dtr"), "their-dtr");
  assert.equal(dtrRouteOf("/dtr/logbook/"), "logbook", "a trailing slash is the same page");
  assert.equal(dtrRouteOf("/DTR/Settings"), "settings", "capitals are the same page");
});

test("/dtr itself, an unknown page and ledger addresses ask for no particular page", () => {
  for (const p of ["/dtr", "/dtr/", "/dtr/nonsense", "/login", "/", ""]) assert.equal(dtrRouteOf(p), "", p);
});

test("the browser tab names the page, and never calls someone else's record 'My DTR'", () => {
  assert.equal(dtrTitleOf("punch", false), "Punch · DTR");
  assert.equal(dtrTitleOf("dtr", false), "My DTR");
  assert.equal(dtrTitleOf("dtr", true), "Their DTR");
  assert.equal(dtrTitleOf("lock", false), "Sign in · DTR");
});

test("signed out, every address shows the sign-in page — typing /dtr/punch cannot skip the passcode", () => {
  for (const route of ["", "lock", "punch", "dtr", "their-dtr", "logbook", "settings"]) {
    assert.equal(dtrScreenFor(route, signedOut), "lock", route);
  }
});

test("while nobody is set up yet, Settings opens without signing in so the system can be bootstrapped", () => {
  assert.equal(dtrScreenFor("settings", firstRun), "settings");
  assert.equal(dtrScreenFor("punch", firstRun), "lock");
});

test("signed in, the sign-in page and /dtr go to Punch, as signing in does", () => {
  assert.equal(dtrScreenFor("lock", employee), "punch");
  assert.equal(dtrScreenFor("", employee), "punch");
  assert.equal(dtrScreenFor("punch", employee), "punch");
  assert.equal(dtrScreenFor("dtr", employee), "dtr");
  assert.equal(dtrScreenFor("logbook", employee), "logbook");
  assert.equal(dtrScreenFor("settings", employee), "settings", "everyone reaches Settings for their own passcode");
});

test("an admin reading someone's DTR cannot be sent to Punch or the sign-in page by an address", () => {
  assert.equal(dtrScreenFor("punch", adminReading), "dtr");
  assert.equal(dtrScreenFor("lock", adminReading), "dtr");
  assert.equal(dtrScreenFor("", adminReading), "dtr");
  assert.equal(dtrScreenFor("dtr", adminReading), "dtr");
  assert.equal(dtrScreenFor("their-dtr", adminReading), "dtr");
  assert.equal(dtrScreenFor("logbook", adminReading), "logbook");
  assert.equal(dtrScreenFor("settings", adminReading), "settings");
});

test("their-dtr with nobody being read (a refresh) returns to Settings, never the admin's own record under that name", () => {
  assert.equal(dtrScreenFor("their-dtr", admin), "settings");
  assert.equal(dtrScreenFor("their-dtr", employee), "settings");
});
