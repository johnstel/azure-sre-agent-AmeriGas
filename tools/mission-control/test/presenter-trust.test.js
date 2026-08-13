const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrustedPresenterServerProof } = require('../presenter-trust');

function fakeIncidentStore(activeIncident) {
  return { getActive: () => activeIncident || null };
}

function fakeScheduledTaskEvidenceStore(evaluation) {
  return { evaluate: () => evaluation };
}

const HEALTHY_SNAPSHOT = { deployments: [], services: [], endpoints: [], networkPolicies: [], configMaps: [] };

test('readiness/baseline evidence comes from verifyBaselineState against a real cluster snapshot, never fabricated', async () => {
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(null),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore({ available: false }),
    collectClusterSnapshot: async () => HEALTHY_SNAPSHOT,
    verifyBaselineState: (snapshot) => {
      assert.equal(snapshot, HEALTHY_SNAPSHOT);
      return { ok: true, remaining: [] };
    },
    evaluateScenarioHealth: () => { throw new Error('should not be called without an active incident scenarioId'); },
    repoRoot: '/repo',
  });

  assert.equal(proof.baselineReady, true);
  assert.equal(proof.baselineHealthPass, true);
  assert.equal(proof.readiness.status, 'ready');
});

test('readiness/baseline fails CLOSED (never fabricates healthy) when verifyBaselineState reports missing resources', async () => {
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(null),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore({ available: false }),
    collectClusterSnapshot: async () => HEALTHY_SNAPSHOT,
    verifyBaselineState: () => ({ ok: false, remaining: ['mongodb: deployment missing'] }),
    evaluateScenarioHealth: () => null,
    repoRoot: '/repo',
  });

  assert.equal(proof.baselineReady, false);
  assert.equal(proof.readiness.status, 'degraded');
  assert.deepEqual(proof.readiness.remaining, ['mongodb: deployment missing']);
});

test('readiness/baseline fails CLOSED (never fabricates healthy) when the cluster is unreachable', async () => {
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(null),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore({ available: false }),
    collectClusterSnapshot: async () => { throw new Error('kubectl not found'); },
    verifyBaselineState: () => { throw new Error('should not be called -- no snapshot was obtained'); },
    evaluateScenarioHealth: () => null,
    repoRoot: '/repo',
  });

  assert.equal(proof.baselineReady, false);
  assert.equal(proof.readiness.status, 'unknown');
});

test('scenario evidence comes from evaluateScenarioHealth scoped to the active incident scenarioId, never a different scenario', async () => {
  const incident = { correlationId: 'INC-1', scenarioId: 'oom', milestones: [] };
  let evaluatedScenarioId = null;
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(incident),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore({ available: false }),
    collectClusterSnapshot: async () => HEALTHY_SNAPSHOT,
    verifyBaselineState: () => ({ ok: true, remaining: [] }),
    evaluateScenarioHealth: (scenarioId) => {
      evaluatedScenarioId = scenarioId;
      return { active: true, reason: 'tank-monitor is OOMKilled' };
    },
    repoRoot: '/repo',
  });

  assert.equal(evaluatedScenarioId, 'oom');
  assert.equal(proof.scenarioActive, true);
  assert.equal(proof.scenarioHealth.scenarioId, 'oom');
  assert.equal(proof.scenarioId, 'oom');
  assert.equal(proof.incidentCorrelationId, 'INC-1');
});

test('scenario evidence is null/inactive (never fabricated) when there is no active incident', async () => {
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(null),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore({ available: false }),
    collectClusterSnapshot: async () => HEALTHY_SNAPSHOT,
    verifyBaselineState: () => ({ ok: true, remaining: [] }),
    evaluateScenarioHealth: () => { throw new Error('should not be called -- no active incident'); },
    repoRoot: '/repo',
  });

  assert.equal(proof.scenarioActive, false);
  assert.equal(proof.scenarioId, null);
  assert.equal(proof.activeIncident, null);
});

test('approval/remediation/recovery/incident-value evidence is the REAL active incident record (with real milestones), not a synthesized stand-in', async () => {
  const incident = {
    correlationId: 'INC-42',
    scenarioId: 'mongodb',
    finalState: null,
    milestones: [
      { type: 'action_proposed', data: { actionKey: 'scale-mongodb', scenarioId: 'mongodb' } },
      { type: 'action_approved', data: { actionKey: 'scale-mongodb', approved: true } },
    ],
  };
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(incident),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore({ available: false }),
    collectClusterSnapshot: async () => HEALTHY_SNAPSHOT,
    verifyBaselineState: () => ({ ok: true, remaining: [] }),
    evaluateScenarioHealth: () => ({ active: true, reason: 'mongodb down' }),
    repoRoot: '/repo',
  });

  assert.equal(proof.activeIncident, incident);
  assert.equal(proof.incident, incident);
  assert.deepEqual(proof.activeIncident.milestones, incident.milestones);
});

test('scheduled-task evidence is populated independently and does not require any incident/cluster data to be present', async () => {
  const scheduledEvaluation = {
    available: true,
    taskId: 'daily-propane-health-report',
    promptVersionHash: 'abc123',
    threadId: 'THREAD-1',
    timestamp: new Date().toISOString(),
    status: 'Healthy',
  };
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(null),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore(scheduledEvaluation),
    collectClusterSnapshot: async () => { throw new Error('cluster unreachable'); },
    verifyBaselineState: () => { throw new Error('should not be called'); },
    evaluateScenarioHealth: () => null,
    repoRoot: '/repo',
  });

  assert.equal(proof.scheduledTaskAvailable, true);
  assert.deepEqual(proof.scheduledTaskEvidence, scheduledEvaluation);
  // Cluster being entirely unreachable must not affect the scheduled-task
  // evidence, and vice versa -- each gate kind's evidence is independent.
  assert.equal(proof.baselineReady, false);
});

test('an available scheduled-task evidence result does NOT make readiness/baseline/scenario/incident evidence appear available -- gates never cross-contaminate', async () => {
  const scheduledEvaluation = { available: true, taskId: 't', promptVersionHash: 'h', threadId: 'th', timestamp: new Date().toISOString(), status: 'Healthy' };
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(null),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore(scheduledEvaluation),
    collectClusterSnapshot: async () => { throw new Error('cluster unreachable'); },
    verifyBaselineState: () => { throw new Error('should not be called'); },
    evaluateScenarioHealth: () => null,
    repoRoot: '/repo',
  });

  assert.equal(proof.scheduledTaskAvailable, true);
  assert.equal(proof.baselineReady, false);
  assert.equal(proof.scenarioActive, false);
  assert.equal(proof.activeIncident, null);
});

test('a real active incident does NOT make scheduled-task evidence appear available -- gates never cross-contaminate in the other direction', async () => {
  const incident = { correlationId: 'INC-1', scenarioId: 'oom', milestones: [] };
  const proof = await buildTrustedPresenterServerProof({
    incidentStore: fakeIncidentStore(incident),
    scheduledTaskEvidenceStore: fakeScheduledTaskEvidenceStore({ available: false, reason: 'no scheduled-task execution evidence has been recorded yet' }),
    collectClusterSnapshot: async () => HEALTHY_SNAPSHOT,
    verifyBaselineState: () => ({ ok: true, remaining: [] }),
    evaluateScenarioHealth: () => ({ active: true, reason: 'active' }),
    repoRoot: '/repo',
  });

  assert.equal(proof.activeIncident, incident);
  assert.equal(proof.scenarioActive, true);
  assert.equal(proof.scheduledTaskAvailable, false);
});

test('gracefully handles missing/undefined dependencies without throwing (defensive defaults, never fabricated success)', async () => {
  const proof = await buildTrustedPresenterServerProof({});
  assert.equal(proof.baselineReady, false);
  assert.equal(proof.scenarioActive, false);
  assert.equal(proof.scheduledTaskAvailable, false);
  assert.equal(proof.activeIncident, null);
});
