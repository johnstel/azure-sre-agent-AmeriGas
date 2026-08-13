const fs = require('node:fs');
const path = require('node:path');

const TRACK_CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'presenter-tracks.json'), 'utf8')
);

const DEFAULT_PANEL_IDS = new Set(TRACK_CATALOG.panelIds || []);
const DEFAULT_ACTION_IDS = new Set(TRACK_CATALOG.actionIds || []);
const DEFAULT_GATE_IDS = new Set(TRACK_CATALOG.gateIds || []);
const VALID_PRODUCT_SURFACES = new Set(['azure-sre-agent-cloud', 'mission-control-local', 'operator']);

const TRACK_LOOKUP = new Map((TRACK_CATALOG.tracks || []).map((track) => [track.id, track]));

function generateCorrelationId(prefix = 'PRES') {
  const suffix = (Math.random() * 0xfffffffff).toString(16).slice(0, 8).toUpperCase();
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

function sanitizePresenterText(value) {
  const text = String(value ?? '');
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizePresenterNotes(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.map((note) => sanitizePresenterText(note));
}

function getTrackById(trackId) {
  const track = TRACK_LOOKUP.get(trackId);
  if (!track) throw new Error(`Unknown presenter track: ${trackId}`);
  return track;
}

function validatePresenterStep(step, catalog = TRACK_CATALOG) {
  const errors = [];
  if (!step || typeof step !== 'object') {
    return ['Step definition is missing'];
  }

  if (!step.id || typeof step.id !== 'string') {
    errors.push('Each step must include a stable string id');
  }
  if (!step.title || typeof step.title !== 'string') {
    errors.push(`Step ${step.id || 'unknown'} is missing a title`);
  }
  if (!Array.isArray(step.presenterNotes) || step.presenterNotes.length === 0) {
    errors.push(`Step ${step.id || 'unknown'} must include presenter notes`);
  }
  if (!Array.isArray(step.expectedEvidence) || step.expectedEvidence.length === 0) {
    errors.push(`Step ${step.id || 'unknown'} must include expected evidence`);
  }
  if (!step.productSurface || !VALID_PRODUCT_SURFACES.has(step.productSurface)) {
    errors.push(`Step ${step.id || 'unknown'} has an invalid productSurface: ${step.productSurface}`);
  }
  if (!Array.isArray(step.focusedPanels) || step.focusedPanels.length === 0) {
    errors.push(`Step ${step.id || 'unknown'} must include focusedPanels`);
  } else {
    for (const panelId of step.focusedPanels) {
      if (!DEFAULT_PANEL_IDS.has(panelId)) {
        errors.push(`Step ${step.id || 'unknown'} uses unknown focused panel id: ${panelId}`);
      }
    }
  }
  if (!Array.isArray(step.controls) || step.controls.length === 0) {
    errors.push(`Step ${step.id || 'unknown'} must include controls`);
  } else {
    for (const control of step.controls) {
      if (!DEFAULT_ACTION_IDS.has(control)) {
        errors.push(`Step ${step.id || 'unknown'} uses unknown action id: ${control}`);
      }
    }
  }
  if (!step.gate || typeof step.gate !== 'object') {
    errors.push(`Step ${step.id || 'unknown'} must include a gate contract`);
  } else {
    if (!step.gate.id || typeof step.gate.id !== 'string') {
      errors.push(`Step ${step.id || 'unknown'} gate must include a string id`);
    } else if (!DEFAULT_GATE_IDS.has(step.gate.id)) {
      errors.push(`Step ${step.id || 'unknown'} uses unknown gate id: ${step.gate.id}`);
    }
    if (!step.gate.kind || typeof step.gate.kind !== 'string') {
      errors.push(`Step ${step.id || 'unknown'} gate must include a kind`);
    }
    if (!step.gate.action || typeof step.gate.action !== 'string') {
      errors.push(`Step ${step.id || 'unknown'} gate must include an action name`);
    }
  }
  if (!step.resetBehavior || typeof step.resetBehavior !== 'string') {
    errors.push(`Step ${step.id || 'unknown'} is missing resetBehavior`);
  }
  if (!step.abortBehavior || typeof step.abortBehavior !== 'string') {
    errors.push(`Step ${step.id || 'unknown'} is missing abortBehavior`);
  }
  return errors;
}

function validatePresenterTrack(track, catalog = TRACK_CATALOG) {
  const errors = [];
  if (!track || typeof track !== 'object') return ['Track is missing'];
  if (!track.id || typeof track.id !== 'string') {
    errors.push('Track id is required');
  }
  if (!track.title || typeof track.title !== 'string') {
    errors.push(`Track ${track.id || 'unknown'} is missing a title`);
  }
  if (!Number.isFinite(track.durationMinutes) || track.durationMinutes <= 0) {
    errors.push(`Track ${track.id || 'unknown'} must declare a positive durationMinutes value`);
  }
  if (track.id === 'fast-wow' && Number(track.durationMinutes || 0) > 7) {
    errors.push('Fast Wow track exceeds the seven-minute target budget');
  }
  if (track.id === 'deep-dive' && (Number(track.durationMinutes || 0) < 20 || Number(track.durationMinutes || 0) > 25)) {
    errors.push('Deep Dive track must remain within the 20-25 minute target range');
  }
  if (!track.steps || !Array.isArray(track.steps) || track.steps.length === 0) {
    errors.push(`Track ${track.id || 'unknown'} must define at least one step`);
    return errors;
  }
  for (const step of track.steps) {
    for (const err of validatePresenterStep(step, catalog)) {
      errors.push(err);
    }
  }
  return errors;
}

function validatePresenterTracks(catalog = TRACK_CATALOG) {
  const tracks = Array.isArray(catalog.tracks) ? catalog.tracks : [];
  const errors = [];
  const seen = new Set();

  if (tracks.length !== 2) {
    errors.push('Presenter catalog must contain exactly two tracks');
  }

  for (const track of tracks) {
    const trackId = track && track.id ? track.id : 'unknown';
    if (seen.has(trackId)) {
      errors.push(`Duplicate track id: ${trackId}`);
    } else {
      seen.add(trackId);
    }
    for (const err of validatePresenterTrack(track, catalog)) {
      errors.push(err);
    }
  }

  // Enforce the known target durations and the key track IDs for the issue.
  const ids = tracks.map((track) => track.id);
  if (!ids.includes('fast-wow')) {
    errors.push('The catalog must include the required Fast Wow track');
  }
  if (!ids.includes('deep-dive')) {
    errors.push('The catalog must include the required Deep Dive track');
  }

  return {
    valid: errors.length === 0,
    errors,
    tracks,
  };
}

function evaluateGate(step, context = {}, runState = {}) {
  const gate = step && step.gate ? step.gate : null;
  if (!gate) return { allowed: true, reason: 'no gate required' };

  const correlationId = context.correlationId || runState.correlationId || null;
  const runCorrelationId = runState.correlationId || null;
  if (correlationId && runCorrelationId && correlationId !== runCorrelationId) {
    return { allowed: false, reason: `stale gate callback for another presenter run (${correlationId} !== ${runCorrelationId})` };
  }

  const source = context || {};
  switch (gate.kind) {
    case 'readiness':
      return { allowed: Boolean(source.baselineReady || source.ready || source.readinessPass), reason: 'baseline readiness has not passed' };
    case 'baseline':
      return { allowed: Boolean(source.baselineReady || source.baselineHealth === true || source.baselineHealthPass), reason: 'baseline health assertion did not pass' };
    case 'scenario':
      return { allowed: Boolean(source.scenarioActive === true && source.scenarioId === (runState.scenarioId || source.scenarioId)), reason: 'scenario assertion mismatch or inactive scenario' };
    case 'native-evidence':
      if (source.nativeEvidenceAvailable === true) return { allowed: true, reason: 'native evidence available' };
      if (source.nativeEvidenceStatus === 'Unavailable / requires scheduled-task setup') return { allowed: false, reason: 'Unavailable / requires scheduled-task setup' };
      return { allowed: false, reason: 'native evidence is not available for the current run' };
    case 'approval':
      return { allowed: Boolean(source.approved === true && (source.actionKey || source.runApproved)), reason: 'approval is required before the step can continue' };
    case 'remediation':
      return { allowed: Boolean(source.remediationExecuted === true || source.actionExecuted === true), reason: 'exact remediation must be executed before continuing' };
    case 'recovery':
      return { allowed: Boolean(source.recoveryVerified === true || source.assertionPassed === true), reason: 'recovery must be verified with fresh assertions' };
    case 'incident-value':
      return { allowed: Boolean(source.valueSummaryRecorded === true || source.valueEvidenceObserved === true), reason: 'incident value summary requires observed evidence' };
    case 'scheduled-task':
      return { allowed: Boolean(source.scheduledTaskAvailable === true), reason: 'Unavailable / requires scheduled-task setup' };
    default:
      return { allowed: true, reason: 'no additional gate logic required' };
  }
}

function getTrackStep(trackId, stepId) {
  const track = getTrackById(trackId);
  const step = track.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`Unknown step ${stepId} for track ${trackId}`);
  return step;
}

function defaultPresenterState() {
  return {
    trackId: null,
    status: 'idle',
    currentStepId: null,
    completedSteps: [],
    correlationId: null,
    scenarioId: null,
    incidentCorrelationId: null,
    notesVisible: false,
    focusMode: false,
    focusedPanels: [],
    startedAt: null,
    lastUpdated: null,
    lastEvent: null,
  };
}

function createPresenterStateMachine(options = {}) {
  const catalog = options.catalog || TRACK_CATALOG;
  const validation = validatePresenterTracks(catalog);
  if (!validation.valid) {
    throw new Error(`Presenter track catalog is invalid: ${validation.errors.join('; ')}`);
  }

  const store = options.storage || {
    read: () => defaultPresenterState(),
    write: () => undefined,
  };

  function readState() {
    const raw = store.read();
    return { ...defaultPresenterState(), ...raw };
  }

  function writeState(nextState) {
    store.write({ ...nextState, lastUpdated: new Date().toISOString() });
    return store.read();
  }

  function applyTrack(trackId, context = {}) {
    const track = getTrackById(trackId);
    const firstStep = track.steps[0];
    const runCorrelationId = context.correlationId || generateCorrelationId();
    const nextState = {
      ...defaultPresenterState(),
      trackId: track.id,
      status: 'running',
      currentStepId: firstStep.id,
      completedSteps: [],
      correlationId: runCorrelationId,
      scenarioId: context.scenarioId || null,
      incidentCorrelationId: context.incidentCorrelationId || null,
      notesVisible: Boolean(context.notesVisible),
      focusMode: Boolean(context.focusMode),
      startedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      lastEvent: 'started',
    };

    const gateResult = evaluateGate(firstStep, { ...context.gateContext, correlationId: runCorrelationId }, nextState);
    if (!gateResult.allowed) {
      return {
        ok: false,
        allowed: false,
        reason: gateResult.reason,
        state: nextState,
      };
    }

    const saved = writeState(nextState);
    return { ok: true, allowed: true, state: saved, reason: 'presenter track started' };
  }

  function handleStart(trackId, context = {}) {
    const current = readState();
    if (current.trackId && current.status === 'running' && !context.force) {
      return { ok: true, allowed: true, state: current, reason: 'track already running' };
    }
    return applyTrack(trackId, context);
  }

  function handleContinue(context = {}) {
    const current = readState();
    if (!current.trackId) {
      return { ok: false, allowed: false, reason: 'no active presenter track' };
    }

    if (context.correlationId && current.correlationId && context.correlationId !== current.correlationId) {
      return { ok: false, allowed: false, reason: 'stale outbound callback rejected for a different presenter run' };
    }

    const track = getTrackById(current.trackId);
    const currentStep = track.steps.find((step) => step.id === current.currentStepId) || track.steps[0];
    const gateResult = evaluateGate(currentStep, { ...context.gateContext, correlationId: current.correlationId }, current);
    if (!gateResult.allowed) {
      return {
        ok: false,
        allowed: false,
        state: current,
        reason: gateResult.reason,
      };
    }

    const nextIndex = track.steps.findIndex((step) => step.id === current.currentStepId);
    const nextStep = track.steps[nextIndex + 1] || null;
    const updated = {
      ...current,
      completedSteps: Array.from(new Set([...current.completedSteps, current.currentStepId].filter(Boolean))),
      currentStepId: nextStep ? nextStep.id : null,
      status: nextStep ? 'running' : 'complete',
      lastUpdated: new Date().toISOString(),
      lastEvent: nextStep ? 'continued' : 'completed',
      notesVisible: Boolean(context.notesVisible ?? current.notesVisible),
      focusMode: Boolean(context.focusMode ?? current.focusMode),
      focusedPanels: Array.isArray(context.focusedPanels) ? context.focusedPanels : current.focusedPanels,
    };

    const saved = writeState(updated);
    return { ok: true, allowed: true, state: saved, reason: nextStep ? 'continued' : 'completed' };
  }

  function handlePause(context = {}) {
    const current = readState();
    if (!current.trackId) return { ok: false, allowed: false, reason: 'no active track to pause' };
    if (current.status === 'paused') return { ok: true, allowed: true, state: current, reason: 'already paused' };
    const updated = {
      ...current,
      status: 'paused',
      lastUpdated: new Date().toISOString(),
      lastEvent: 'paused',
      notesVisible: Boolean(context.notesVisible ?? current.notesVisible),
      focusMode: Boolean(context.focusMode ?? current.focusMode),
    };
    const saved = writeState(updated);
    return { ok: true, allowed: true, state: saved, reason: 'paused' };
  }

  function handleResume(context = {}) {
    const current = readState();
    if (!current.trackId) return { ok: false, allowed: false, reason: 'no active track to resume' };
    if (current.status === 'running') return { ok: true, allowed: true, state: current, reason: 'already running' };
    const updated = {
      ...current,
      status: 'running',
      lastUpdated: new Date().toISOString(),
      lastEvent: 'resumed',
      notesVisible: Boolean(context.notesVisible ?? current.notesVisible),
      focusMode: Boolean(context.focusMode ?? current.focusMode),
    };
    const saved = writeState(updated);
    return { ok: true, allowed: true, state: saved, reason: 'resumed' };
  }

  function handleAbort(context = {}) {
    const current = readState();
    if (!current.trackId) return { ok: true, allowed: true, state: current, reason: 'nothing to abort' };
    const updated = {
      ...current,
      status: 'aborted',
      lastUpdated: new Date().toISOString(),
      lastEvent: 'aborted',
      notesVisible: Boolean(context.notesVisible ?? current.notesVisible),
      focusMode: Boolean(context.focusMode ?? current.focusMode),
    };
    const saved = writeState(updated);
    return { ok: true, allowed: true, state: saved, reason: 'aborted' };
  }

  function handleReset(context = {}) {
    const current = readState();
    const trackId = context.trackId || current.trackId;
    if (!trackId) {
      const empty = defaultPresenterState();
      const saved = writeState(empty);
      return { ok: true, allowed: true, state: saved, reason: 'reset inactive presenter state' };
    }
    const track = getTrackById(trackId);
    const firstStep = track.steps[0];
    const cleared = {
      ...defaultPresenterState(),
      trackId: track.id,
      status: 'idle',
      currentStepId: firstStep.id,
      correlationId: null,
      incidentCorrelationId: context.incidentCorrelationId || null,
      notesVisible: false,
      focusMode: false,
      focusedPanels: [],
      lastUpdated: new Date().toISOString(),
      lastEvent: 'reset',
    };
    const saved = writeState(cleared);
    return { ok: true, allowed: true, state: saved, reason: 'reset' };
  }

  function reconnect(context = {}) {
    const current = readState();
    if (!current.trackId) {
      return { ok: true, state: current, reason: 'no active track' };
    }
    const updated = {
      ...current,
      lastUpdated: new Date().toISOString(),
      lastEvent: context.lastEvent || 'reconnected',
      focusMode: Boolean(context.focusMode ?? current.focusMode),
      notesVisible: Boolean(context.notesVisible ?? current.notesVisible),
    };
    const saved = writeState(updated);
    return { ok: true, state: saved, reason: 'reconnected' };
  }

  return {
    defaultState: defaultPresenterState,
    getState: readState,
    startTrack: handleStart,
    continueStep: handleContinue,
    pause: handlePause,
    resume: handleResume,
    abort: handleAbort,
    reset: handleReset,
    reconnect,
    validatePresenterTrack,
    validatePresenterTracks,
    evaluateGate,
    getTrackById,
    getTrackStep,
    generateCorrelationId,
    sanitizePresenterNotes,
    sanitizePresenterText,
  };
}

const PRESENTER_TRACKS = TRACK_CATALOG.tracks || [];
const PRESENTATION_TRACKS = PRESENTER_TRACKS;

module.exports = {
  TRACK_CATALOG,
  PRESENTER_TRACKS,
  PRESENTATION_TRACKS,
  VALID_PANEL_IDS: DEFAULT_PANEL_IDS,
  VALID_ACTION_IDS: DEFAULT_ACTION_IDS,
  VALID_GATE_IDS: DEFAULT_GATE_IDS,
  VALID_PRODUCT_SURFACES,
  validatePresenterTrack,
  validatePresenterTracks,
  evaluateGate,
  generateCorrelationId,
  sanitizePresenterText,
  sanitizePresenterNotes,
  createPresenterStateMachine,
  getTrackById,
  getTrackStep,
  buildPresenterRehearsal(trackId, options = {}) {
    const track = getTrackById(trackId);
    const targetMinutes = Number(track.durationMinutes || 0);
    const defaultSteps = track.steps.map((step, index) => {
      const base = targetMinutes / track.steps.length;
      const weight = (track.id === 'fast-wow' && index < 2) || (track.id === 'deep-dive' && index < 2) ? 0.8 : 1;
      return {
        stepId: step.id,
        durationMinutes: Number(Math.max(0.25, base * weight).toFixed(2)),
      };
    });
    const stepDurations = Array.isArray(options.stepDurations)
      ? options.stepDurations
      : defaultSteps;
    let plannedMinutes = stepDurations.reduce((total, item) => total + Number(item.durationMinutes || 0), 0);
    if (plannedMinutes > targetMinutes) {
      const excess = plannedMinutes - targetMinutes;
      const lastIndex = stepDurations.length - 1;
      const lastEntry = stepDurations[lastIndex];
      const prior = Number(lastEntry.durationMinutes || 0);
      const reduced = Math.max(0.25, Number((prior - excess).toFixed(2)));
      stepDurations[lastIndex] = { ...lastEntry, durationMinutes: reduced };
      plannedMinutes = stepDurations.reduce((total, item) => total + Number(item.durationMinutes || 0), 0);
    }
    return {
      trackId: track.id,
      totalTargetMinutes: Number(plannedMinutes.toFixed(2)),
      simulated: true,
      status: plannedMinutes <= targetMinutes ? 'within-target' : 'over-target',
      steps: stepDurations.map((item) => ({
        stepId: item.stepId,
        durationMinutes: Number(Number(item.durationMinutes || 0).toFixed(2)),
        simulated: true,
      })),
    };
  },
};
