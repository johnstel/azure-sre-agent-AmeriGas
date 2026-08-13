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

test('shared presenter catalog contains the required Fast Wow and Deep Dive tracks with valid schema metadata', () => {
  assert.equal(TRACK_CATALOG.schemaVersion, 1);
  assert.deepEqual(TRACK_CATALOG.gateIds.includes('native-sre-agent-investigation'), true);
  assert.deepEqual(TRACK_CATALOG.gateIds.includes('scheduled-task-evidence'), true);
  const trackIds = TRACK_CATALOG.tracks.map((track) => track.id);
  assert.deepEqual(trackIds.includes('fast-wow'), true);
  assert.deepEqual(trackIds.includes('deep-dive'), true);
  assert.deepEqual(TRACK_CATALOG.tracks[0].durationMinutes <= 7, true);
  assert.deepEqual(TRACK_CATALOG.tracks[1].durationMinutes >= 20 && TRACK_CATALOG.tracks[1].durationMinutes <= 25, true);
  assert.deepEqual(TRACK_CATALOG.panelIds.includes('presenter-panel'), true);
  assert.deepEqual(TRACK_CATALOG.actionIds.includes('continue'), true);
});

test('start and continue enforce real gate checks instead of accepting unsigned presenter progress', () => {
  const machine = createPresenterStateMachine({ storage: createMemoryStore() });

  const blockedStart = machine.startTrack('fast-wow', { gateContext: { ready: false } });
  assert.equal(blockedStart.ok, false);
  assert.match(blockedStart.reason, /baseline readiness has not passed|readiness/);

  const started = machine.startTrack('fast-wow', {
    correlationId: 'RUN-0001',
    gateContext: { baselineReady: true, ready: true },
  });
  assert.equal(started.ok, true);
  assert.equal(started.state.status, 'running');
  assert.equal(started.state.currentStepId, 'readiness');

  const blockedContinue = machine.continueStep({
    correlationId: 'RUN-0001',
    gateContext: { baselineReady: false },
  });
  assert.equal(blockedContinue.ok, false);
  assert.match(blockedContinue.reason, /has not passed|required/i);

  const continued = machine.continueStep({
    correlationId: 'RUN-0001',
    gateContext: { baselineReady: true, ready: true },
  });
  assert.equal(continued.ok, true);
  assert.equal(continued.state.currentStepId, 'baseline-health');
});

test('stale callbacks and out-of-order assertions are rejected before a step can advance', () => {
  const machine = createPresenterStateMachine({ storage: createMemoryStore() });
  machine.startTrack('fast-wow', { correlationId: 'RUN-0002', gateContext: { ready: true, baselineReady: true } });

  const stale = machine.continueStep({
    correlationId: 'RUN-9999',
    gateContext: { ready: true, baselineReady: true },
  });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /stale|different presenter run/i);

  const mismatch = evaluateGate(
    { gate: { kind: 'scenario', action: 'continue' } },
    { scenarioActive: true, scenarioId: 'service' },
    { scenarioId: 'mongodb' },
  );
  assert.equal(mismatch.allowed, false);
  assert.match(mismatch.reason, /scenario assertion mismatch|inactive scenario/i);
});

test('pause, resume, reconnect, abort, and reset remain idempotent and restore the clean baseline safely', () => {
  const machine = createPresenterStateMachine({ storage: createMemoryStore() });
  machine.startTrack('deep-dive', { correlationId: 'RUN-0003', gateContext: { ready: true, baselineReady: true } });

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
    { nativeEvidenceAvailable: false, nativeEvidenceStatus: 'Unavailable / requires scheduled-task setup' },
    { correlationId: 'RUN-0004' },
  );
  assert.equal(nativeCase.allowed, false);
  assert.match(nativeCase.reason, /requires scheduled-task setup|not available/i);

  const scheduledCase = evaluateGate(
    { gate: { kind: 'scheduled-task', action: 'continue' } },
    { scheduledTaskAvailable: false },
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
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

  assert.match(html, /Azure SRE Agent — cloud product/);
  assert.match(html, /Mission Control Copilot — local companion/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-action="presenter-select-track"/);
  assert.match(html, /data-action="presenter-continue"/);
  assert.match(app, /selectedPresenterTrackId = 'fast-wow'/);
  assert.match(app, /focusedPanels/);
});
