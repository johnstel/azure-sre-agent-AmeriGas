const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TRACK_CATALOG,
  createPresenterStateMachine,
  evaluateGate,
  sanitizePresenterNotes,
  buildPresenterRehearsal,
} = require('../presenter-mode');
const { app, presenterStateMachine, sanitizePresenterRequestBody } = require('../server');

function createMemoryStore(initialState = null) {
  let currentState = initialState;
  return {
    read: () => currentState,
    write: (nextState) => {
      currentState = nextState;
      return currentState;
    },
  };
}

function trustedServerProof(overrides = {}) {
  return {
    correlationId: 'RUN-TEST',
    baselineReady: true,
    readiness: { status: 'ready', healthy: true, ready: true },
    cleanBaseline: true,
    scenarioId: 'mongodb',
    scenarioHealth: { scenarioId: 'mongodb', active: true },
    incidentCorrelationId: 'INC-TEST',
    activeIncident: {
      correlationId: 'INC-TEST',
      scenarioId: 'mongodb',
      finalState: 'active',
      milestones: [],
    },
    ...overrides,
  };
}

test('shared presenter catalog contains the required Fast Wow and Deep Dive tracks with valid schema metadata', () => {
  assert.equal(TRACK_CATALOG.schemaVersion, 1);
  assert.equal(TRACK_CATALOG.gateIds.includes('native-sre-agent-investigation'), true);
  assert.equal(TRACK_CATALOG.gateIds.includes('scheduled-task-evidence'), true);
  const trackIds = TRACK_CATALOG.tracks.map((track) => track.id);
  assert.equal(trackIds.includes('fast-wow'), true);
  assert.equal(trackIds.includes('deep-dive'), true);
  assert.equal(TRACK_CATALOG.tracks[0].durationMinutes <= 7, true);
  assert.equal(TRACK_CATALOG.tracks[1].durationMinutes >= 20 && TRACK_CATALOG.tracks[1].durationMinutes <= 25, true);
  assert.equal(TRACK_CATALOG.panelIds.includes('presenter-panel'), true);
  assert.equal(TRACK_CATALOG.actionIds.includes('continue'), true);
});

test('malicious client gate truth is rejected and trusted server proof is required to unlock a step', () => {
  const machine = createPresenterStateMachine({ storage: createMemoryStore() });

  const blockedStart = machine.startTrack('fast-wow', {
    correlationId: 'RUN-0001',
    gateContext: { baselineReady: true, ready: true },
  });
  assert.equal(blockedStart.ok, false);
  assert.match(blockedStart.reason, /client-supplied presenter gate truth|gateContext/i);

  const started = machine.startTrack('fast-wow', {
    correlationId: 'RUN-0001',
    serverProof: trustedServerProof({ correlationId: 'RUN-0001' }),
  });
  assert.equal(started.ok, true);
  assert.equal(started.state.status, 'running');
  assert.equal(started.state.currentStepId, 'readiness');

  const blockedContinue = machine.continueStep({
    correlationId: 'RUN-0001',
    gateContext: { baselineReady: false },
  });
  assert.equal(blockedContinue.ok, false);
  assert.match(blockedContinue.reason, /client-supplied presenter gate truth|gateContext/i);

  const goodContinue = machine.continueStep({
    correlationId: 'RUN-0001',
    serverProof: trustedServerProof({ correlationId: 'RUN-0001', baselineReady: true }),
  });
  assert.equal(goodContinue.ok, true);
  assert.equal(goodContinue.state.currentStepId, 'baseline-health');

  const rejectedFields = sanitizePresenterRequestBody({
    gateContext: { ready: true },
    baselineReady: true,
    actionKey: 'remediate',
    force: true,
    focusedPanels: ['incident-panel'],
    evidenceReady: true,
    approvalStatus: 'approved',
  });
  assert.equal(rejectedFields.clean.trackId, undefined);
  assert.ok(rejectedFields.rejected.includes('gateContext'));
  assert.ok(rejectedFields.rejected.includes('baselineReady'));
  assert.ok(rejectedFields.rejected.includes('actionKey'));
  assert.ok(rejectedFields.rejected.includes('force'));
  assert.ok(rejectedFields.rejected.includes('focusedPanels'));
});

test('stale callbacks, mismatched incidents, and out-of-order assertions are rejected before a step can advance', () => {
  const machine = createPresenterStateMachine({ storage: createMemoryStore() });
  machine.startTrack('fast-wow', {
    correlationId: 'RUN-0002',
    serverProof: trustedServerProof({ correlationId: 'RUN-0002', baselineReady: true }),
  });

  const stale = machine.continueStep({
    correlationId: 'RUN-9999',
    serverProof: trustedServerProof({ correlationId: 'RUN-9999', baselineReady: true }),
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /stale|different presenter run/i);

  const mismatch = evaluateGate(
    { gate: { kind: 'scenario', action: 'continue' } },
    { serverProof: { scenarioHealth: { scenarioId: 'service', active: true } } },
    { correlationId: 'RUN-0002', scenarioId: 'mongodb' },
  );
  assert.equal(mismatch.allowed, false);
  assert.match(mismatch.reason, /scenario assertion mismatch|inactive scenario/i);
});

test('exact action binding is required for approval, remediation, and recovery gates and rejects other action milestones', () => {
  const machine = createPresenterStateMachine({ storage: createMemoryStore() });
  const actionKey = 'mongo-restart-incident-42';
  const incident = {
    correlationId: 'INC-EXACT',
    scenarioId: 'mongodb',
    finalState: 'recovered',
    milestones: [
      { type: 'action_proposed', data: { actionKey, key: actionKey, scenarioId: 'mongodb' } },
      { type: 'action_approved', data: { actionKey, approved: true, scenarioId: 'mongodb' } },
      { type: 'action_result', data: { actionKey, success: true, scenarioId: 'mongodb' } },
      { type: 'post_action_assertion', data: { actionKey, passed: true, scenarioId: 'mongodb' } },
    ],
  };
  const proof = trustedServerProof({
    correlationId: 'RUN-EXACT',
    scenarioId: 'mongodb',
    incidentCorrelationId: 'INC-EXACT',
    activeIncident: incident,
    baselineReady: true,
    nativeEvidenceAvailable: true,
    scenarioHealth: { scenarioId: 'mongodb', active: true },
  });

  const started = machine.startTrack('fast-wow', { correlationId: 'RUN-EXACT', serverProof: proof });
  assert.equal(started.ok, true);

  const approvalStep = machine.getTrackById('fast-wow').steps.find((step) => step.id === 'review-approval');
  const remediationStep = machine.getTrackById('fast-wow').steps.find((step) => step.id === 'exact-remediation');
  const recoveryStep = machine.getTrackById('fast-wow').steps.find((step) => step.id === 'verified-recovery');

  assert.equal(evaluateGate(approvalStep, { serverProof: proof }, { correlationId: 'RUN-EXACT', scenarioId: 'mongodb', incidentCorrelationId: 'INC-EXACT' }).allowed, true);
  assert.equal(evaluateGate(remediationStep, { serverProof: proof }, { correlationId: 'RUN-EXACT', scenarioId: 'mongodb', incidentCorrelationId: 'INC-EXACT' }).allowed, true);
  assert.equal(evaluateGate(recoveryStep, { serverProof: proof }, { correlationId: 'RUN-EXACT', scenarioId: 'mongodb', incidentCorrelationId: 'INC-EXACT' }).allowed, true);

  const otherActionProof = {
    ...proof,
    activeIncident: {
      ...incident,
      milestones: [
        { type: 'action_proposed', data: { actionKey: 'other-action', key: 'other-action', scenarioId: 'mongodb' } },
        { type: 'action_approved', data: { actionKey: 'other-action', approved: true, scenarioId: 'mongodb' } },
      ],
    },
  };
  const blockedOtherAction = evaluateGate(approvalStep, { serverProof: otherActionProof }, { correlationId: 'RUN-EXACT', scenarioId: 'mongodb', incidentCorrelationId: 'INC-EXACT', expectedActionKey: actionKey });
  assert.equal(blockedOtherAction.allowed, false);
  assert.match(blockedOtherAction.reason, /exact action key|mismatch|stale|blocked/i);

  const missingKeyProof = {
    ...proof,
    activeIncident: {
      ...incident,
      milestones: [
        { type: 'action_approved', data: { approved: true, scenarioId: 'mongodb' } },
      ],
    },
  };
  const blockedMissingKey = evaluateGate(approvalStep, { serverProof: missingKeyProof }, { correlationId: 'RUN-EXACT', scenarioId: 'mongodb', incidentCorrelationId: 'INC-EXACT', expectedActionKey: actionKey });
  assert.equal(blockedMissingKey.allowed, false);
  assert.match(blockedMissingKey.reason, /exact action key|missing|mismatch|stale/i);

  const staleActionProof = {
    ...proof,
    correlationId: 'RUN-STALE',
    activeIncident: {
      ...incident,
      correlationId: 'INC-OLD',
    },
  };
  const blockedStaleAction = evaluateGate(approvalStep, { serverProof: staleActionProof }, { correlationId: 'RUN-EXACT', scenarioId: 'mongodb', incidentCorrelationId: 'INC-EXACT', expectedActionKey: actionKey });
  assert.equal(blockedStaleAction.allowed, false);
  assert.match(blockedStaleAction.reason, /stale|another/i);
});

test('pause, resume, reconnect, abort, and reset remain idempotent and restore the clean baseline safely', () => {
  const machine = createPresenterStateMachine({ storage: createMemoryStore() });
  machine.startTrack('deep-dive', {
    correlationId: 'RUN-0003',
    serverProof: trustedServerProof({ correlationId: 'RUN-0003', baselineReady: true }),
  });

  const pauseA = machine.pause({ notesVisible: true });
  assert.equal(pauseA.ok, true);
  assert.equal(pauseA.state.status, 'paused');
  assert.equal(machine.pause({}).ok, true);

  const resumed = machine.resume({ focusMode: true });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.state.status, 'running');
  assert.equal(machine.resume({}).ok, true);

  const reconnected = machine.reconnect({ notesVisible: true, focusMode: true, lastEvent: 'reconnected' });
  assert.equal(reconnected.ok, true);
  assert.equal(reconnected.state.focusMode, true);
  assert.equal(reconnected.state.notesVisible, true);

  const aborted = machine.abort({ notesVisible: true, focusMode: true });
  assert.equal(aborted.ok, true);
  assert.equal(aborted.state.status, 'aborted');
  assert.equal(machine.abort({}).ok, true);

  const reset = machine.reset({ trackId: 'deep-dive', incidentCorrelationId: 'INC-42' });
  assert.equal(reset.ok, true);
  assert.equal(reset.state.status, 'idle');
  assert.equal(reset.state.currentStepId, 'architecture-dependency-view');
  assert.equal(reset.state.incidentCorrelationId, 'INC-42');
  assert.equal(machine.reset({ trackId: 'deep-dive' }).ok, true);
});

test('native evidence and unavailable scheduled-task proof stay honest and do not fabricate a live result', () => {
  const nativeCase = evaluateGate(
    { gate: { kind: 'native-evidence', action: 'continue' } },
    { serverProof: { nativeEvidenceStatus: 'Unavailable / requires scheduled-task setup' } },
    { correlationId: 'RUN-0004' },
  );
  assert.equal(nativeCase.allowed, false);
  assert.match(nativeCase.reason, /requires scheduled-task setup|not available/i);

  const scheduledCase = evaluateGate(
    { gate: { kind: 'scheduled-task', action: 'continue' } },
    { serverProof: { scheduledTaskAvailable: false } },
    { correlationId: 'RUN-0004' },
  );
  assert.equal(scheduledCase.allowed, false);
  assert.match(scheduledCase.reason, /requires scheduled-task setup/i);
});

test('XSS-safe note rendering escapes embedded script and HTML text before the presenter view renders it', () => {
  const escaped = sanitizePresenterNotes(['<img src=x onerror=alert(1)>', 'safe text']);
  assert.equal(escaped[0], '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escaped[1], 'safe text');
  assert.equal(escaped[0].includes('<script'), false);
});

test('rehearsal budgets stay within the target ranges without claiming live durations', () => {
  const fastWowRehearsal = buildPresenterRehearsal('fast-wow');
  assert.equal(fastWowRehearsal.status, 'within-target');
  assert.ok(fastWowRehearsal.totalTargetMinutes <= 7);
  assert.equal(fastWowRehearsal.simulated, true);

  const deepDiveRehearsal = buildPresenterRehearsal('deep-dive');
  assert.equal(deepDiveRehearsal.status, 'within-target');
  assert.ok(deepDiveRehearsal.totalTargetMinutes >= 20 && deepDiveRehearsal.totalTargetMinutes <= 25);
});

test('presenter UI wiring keeps the cloud product and local companion clearly labeled and exposes accessible live status', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

  assert.match(html, /Azure SRE Agent — cloud product/);
  assert.match(html, /Mission Control Copilot — local companion/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-action="presenter-select-track"/);
  assert.match(html, /data-action="presenter-continue"/);
  assert.match(appSource, /selectedPresenterTrackId = 'fast-wow'/);
  assert.equal(appSource.includes('getPresenterGateContext'), false);
  assert.equal(appSource.includes('gateContext'), false);
  assert.equal(appSource.includes('baselineReady'), false);
  assert.equal(appSource.includes('actionKey'), false);
});

test('production presenter endpoints reject malicious all-true payloads and stale run mismatches without bypassing auth policy', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const maliciousStart = await fetch(`${base}/api/presenter/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId: 'fast-wow',
        gateContext: { ready: true, baselineReady: true, approved: true, recovered: true, actionKey: 'remediate-1', scheduledTaskAvailable: true },
        baselineReady: true,
        approvalStatus: 'approved',
        actionExecuted: true,
        recoveryVerified: true,
        force: true,
        focusedPanels: ['incident-panel'],
      }),
    });
    assert.equal(maliciousStart.status, 400);
    const maliciousBody = await maliciousStart.json();
    assert.match(maliciousBody.error, /blocked client-supplied gate truth|gate truth/i);

    const staleContinue = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: 'RUN-9', notesVisible: true }),
    });
    assert.equal(staleContinue.status, 400);
    const staleBody = await staleContinue.json();
    assert.match(staleBody.error, /no active presenter track|stale|different presenter run/i);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
