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
  getTrackById,
} = require('../presenter-mode');
const { app, presenterStateMachine, presenterStateStore, sanitizePresenterRequestBody, incidentStore, scheduledTaskEvidenceStore, securityState, __setClusterSnapshotProviderForTests } = require('../server');
const { evaluateToolAccess } = require('../security-policy');

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


function fullyClearSharedPresenterState() {
  presenterStateStore.write(presenterStateMachine.defaultState());
}

test("a raw top-level 'serverProof' in the /start request body is rejected outright, never merged into the trust context (regression guard for the raw-body-spread vulnerability)", async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const spoofedStart = await fetch(`${base}/api/presenter/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackId: 'fast-wow',
        serverProof: { baselineReady: true, scenarioActive: true, scheduledTaskAvailable: true },
      }),
    });
    assert.equal(spoofedStart.status, 400);
    const spoofedBody = await spoofedStart.json();
    assert.match(spoofedBody.error, /blocked client-supplied gate truth|gate truth/i);
    assert.ok(spoofedBody.rejected.includes('serverProof'));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('the server source never spreads the raw request body into a presenter-mutation operation call -- context is always built exclusively from sanitized fields plus the server-computed serverProof', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.equal(/presenterStateMachine\.(startTrack|continueStep|pause|resume|abort|reconnect)\([^)]*\.\.\.(body|req\.body)/.test(serverSource), false);
  assert.equal(serverSource.includes('startTrack(trackId, { ...context, ...body })'), false);
});

test('invalid presenter track ids return stable JSON errors instead of hanging or causing unhandled rejections', async () => {
  fullyClearSharedPresenterState();
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    for (const endpoint of ['start', 'reset']) {
      const response = await fetch(`${base}/api/presenter/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: 'not-a-real-track' }),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /unknown presenter track/i);
      assert.ok(body.state);
    }
  } finally {
    fullyClearSharedPresenterState();
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('the real approval endpoint records canonical approved milestone data that unlocks only the exact action gate', async () => {
  fullyClearSharedPresenterState();
  securityState.pendingApproval = null;
  const incident = incidentStore.activate({ scenarioId: 'mongodb', impactedService: 'mongodb', runMode: 'review' });
  const correlationId = incident.correlationId;
  const sessionId = `session-${Date.now()}`;
  const gateResult = evaluateToolAccess(securityState, 'fix_all', {}, { sessionId, incidentCorrelationId: correlationId });
  assert.equal(gateResult.allowed, false);
  assert.ok(gateResult.approvalId);
  assert.ok(gateResult.actionKey);
  incidentStore.proposeAction(correlationId, { actionKey: gateResult.actionKey, toolName: 'fix_all', params: {} });

  const server = app.listen(0);
  const priorOperatorToken = process.env.MISSION_CONTROL_OPERATOR_TOKEN;
  const operatorToken = `operator-${Date.now()}`;
  process.env.MISSION_CONTROL_OPERATOR_TOKEN = operatorToken;
  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/approval/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': base,
        'X-Mission-Control-Operator-Token': operatorToken,
      },
      body: JSON.stringify({
        approvalId: gateResult.approvalId,
        sessionId,
        actionKey: gateResult.actionKey,
      }),
    });
    assert.equal(response.status, 200);
    const responseBody = await response.json();
    assert.equal(responseBody.success, true);

    const stored = incidentStore.getIncident(correlationId);
    const approvalMilestone = stored.milestones.find((milestone) => (
      milestone.type === 'action_approved' &&
      milestone.data &&
      milestone.data.actionKey === gateResult.actionKey
    ));
    assert.ok(approvalMilestone);
    assert.equal(approvalMilestone.data.approved, true);
    assert.equal(approvalMilestone.data.status, 'approved');
    assert.equal(approvalMilestone.data.decision, 'approved');

    const approvalStep = getTrackById('fast-wow').steps.find((step) => step.id === 'review-approval');
    const proof = trustedServerProof({
      correlationId: 'RUN-APPROVAL-ENDPOINT',
      scenarioId: 'mongodb',
      incidentCorrelationId: correlationId,
      activeIncident: stored,
    });
    const allowed = evaluateGate(approvalStep, { serverProof: proof }, {
      correlationId: 'RUN-APPROVAL-ENDPOINT',
      scenarioId: 'mongodb',
      incidentCorrelationId: correlationId,
      expectedActionKey: gateResult.actionKey,
    });
    assert.equal(allowed.allowed, true);

    const wrongAction = evaluateGate(approvalStep, { serverProof: proof }, {
      correlationId: 'RUN-APPROVAL-ENDPOINT',
      scenarioId: 'mongodb',
      incidentCorrelationId: correlationId,
      expectedActionKey: 'different-action',
    });
    assert.equal(wrongAction.allowed, false);
  } finally {
    if (priorOperatorToken === undefined) delete process.env.MISSION_CONTROL_OPERATOR_TOKEN;
    else process.env.MISSION_CONTROL_OPERATOR_TOKEN = priorOperatorToken;
    securityState.pendingApproval = null;
    incidentStore.finalize(correlationId, 'denied', { reason: 'test cleanup' });
    fullyClearSharedPresenterState();
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('a valid Fast Wow run succeeds end-to-end through the real HTTP endpoints using ACTUAL trusted server evidence -- readiness/baseline from a real (faked) cluster snapshot, approval/recovery from the real incidentStore milestones -- and exact incident milestones unlock each gate strictly in sequence', async () => {
  fullyClearSharedPresenterState();
  const server = app.listen(0);
  const healthySnapshot = {
    deployments: [
      'customer-portal', 'dispatch-console', 'tank-monitor', 'inventory-service', 'order-service',
      'usage-simulator', 'order-worker', 'rabbitmq', 'mongodb', 'otel-collector',
      'order-pricing-dependency', 'order-checkout-probe',
    ].map((name) => ({ metadata: { name }, spec: { replicas: 1 }, status: { availableReplicas: 1, readyReplicas: 1 } })),
    services: ['customer-portal', 'dispatch-console', 'tank-monitor', 'inventory-service', 'order-service', 'mongodb', 'rabbitmq']
      .map((name) => ({ metadata: { name } })),
    endpoints: ['customer-portal', 'dispatch-console', 'tank-monitor', 'inventory-service', 'order-service', 'mongodb', 'rabbitmq']
      .map((name) => ({ metadata: { name }, subsets: [{ addresses: [{ ip: '10.0.0.1' }] }] })),
    networkPolicies: [],
    configMaps: [],
  };
  __setClusterSnapshotProviderForTests(async () => healthySnapshot);

  const actionKey = `test-remediate-${Date.now()}`;
  const incident = incidentStore.activate({ scenarioId: 'mongodb', impactedService: 'mongodb', runMode: 'operator-direct' });
  const correlationId = incident.correlationId;

  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const runCorrelationId = `RUN-${Date.now()}`;

    // Step 1: start Fast Wow. The first gate ('readiness') must succeed
    // purely because the (faked) cluster snapshot is healthy -- no client
    // field can substitute for this.
    const startRes = await fetch(`${base}/api/presenter/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: 'fast-wow', correlationId: runCorrelationId, incidentCorrelationId: correlationId, scenarioId: 'mongodb' }),
    });
    assert.equal(startRes.status, 200, `expected readiness gate to pass with a healthy cluster snapshot: ${JSON.stringify(await startRes.clone().json())}`);
    const startBody = await startRes.json();
    assert.equal(startBody.ok, true);
    assert.equal(startBody.state.currentStepId, 'readiness');

    // Each `continue` call re-checks the CURRENT step's own gate before
    // advancing to the next one (see presenter-mode.js's handleContinue),
    // so leaving 'readiness' requires one continue call, landing on
    // 'baseline-health' -- backed by the SAME healthy cluster snapshot.
    const continue1 = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(continue1.status, 200, `expected readiness gate to still pass: ${JSON.stringify(await continue1.clone().json())}`);
    const continue1Body = await continue1.json();
    assert.equal(continue1Body.state.currentStepId, 'baseline-health');

    // Leaving 'baseline-health' requires re-checking ITS gate (still
    // backed by the same healthy snapshot), landing on 'review-approval'.
    const continue2 = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(continue2.status, 200, `expected baseline gate to pass: ${JSON.stringify(await continue2.clone().json())}`);
    const continue2Body = await continue2.json();
    assert.equal(continue2Body.state.currentStepId, 'review-approval');

    // Leaving 'review-approval' requires ITS OWN gate ('approval') to
    // pass, bound to whatever actionKey the incident's most recent
    // action_proposed milestone carries. Before any proposal/approval
    // milestone exists, this MUST be blocked -- it must never unlock just
    // because readiness/baseline already passed.
    const prematureApproval = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(prematureApproval.status, 400, 'approval gate must not unlock before any action was proposed/approved');

    // Now record the REAL milestones on the REAL incidentStore, exactly
    // like a genuine operator-approved remediation would.
    incidentStore.proposeAction(correlationId, { actionKey, toolName: 'kubectl_scale', params: { replicas: 1 } });
    incidentStore.approveAction(correlationId, { actionKey, approver: 'test-operator', approved: true });

    const continue3 = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(continue3.status, 200, `expected the approval gate to unlock and advance to the exact remediation step: ${JSON.stringify(await continue3.clone().json())}`);
    const continue3Body = await continue3.json();
    assert.equal(continue3Body.state.currentStepId, 'exact-remediation');

    // Leaving the exact-remediation step requires the exact action result to
    // succeed before the flow can reach verified-recovery.
    const prematureRemediation = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(prematureRemediation.status, 400, 'remediation gate must not unlock before a successful exact action_result exists');

    incidentStore.recordActionResult(correlationId, { actionKey, toolName: 'kubectl_scale', success: true, summary: 'scaled mongodb back to 1 replica' });

    const continue4 = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(continue4.status, 200, `expected the remediation gate to unlock and advance to verified-recovery: ${JSON.stringify(await continue4.clone().json())}`);
    const continue4Body = await continue4.json();
    assert.equal(continue4Body.state.currentStepId, 'verified-recovery');

    // Leaving 'verified-recovery' requires ITS OWN gate ('recovery') to
    // pass -- must not unlock before a passing post-action assertion
    // exists, even though the remediation gate already passed.
    const prematureRecovery = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(prematureRecovery.status, 400, 'recovery gate must not unlock before a passing post-action assertion is recorded');

    incidentStore.recordPostActionAssertion(correlationId, { actionKey, passed: true, details: 'mongodb pod is Running and Ready again' });

    const continue5 = await fetch(`${base}/api/presenter/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correlationId: runCorrelationId }),
    });
    assert.equal(continue5.status, 200, `expected the recovery gate to unlock once the exact matching post-action assertion exists: ${JSON.stringify(await continue5.clone().json())}`);
    const continue5Body = await continue5.json();
    assert.equal(continue5Body.state.status, 'complete');
  } finally {
    incidentStore.finalize(correlationId, 'recovered', { reason: 'test cleanup' });
    __setClusterSnapshotProviderForTests(null);
    fullyClearSharedPresenterState();
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('scheduled-task evidence being present/absent never unlocks or blocks an unrelated readiness/baseline/approval/recovery gate, and vice versa', async () => {
  fullyClearSharedPresenterState();
  const server = app.listen(0);
  __setClusterSnapshotProviderForTests(async () => { throw new Error('cluster unreachable in this test'); });

  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const runCorrelationId = `RUN-SCHED-${Date.now()}`;

    // No cluster snapshot is reachable, so readiness MUST fail closed --
    // regardless of whether scheduled-task evidence happens to be fresh.
    scheduledTaskEvidenceStore.recordExecutionEvidence({
      taskId: 'daily-propane-health-report',
      promptVersionHash: 'a'.repeat(64),
      threadId: 'THREAD-unrelated',
      timestamp: new Date().toISOString(),
      status: 'Healthy',
    });

    const startRes = await fetch(`${base}/api/presenter/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: 'fast-wow', correlationId: runCorrelationId }),
    });
    assert.equal(startRes.status, 400, 'readiness gate must still fail closed when the cluster is unreachable, even with fresh, unrelated scheduled-task evidence present');
  } finally {
    __setClusterSnapshotProviderForTests(null);
    fullyClearSharedPresenterState();
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
