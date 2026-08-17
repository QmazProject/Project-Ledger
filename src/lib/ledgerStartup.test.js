import test from "node:test";
import assert from "node:assert/strict";
import {
  beginLedgerStartup,
  getLedgerStartupMetrics,
  ledgerReadiness,
  measureLedgerWork,
  resetLedgerStartupMetrics,
  startLedgerTiming,
} from "./ledgerStartup.js";

test("startup timings retain only approved non-sensitive fields", () => {
  resetLedgerStartupMetrics();
  const finish = startLedgerTiming("dataset.request_and_json");
  finish({ outcome: "ok", projectCount: 42, username: "must-not-appear", error: "must-not-appear" });

  const [entry] = getLedgerStartupMetrics();
  assert.equal(entry.stage, "dataset.request_and_json");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.projectCount, 42);
  assert.equal("username" in entry, false);
  assert.equal("error" in entry, false);
});

test("a timing can finish only once", () => {
  resetLedgerStartupMetrics();
  const finish = startLedgerTiming("manual.request_and_json");
  finish({ outcome: "ok", manualCount: 2 });
  finish({ outcome: "error" });
  assert.equal(getLedgerStartupMetrics().length, 1);
});

test("synchronous work returns its value and is measured", () => {
  resetLedgerStartupMetrics();
  assert.equal(measureLedgerWork("dataset.deserialise", () => 7), 7);
  assert.equal(getLedgerStartupMetrics()[0].outcome, "ok");
});

test("readiness fails closed until authoritative prerequisites are ready", () => {
  const loading = ledgerReadiness({
    datasetStatus: "ready", manualStatus: "loading", targetsStatus: "ready",
    profileStatus: "ready", forcePasswordChange: false,
  });
  assert.equal(loading.coreReady, false);
  assert.equal(loading.mutationsReady, false);
  assert.equal(loading.targetMutationsReady, false);

  const ready = ledgerReadiness({
    datasetStatus: "ready", manualStatus: "ready", targetsStatus: "ready",
    profileStatus: "ready", forcePasswordChange: false,
  });
  assert.equal(ready.mutationsReady, true);
  assert.equal(ready.targetMutationsReady, true);

  const passwordLocked = ledgerReadiness({
    datasetStatus: "ready", manualStatus: "ready", targetsStatus: "ready",
    profileStatus: "ready", forcePasswordChange: true,
  });
  assert.equal(passwordLocked.mutationsReady, false);
  assert.equal(passwordLocked.targetMutationsReady, false);
});

test("beginning a new authenticated startup clears older entries", () => {
  resetLedgerStartupMetrics();
  startLedgerTiming("old")();
  beginLedgerStartup();
  assert.deepEqual(getLedgerStartupMetrics(), []);
});
