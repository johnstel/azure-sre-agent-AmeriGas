const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssertionScheduler } = require('../assertion-scheduler');
const { createIncidentStore } = require('../incident-store');
const { FINAL_STATE } = require('../incident-timeline');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-assertion-scheduler-'));
  return path.join(dir, 'incidents.json');
}

test('schedule() persists a pending descriptor and runs the assertion after the delay, recording a passing result', async () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'oom' });
  store.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  store.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'test' });
  store.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: true });

  const scheduler = createAssertionScheduler({
    incidentStore: store,
    checkScenarioHealth: async () => ({ active: false, reason: 'healthy' }),
  });

  scheduler.schedule(incident.correlationId, 'oom', 'fix_all::{}', 20);
  assert.equal(store.hasPendingAssertion(incident.correlationId), true);

  await wait(60);

  const stored = store.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.RECOVERED);
  assert.equal(store.hasPendingAssertion(incident.correlationId), false);
});

test('schedule() records partial_recovery when the assertion comes back negative', async () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'mongodb' });
  store.proposeAction(incident.correlationId, { actionKey: 'fix_network::{}', toolName: 'fix_network' });
  store.approveAction(incident.correlationId, { actionKey: 'fix_network::{}', approver: 'test' });
  store.recordActionResult(incident.correlationId, { actionKey: 'fix_network::{}', toolName: 'fix_network', success: true });

  const scheduler = createAssertionScheduler({
    incidentStore: store,
    checkScenarioHealth: async () => ({ active: true, reason: 'mongodb still down' }),
  });

  scheduler.schedule(incident.correlationId, 'mongodb', 'fix_network::{}', 20);
  await wait(60);

  const stored = store.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.PARTIAL_RECOVERY);
});

test('schedule() retries with a backoff instead of giving up when the cluster is transiently unreachable, then succeeds once reachable', async () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'oom' });
  store.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  store.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'test' });
  store.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: true });

  let callCount = 0;
  const scheduler = createAssertionScheduler({
    incidentStore: store,
    retryDelayMs: 15,
    checkScenarioHealth: async () => {
      callCount += 1;
      if (callCount < 3) return null; // transiently unreachable
      return { active: false, reason: 'healthy' };
    },
  });

  scheduler.schedule(incident.correlationId, 'oom', 'fix_all::{}', 10);
  await wait(120);

  assert.ok(callCount >= 3, `expected at least 3 attempts, got ${callCount}`);
  const stored = store.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.RECOVERED, 'a transient outage must not permanently prevent a truthful outcome once the cluster is reachable again');
  assert.equal(store.hasPendingAssertion(incident.correlationId), false);
});

test('runNow() resolves the pending descriptor without recording an assertion when the incident has already gone terminal (a late/stale callback)', async () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'oom' });
  store.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  store.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'test' });
  store.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: true });
  store.schedulePendingAssertion(incident.correlationId, { actionKey: 'fix_all::{}', scenarioId: 'oom', dueAt: Date.now() + 5000 });

  // The incident is denied via a completely different path before the assertion ever runs.
  store.finalize(incident.correlationId, FINAL_STATE.DENIED, {});

  let checkCalled = false;
  const scheduler = createAssertionScheduler({
    incidentStore: store,
    checkScenarioHealth: async () => { checkCalled = true; return { active: false, reason: 'healthy' }; },
  });

  await scheduler.runNow(incident.correlationId, 'oom', 'fix_all::{}');

  assert.equal(checkCalled, false, 'a terminal incident must never trigger a cluster health check for a stale assertion');
  const stored = store.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.DENIED, 'the original final state must be preserved');
});

test('rehydrate() reschedules every unresolved descriptor and runs an already-overdue one promptly', async () => {
  const filePath = tempFilePath();
  const store = createIncidentStore({ filePath });
  const incident = store.activate({ scenarioId: 'oom' });
  store.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  store.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'test' });
  store.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: true });
  // Persist a descriptor that is already overdue (dueAt in the past).
  store.schedulePendingAssertion(incident.correlationId, { actionKey: 'fix_all::{}', scenarioId: 'oom', dueAt: Date.now() - 5000 });

  const scheduler = createAssertionScheduler({
    incidentStore: store,
    checkScenarioHealth: async () => ({ active: false, reason: 'healthy' }),
  });

  const rehydratedCount = scheduler.rehydrate();
  assert.equal(rehydratedCount, 1);

  await wait(30);

  const stored = store.getIncident(incident.correlationId);
  assert.equal(stored.finalState, FINAL_STATE.RECOVERED, 'an overdue rehydrated assertion must run promptly, not wait out a full interval');
});

// --- Restart simulation tests ---
// These simulate a real Mission Control process restart: schedule an
// assertion against one incidentStore/scheduler instance (backed by a real
// file), then — WITHOUT ever letting that instance's in-memory timer fire —
// construct a brand-new incidentStore + assertion scheduler pointed at the
// same file (as server.js does on startup) and rehydrate from it.

test('restart: a pending assertion scheduled before "shutdown" is found and resolved by a freshly rehydrated scheduler after "restart"', async () => {
  const filePath = tempFilePath();

  // --- "Before restart" process ---
  // We deliberately use schedulePendingAssertion() directly here instead of
  // scheduler.schedule() — the latter would set a REAL in-memory setTimeout
  // in *this* test process, which nothing can "kill" to simulate a crash.
  // A real restart means the old process's timers are gone entirely; only
  // the persisted descriptor survives for the new process to find. This is
  // exactly what schedulePendingAssertion() (which schedule() also calls
  // internally before setting its own timer) represents on its own.
  const storeBefore = createIncidentStore({ filePath });
  const incident = storeBefore.activate({ scenarioId: 'oom', scenarioName: 'OOMKilled' });
  storeBefore.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  storeBefore.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'operator' });
  storeBefore.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: true });
  // Overdue by construction — real wall-clock time elapsed while the
  // process was down, past when the assertion was originally due.
  storeBefore.schedulePendingAssertion(incident.correlationId, { actionKey: 'fix_all::{}', scenarioId: 'oom', dueAt: Date.now() - 1000 });
  assert.equal(storeBefore.hasPendingAssertion(incident.correlationId), true);

  // --- Simulated restart: brand-new store + scheduler, same file ---
  const storeAfter = createIncidentStore({ filePath });
  const activeAfterRestart = storeAfter.getActive();
  assert.ok(activeAfterRestart, 'the active incident must survive the simulated restart');
  assert.equal(activeAfterRestart.correlationId, incident.correlationId);
  assert.equal(storeAfter.hasPendingAssertion(incident.correlationId), true, 'the pending assertion must also survive the restart (no permanent pending state left unresolved)');

  const schedulerAfter = createAssertionScheduler({
    incidentStore: storeAfter,
    checkScenarioHealth: async () => ({ active: false, reason: 'healthy' }),
  });
  const rehydratedCount = schedulerAfter.rehydrate();
  assert.equal(rehydratedCount, 1);

  await wait(30);

  const finalIncident = storeAfter.getIncident(incident.correlationId);
  assert.equal(finalIncident.finalState, FINAL_STATE.RECOVERED, 'rehydration after restart must reach a truthful eventual outcome');
  assert.equal(storeAfter.hasPendingAssertion(incident.correlationId), false, 'no pending state should remain after the rehydrated assertion resolves');
  assert.equal(finalIncident.milestones.filter((m) => m.type === 'post_action_assertion').length, 1, 'exactly one assertion milestone must exist — no duplicates from the restart');
});

test('restart: an overdue pending assertion that comes back negative produces partial_recovery after rehydration, never a fabricated recovered', async () => {
  const filePath = tempFilePath();

  const storeBefore = createIncidentStore({ filePath });
  const incident = storeBefore.activate({ scenarioId: 'mongodb' });
  storeBefore.proposeAction(incident.correlationId, { actionKey: 'fix_network::{}', toolName: 'fix_network' });
  storeBefore.approveAction(incident.correlationId, { actionKey: 'fix_network::{}', approver: 'operator' });
  storeBefore.recordActionResult(incident.correlationId, { actionKey: 'fix_network::{}', toolName: 'fix_network', success: true });
  // Persist directly with an overdue dueAt, simulating that enough real
  // time passed while the process was down that the assertion is overdue
  // by the time it restarts.
  storeBefore.schedulePendingAssertion(incident.correlationId, { actionKey: 'fix_network::{}', scenarioId: 'mongodb', dueAt: Date.now() - 1000 });

  const storeAfter = createIncidentStore({ filePath });
  const schedulerAfter = createAssertionScheduler({
    incidentStore: storeAfter,
    checkScenarioHealth: async () => ({ active: true, reason: 'mongodb pod still not Running/Ready' }),
  });
  const rehydratedCount = schedulerAfter.rehydrate();
  assert.equal(rehydratedCount, 1);

  await wait(30);

  const finalIncident = storeAfter.getIncident(incident.correlationId);
  assert.equal(finalIncident.finalState, FINAL_STATE.PARTIAL_RECOVERY);
  assert.notEqual(finalIncident.finalState, FINAL_STATE.RECOVERED);
});

test('restart: a pending assertion for an incident that was finalized (e.g. denied) before shutdown is cleared and never re-executed after restart', async () => {
  const filePath = tempFilePath();

  const storeBefore = createIncidentStore({ filePath });
  const incident = storeBefore.activate({ scenarioId: 'oom' });
  storeBefore.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  storeBefore.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'operator' });
  storeBefore.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: true });
  storeBefore.schedulePendingAssertion(incident.correlationId, { actionKey: 'fix_all::{}', scenarioId: 'oom', dueAt: Date.now() + 60_000 });
  // The run then gets finalized through an unrelated path (e.g. a second,
  // conflicting fix attempt failed and finalized it as FAILED) before the
  // process restarts.
  storeBefore.finalize(incident.correlationId, FINAL_STATE.FAILED, { reason: 'unrelated failure' });

  const storeAfter = createIncidentStore({ filePath });
  assert.equal(storeAfter.getActive(), null, 'a terminal incident must not be reported as active after restart');
  assert.equal(storeAfter.listUnresolvedPendingAssertions().length, 0, 'a terminal incident must retain no unresolved pending assertions to rehydrate');

  let checkCalled = false;
  const schedulerAfter = createAssertionScheduler({
    incidentStore: storeAfter,
    checkScenarioHealth: async () => { checkCalled = true; return { active: false, reason: 'healthy' }; },
  });
  const rehydratedCount = schedulerAfter.rehydrate();

  assert.equal(rehydratedCount, 0, 'nothing should be rehydrated for an already-terminal incident');
  await wait(20);
  assert.equal(checkCalled, false, 'no cluster health check should ever run for a pending assertion that belonged to a terminal incident');

  const finalIncident = storeAfter.getIncident(incident.correlationId);
  assert.equal(finalIncident.finalState, FINAL_STATE.FAILED, 'the original terminal state must be untouched');
});

test('restart: rescheduling twice (e.g. two rapid restarts) never produces duplicate assertion milestones', async () => {
  const filePath = tempFilePath();
  const storeBefore = createIncidentStore({ filePath });
  const incident = storeBefore.activate({ scenarioId: 'oom' });
  storeBefore.proposeAction(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all' });
  storeBefore.approveAction(incident.correlationId, { actionKey: 'fix_all::{}', approver: 'operator' });
  storeBefore.recordActionResult(incident.correlationId, { actionKey: 'fix_all::{}', toolName: 'fix_all', success: true });
  storeBefore.schedulePendingAssertion(incident.correlationId, { actionKey: 'fix_all::{}', scenarioId: 'oom', dueAt: Date.now() - 1000 });

  // Simulate two independent processes/instances both rehydrating from the
  // same on-disk state at nearly the same time (e.g. a rapid double
  // restart before either had a chance to persist a resolution).
  const storeA = createIncidentStore({ filePath });
  const storeB = createIncidentStore({ filePath });
  const schedulerA = createAssertionScheduler({ incidentStore: storeA, checkScenarioHealth: async () => ({ active: false, reason: 'healthy' }) });
  const schedulerB = createAssertionScheduler({ incidentStore: storeB, checkScenarioHealth: async () => ({ active: false, reason: 'healthy' }) });

  schedulerA.rehydrate();
  schedulerB.rehydrate();
  await wait(30);

  // Re-read from disk (whichever store persisted last) to check the final,
  // durable state has exactly one assertion milestone.
  const finalStore = createIncidentStore({ filePath });
  const finalIncident = finalStore.getIncident(incident.correlationId);
  const assertionMilestones = finalIncident.milestones.filter((m) => m.type === 'post_action_assertion');
  assert.equal(assertionMilestones.length, 1, 'concurrent rehydration must never produce duplicate assertion milestones');
  assert.equal(finalIncident.finalState, FINAL_STATE.RECOVERED);
});
