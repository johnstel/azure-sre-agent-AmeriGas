const express = require('express');
const fs = require('node:fs');
const { execFile, spawn } = require('child_process');
const path = require('path');
const util = require('util');
const crypto = require('crypto');
const { CopilotClient } = require('@github/copilot-sdk');
const { createTools } = require('./copilot-tools');
const { SYSTEM_PROMPT } = require('./system-prompt');
const {
  createCsrfTokenStore,
  getAllowedOrigin,
  isLocalRequest,
  validateCsrf,
  validateResourceName,
  validateWorkloadName,
} = require('./security');
const { createSecurityState, approvePendingApproval, denyPendingApproval } = require('./security-policy');
const { createOperatorAuthMiddleware, withApprovalContext } = require('./auth');
const { SCENARIO_MAP, SCENARIO_METADATA, SCENARIO_CATALOG } = require('./scenario-catalog');
const { startDemoScenario, resetDemoBaseline, collectClusterSnapshot, verifyBaselineState, DEFAULT_NAMESPACE } = require('./scenario-lifecycle');
const { evaluateScenarioHealth } = require('./scenario-health');
const { createIncidentStore } = require('./incident-store');
const { createScheduledTaskEvidenceStore } = require('./scheduled-task-evidence');
const { buildTrustedPresenterServerProof } = require('./presenter-trust');
const { getSreAgentLinks } = require('./sre-agent-links');
const { createPoller } = require('./poll-scheduler');
const { createAssertionScheduler } = require('./assertion-scheduler');
const { TRACK_CATALOG, createPresenterStateMachine, validatePresenterTracks } = require('./presenter-mode');
const { evaluateReadiness, resolveProfileRequirements, resolveRequirementFlag } = require('./readiness');
const operationLifecycle = require('./operation-lifecycle');
const { resolveDeployedScope } = require('./deployment-scope');

const execFileAsync = util.promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST = process.env.MISSION_CONTROL_HOST || (process.env.MISSION_CONTROL_ALLOW_REMOTE === 'true' ? '0.0.0.0' : '127.0.0.1');
const AUTH_TOKEN = process.env.MISSION_CONTROL_AUTH_TOKEN || '';
const csrfTokenStore = createCsrfTokenStore();

// --- Operation Tracking (deploy / destroy / validate) ---
const operations = new Map();
const securityState = createSecurityState();
const incidentStore = createIncidentStore({
  filePath: path.resolve(__dirname, '.data', 'incidents.json'),
  onPersistError: (err) => console.error('  ⚠️  Incident timeline persistence error:', err.message),
});

// Trusted, server-recorded evidence for the native scheduled-task
// presenter gate (issue #24 integration with issue #20's presenter gate).
// Recorded ONLY through the authenticated /api/scheduled-task/evidence
// route below — never derived from unauthenticated presenter traffic.
const scheduledTaskEvidenceStore = createScheduledTaskEvidenceStore({
  filePath: path.resolve(__dirname, '.data', 'scheduled-task-evidence.json'),
  onPersistError: (err) => console.error('  ⚠️  Scheduled-task evidence persistence error:', err.message),
});


// Operation records are created/finalized/cancelled through
// operation-lifecycle.js, whose terminal-state guard makes 'cancelled',
// 'completed', and 'failed' sticky — see that module for why this
// matters (a killed child's late 'close' event must never overwrite a
// truthful 'cancelled' outcome, and vice versa for a legitimate
// completion that narrowly beats a concurrent cancel request).
function createOperation(type, label) {
  const op = operationLifecycle.createOperation(type, label);
  operations.set(op.id, op);
  return op;
}

function appendLog(op, stream, text) {
  return operationLifecycle.appendLog(op, stream, text);
}

function finishOperation(op, exitCode) {
  return operationLifecycle.finishOperation(op, exitCode);
}

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  const allowedOrigin = getAllowedOrigin(req);
  if (allowedOrigin) {
    res.header('Access-Control-Allow-Origin', allowedOrigin);
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token, X-Mission-Control-Token');
  res.header('Access-Control-Expose-Headers', 'X-CSRF-Token');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('Referrer-Policy', 'no-referrer');
  res.header('X-Frame-Options', 'DENY');
  res.header('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self';");
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api/approval')) return next();
  if (req.path.startsWith('/api/') && !isLocalRequest(req)) {
    const token = req.get('x-mission-control-token') || req.headers['x-mission-control-token'];
    if (!AUTH_TOKEN) return res.status(403).json({ error: 'Remote access is disabled by default. Configure MISSION_CONTROL_AUTH_TOKEN to enable it.' });
    if (token !== AUTH_TOKEN) return res.status(401).json({ error: 'Authentication required for privileged operations' });
  }

  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (isLocalRequest(req) || req.path === '/api/csrf-token') return next();
  if (!validateCsrf(req, csrfTokenStore, { isLocal: false })) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/csrf-token', (req, res) => {
  res.json({ token: csrfTokenStore.issue() });
});

const PRESENT_SESSION_FORBIDDEN_FIELDS = new Set([
  'gateContext',
  'baselineReady',
  'ready',
  'readinessPass',
  'baselineHealthPass',
  'scenarioActive',
  'scenarioStatus',
  'nativeEvidenceAvailable',
  'nativeEvidenceStatus',
  'approved',
  'runApproved',
  'actionKey',
  'expectedActionKey',
  'expectedActionIdentity',
  'actionId',
  'selectedAction',
  'remediationExecuted',
  'actionExecuted',
  'executed',
  'recoveryVerified',
  'recovered',
  'assertionPassed',
  'valueSummaryRecorded',
  'valueEvidenceObserved',
  'incidentValueRecorded',
  'scheduledTaskAvailable',
  'force',
  'forceBypass',
  'focusedPanels',
  'approvalPassed',
  'approvalDenied',
  'approvalExpired',
  'approvalStatus',
  'recoveryStatus',
  'evidenceReady',
  'evidenceAvailable',
  'evidenceStatus',
  'valueRecorded',
  'valueStatus',
  'denied',
  'expired',
  'bypass',
  'serverProof',
  'serverState',
  'trustedState',
  'proof',
  'skipGate',
  'approval',
  'recovery',
  'evidence',
  'value',
]);

const presenterStatePath = path.resolve(__dirname, '.data', 'presenter-state.json');
const presenterStateStore = {
  read() {
    try {
      const raw = fs.readFileSync(presenterStatePath, 'utf8');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  write(state) {
    try {
      fs.mkdirSync(path.dirname(presenterStatePath), { recursive: true });
      fs.writeFileSync(presenterStatePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('Presenter state persist failed:', error.message);
    }
    return state;
  },
};
const presenterStateMachine = createPresenterStateMachine({
  storage: presenterStateStore,
  catalog: TRACK_CATALOG,
});

app.get('/api/presenter/catalog', (req, res) => {
  const validation = validatePresenterTracks(TRACK_CATALOG);
  res.json({
    valid: validation.valid,
    errors: validation.errors,
    catalog: TRACK_CATALOG,
  });
});

app.get('/api/presenter/state', (req, res) => {
  res.json({ state: presenterStateMachine.getState() });
});

app.get('/api/scenarios', (req, res) => {
  res.json({
    count: SCENARIO_CATALOG.length,
    scenarios: SCENARIO_CATALOG,
  });
});

function sanitizePresenterRequestBody(body = {}) {
  const clean = {};
  const rejected = [];
  for (const [key, value] of Object.entries(body || {})) {
    if (PRESENT_SESSION_FORBIDDEN_FIELDS.has(key)) {
      rejected.push(key);
      continue;
    }
    if (key === 'focusMode' || key === 'notesVisible' || key === 'trackId' || key === 'stepId' || key === 'correlationId' || key === 'incidentCorrelationId' || key === 'scenarioId' || key === 'lastEvent') {
      clean[key] = value;
    }
  }
  return { clean, rejected };
}

// Test-only override for the live-cluster snapshot collector used to
// evaluate readiness/baseline/scenario gate evidence. Production code
// always uses the real collectClusterSnapshot (which shells out to
// kubectl); tests inject a fake so the readiness/baseline gate can be
// exercised deterministically without a live cluster, exactly like
// scenario-lifecycle.js's own `runner` dependency-injection pattern.
let clusterSnapshotProviderOverride = null;
function __setClusterSnapshotProviderForTests(fn) {
  clusterSnapshotProviderOverride = fn;
}

/**
 * Builds the COMPLETE trusted server-side proof for the presenter gate
 * system (see presenter-trust.js) -- the single, sole source of
 * `context.serverProof` for every presenter mutation route below. Never
 * accepts or merges anything from the request body.
 */
async function getTrustedPresenterServerProof(incidentCorrelationId) {
  return buildTrustedPresenterServerProof({
    incidentStore,
    scheduledTaskEvidenceStore,
    collectClusterSnapshot: clusterSnapshotProviderOverride || collectClusterSnapshot,
    verifyBaselineState,
    evaluateScenarioHealth,
    repoRoot: REPO_ROOT,
    namespace: DEFAULT_NAMESPACE,
    incidentCorrelationId,
  });
}

async function handlePresenterMutation(req, res, operation) {
  const body = req.body || {};
  const { clean, rejected } = sanitizePresenterRequestBody(body);
  if (rejected.length > 0) {
    return res.status(400).json({
      error: 'Presenter request contains blocked client-supplied gate truth',
      rejected,
      state: presenterStateMachine.getState(),
    });
  }

  // The incident a presenter run is bound to is determined by the
  // SERVER-PERSISTED presenter state (set once, at /start time, from the
  // sanitized request body) -- never re-derived from a later request's
  // own body. This matters specifically for the 'recovery' gate: once an
  // incident is finalized (finalState='recovered'), incidentStore's own
  // getActive() stops returning it (see incident-timeline.js), so the
  // bound incidentCorrelationId is the only reliable way to still look it
  // up. Falls back to this request's own `clean.incidentCorrelationId`
  // only for the very first /start call, before any state is persisted.
  const persistedIncidentCorrelationId = presenterStateMachine.getState().incidentCorrelationId || null;
  const incidentCorrelationIdForProof = persistedIncidentCorrelationId || clean.incidentCorrelationId || null;

  let serverProof;
  try {
    serverProof = await getTrustedPresenterServerProof(incidentCorrelationIdForProof);
  } catch (err) {
    return res.status(500).json({ error: `Failed to build trusted presenter evidence: ${err.message}` });
  }

  // The ONLY fields ever present on `context` are these explicitly listed,
  // sanitized values plus the server-built `serverProof` above. Nothing
  // from the raw request body is ever merged in beyond what
  // sanitizePresenterRequestBody already validated into `clean` --
  // there is deliberately no `...body`/`...req.body` spread anywhere in
  // this function or in any route below. A prior version of the `/start`
  // route re-spread the raw, unsanitized request body on top of this
  // context, which could let a client-supplied field reach the gate
  // trust resolver depending on how the two independent block-lists
  // (this file's PRESENT_SESSION_FORBIDDEN_FIELDS and presenter-mode.js's
  // CLIENT_GATE_TRUTH_KEYS) happened to overlap -- that entire class of
  // bug is eliminated by construction here: `operation` only ever
  // receives this object literal, never anything derived from `body`.
  const context = {
    trackId: clean.trackId,
    stepId: clean.stepId,
    scenarioId: clean.scenarioId,
    correlationId: clean.correlationId,
    incidentCorrelationId: clean.incidentCorrelationId,
    notesVisible: clean.notesVisible,
    focusMode: clean.focusMode,
    lastEvent: clean.lastEvent,
    serverProof,
  };

  let result;
  try {
    result = await operation(context);
  } catch (error) {
    return res.status(400).json({
      error: error && error.message ? error.message : 'Presenter action failed',
      state: presenterStateMachine.getState(),
    });
  }
  if (!result || !('ok' in result)) {
    return res.status(500).json({ error: 'Presenter operation did not return a valid response' });
  }
  if (!result.ok) {
    return res.status(400).json({ error: result.reason || 'Presenter action failed', state: result.state || presenterStateMachine.getState() });
  }
  return res.json({ ok: true, state: result.state, reason: result.reason });
}

app.post('/api/presenter/start', async (req, res) => {
  const { trackId } = req.body || {};
  if (!trackId || typeof trackId !== 'string') {
    return res.status(400).json({ error: 'trackId is required' });
  }
  await handlePresenterMutation(req, res, (context) => presenterStateMachine.startTrack(trackId, context));
});

app.post('/api/presenter/continue', async (req, res) => {
  await handlePresenterMutation(req, res, (context) => presenterStateMachine.continueStep(context));
});

app.post('/api/presenter/pause', async (req, res) => {
  await handlePresenterMutation(req, res, (context) => presenterStateMachine.pause(context));
});

app.post('/api/presenter/resume', async (req, res) => {
  await handlePresenterMutation(req, res, (context) => presenterStateMachine.resume(context));
});

app.post('/api/presenter/abort', async (req, res) => {
  await handlePresenterMutation(req, res, (context) => presenterStateMachine.abort(context));
});

app.post('/api/presenter/reset', async (req, res) => {
  const body = req.body || {};
  const trackId = typeof body.trackId === 'string' ? body.trackId : undefined;
  await handlePresenterMutation(req, res, (context) => presenterStateMachine.reset({ ...context, trackId }));
});

app.post('/api/presenter/reconnect', async (req, res) => {
  await handlePresenterMutation(req, res, (context) => presenterStateMachine.reconnect(context));
});

const IS_WIN = process.platform === 'win32';

function runCommand(cmd, args, opts = {}) {
  if (IS_WIN) return execFileAsync(process.env.ComSpec || 'cmd.exe', ['/c', cmd, ...args], opts);
  return execFileAsync(cmd, args, opts);
}

async function kubectl(...args) {
  try { const { stdout } = await runCommand('kubectl', args, { timeout: 15000 }); return stdout; }
  catch (err) { throw new Error(err.stderr || err.message); }
}

async function az(...args) {
  try { const { stdout } = await runCommand('az', args, { timeout: 30000 }); return stdout; }
  catch (err) { throw new Error(err.stderr || err.message); }
}

// --- Incident Timeline: server-authoritative scenario health ---

/** Fetch pods/networkpolicies/endpoints in one shot for scenario health evaluation. Returns null if the cluster is unreachable (never fabricates a health result). */
async function fetchClusterHealthSnapshot() {
  const podsRaw = await kubectl('get', 'pods', '-n', 'propane', '-o', 'json').catch(() => null);
  if (!podsRaw) return null;
  const [netpolRaw, epRaw] = await Promise.all([
    kubectl('get', 'networkpolicy', '-n', 'propane', '-o', 'json').catch(() => null),
    kubectl('get', 'endpoints', '-n', 'propane', '-o', 'json').catch(() => null),
  ]);
  return {
    pods: JSON.parse(podsRaw).items || [],
    networkPolicies: netpolRaw ? (JSON.parse(netpolRaw).items || []) : [],
    endpoints: epRaw ? (JSON.parse(epRaw).items || []) : [],
  };
}

/**
 * Post-action assertion scheduling (see assertion-scheduler.js): schedules
 * a one-shot re-check of a scenario's health indicator shortly after a
 * remediation action executes, persists enough state to survive a Mission
 * Control restart, and rehydrates any assertion that was still pending
 * when the process last exited.
 */
const assertionScheduler = createAssertionScheduler({
  incidentStore,
  retryDelayMs: Number(process.env.MISSION_CONTROL_ASSERTION_RETRY_MS || 5000),
  checkScenarioHealth: async (scenarioId) => {
    const snapshot = await fetchClusterHealthSnapshot();
    if (!snapshot) return null; // cluster unreachable this tick; never fabricate a result
    return evaluateScenarioHealth(scenarioId, snapshot);
  },
});
const schedulePostActionAssertion = assertionScheduler.schedule;
const rehydratePendingAssertions = assertionScheduler.rehydrate;

/** Record a fully "operator-direct" remediation: proposed, auto-approved (no agent involved), executed, then asserted. */
function recordOperatorDirectAction(toolName, params, outcome) {
  const active = incidentStore.getActive();
  if (!active) return;
  const actionKey = `${toolName}::${JSON.stringify(params || {})}::${Date.now()}`;
  incidentStore.proposeAction(active.correlationId, { actionKey, toolName, params, runMode: 'operator-direct' });
  incidentStore.approveAction(active.correlationId, { actionKey, approver: 'operator (Mission Control UI)' });
  incidentStore.recordActionResult(active.correlationId, {
    actionKey,
    toolName,
    success: outcome.success,
    summary: outcome.summary,
  });
  if (outcome.success && active.scenarioId) {
    schedulePostActionAssertion(active.correlationId, active.scenarioId, actionKey);
  }
}

/**
 * Single poll tick: detect first impact, organic recovery, and approval
 * expiry for the currently active incident (if any). Recovery is only
 * finalized here when there is NO outstanding post-action assertion for
 * this incident — if an approved/direct action has executed successfully
 * but its scheduled assertion (see schedulePostActionAssertion) hasn't run
 * yet, this poll defers entirely and lets that assertion be the
 * authoritative source of truth for whether the fix actually worked. This
 * closes the race where an organic health-poll "recovered" could beat a
 * later-arriving failed assertion and leave a false "recovered" outcome
 * that a truthful partial_recovery could never overwrite.
 */
async function pollActiveIncidentOnce() {
  const pending = securityState.pendingApproval;
  if (pending && pending.status === 'pending' && pending.expiresAt <= Date.now()) {
    incidentStore.sweepExpiredApprovals(Date.now(), [{
      actionKey: pending.actionKey,
      toolName: pending.toolName,
      expiresAt: pending.expiresAt,
      incidentCorrelationId: pending.incidentCorrelationId || null,
    }]);
    securityState.pendingApproval = null;
  }

  const active = incidentStore.getActive();
  if (!active || !active.scenarioId) return;
  try {
    const snapshot = await fetchClusterHealthSnapshot();
    if (!snapshot) return;

    // Re-fetch the active incident after the (possibly slow) cluster call
    // and re-validate it is still the same, non-terminal run before
    // mutating it — the run could have been finalized (e.g. by a
    // concurrently-resolving post-action assertion, or denial/expiry)
    // while this tick's kubectl calls were in flight.
    const current = incidentStore.getActive();
    if (!current || current.correlationId !== active.correlationId) return;

    const health = evaluateScenarioHealth(active.scenarioId, snapshot);
    if (health.active === null) return;
    if (health.active) {
      incidentStore.recordImpact(active.correlationId, { reason: health.reason, source: 'mission-control-health-poll' });
      return;
    }
    const stored = incidentStore.getIncident(active.correlationId);
    if (!stored || stored.finalState) return;
    const hadImpact = stored.milestones.some((m) => m.type === 'impact_detected');
    if (!hadImpact) return;
    if (incidentStore.hasPendingAssertion(active.correlationId)) return; // defer to the scheduled assertion; never race it
    incidentStore.recordRecovery(active.correlationId, { reason: health.reason, source: 'mission-control-health-poll' });
    incidentStore.finalize(active.correlationId, 'recovered', { reason: 'automated health poll confirmed the scenario indicator cleared' });
  } catch { /* best effort; the next tick will retry */ }
}

/**
 * Poll the active incident on an interval, using a recursive-setTimeout
 * scheduler with an in-flight guard (see poll-scheduler.js) so a slow tick
 * (e.g. a hung kubectl call) can never overlap with — and race — the next
 * one against the same incident state.
 */
const INCIDENT_POLL_INTERVAL_MS = Number(process.env.MISSION_CONTROL_INCIDENT_POLL_MS || 5000);
const incidentPoller = createPoller(pollActiveIncidentOnce, INCIDENT_POLL_INTERVAL_MS);

/** Best-effort approver identity for the incident timeline. Only meaningful when operator auth is configured; falls back to a generic, honest label otherwise. */
function resolveApproverIdentity(req) {
  const authorization = req.get('authorization') || '';
  if (authorization.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      const [user] = decoded.split(':');
      if (user) return user;
    } catch { /* fall through to generic label */ }
  }
  return 'authenticated operator (token)';
}

function spawnPwsh(op, scriptPath, scriptArgs) {
  const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-File', scriptPath, ...scriptArgs], {
    cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  op.process = child;
  child.stdout.on('data', (buf) => appendLog(op, 'stdout', buf.toString()));
  child.stderr.on('data', (buf) => appendLog(op, 'stderr', buf.toString()));
  // 'exit' fires as soon as the OS process has genuinely terminated,
  // strictly before 'close' (which waits for stdio streams to flush and
  // is what actually finalizes the operation below). Recording that here
  // — rather than only at 'close' — is what lets the DELETE handler
  // truthfully refuse a cancellation that arrives in the narrow window
  // after the process has already exited but before 'close' has fired.
  child.on('exit', () => operationLifecycle.markChildExited(op));
  child.on('error', (err) => { operationLifecycle.markChildExited(op); appendLog(op, 'stderr', `Process error: ${err.message}`); finishOperation(op, 1); });
  child.on('close', (code) => finishOperation(op, code ?? 1));
  return op;
}

// --- Kubernetes API Endpoints ---

app.get('/api/pods', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'pods', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/networkpolicies', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'networkpolicy', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/endpoints', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'endpoints', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/services', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'svc', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/nodes', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'nodes', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/deployments', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'deployments', '-n', 'propane', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/events', async (req, res) => {
  try { res.json(JSON.parse(await kubectl('get', 'events', '-n', 'propane', '--sort-by=.lastTimestamp', '-o', 'json'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/cluster-info', async (req, res) => {
  try {
    const query = (req && req.query) || {};
    const [context, scope] = await Promise.all([
      kubectl('config', 'current-context').then(s => s.trim()).catch(() => 'No cluster'),
      resolveDeployedScope({
        az,
        subscriptionId: query.subscriptionId || query.subscription,
        resourceGroupName: query.resourceGroupName || query.resourceGroup,
      }),
    ]);
    res.json({
      context,
      subscription: scope.subscriptionName || 'Unknown',
      subscriptionId: scope.subscriptionId,
      resourceGroup: scope.resourceGroupName,
      location: scope.location || '',
    });
  } catch (err) { res.status(err && err.statusCode === 400 ? 400 : 500).json({ error: err.message }); }
});

async function resolveNativeSreAgentEvidence(scope) {
  try {
    const agents = await az('resource', 'list', '--subscription', scope.subscriptionId, '--resource-group', scope.resourceGroupName, '--resource-type', 'Microsoft.App/agents', '-o', 'json');
    const items = JSON.parse(agents || '[]');
    const list = Array.isArray(items) ? items : [];
    const agent = list.find((item) => item && String(item.type || '').toLowerCase() === 'microsoft.app/agents');
    if (!agent) {
      return { available: false, fresh: false, status: 'missing', details: { message: 'No native Azure SRE Agent resource was found in the configured resource group.' } };
    }
    const provisioningState = String(agent.properties?.provisioningState || agent.provisioningState || 'Unknown');
    const ready = ['succeeded', 'running', 'ready', 'healthy', 'successful'].includes(provisioningState.trim().toLowerCase());
    return {
      available: ready,
      fresh: ready,
      status: ready ? 'ready' : provisioningState || 'missing',
      details: { name: agent.name || null, resourceId: agent.id || null, provisioningState },
    };
  } catch (error) {
    return { available: false, fresh: false, status: 'unavailable', details: { message: error && error.message ? error.message : 'Native Azure SRE Agent check failed.' } };
  }
}

async function resolveAuthorizedReadinessScope(req) {
  const query = req && req.query ? req.query : {};
  const scope = await resolveDeployedScope({
    az,
    subscriptionId: query.subscriptionId || query.subscription,
    resourceGroupName: query.resourceGroupName || query.resourceGroup,
  });

  return {
    context: 'server-configured',
    subscriptionId: scope.subscriptionId,
    resourceGroupName: scope.resourceGroupName,
    profile: String(query.profile || process.env.MISSION_CONTROL_PROFILE || 'default').trim() || 'default',
    runId: String(query.runId || process.env.MISSION_CONTROL_RUN_ID || 'mission-control').trim() || 'mission-control',
    timeoutMs: Number(query.timeoutMs ?? query.timeout ?? 90000),
  };
}

function buildReadinessFailurePayload(error) {
  const message = error && error.message ? error.message : 'readiness evaluation failed';
  const statusCode = (() => {
    if (error && Number.isInteger(error.statusCode)) return error.statusCode;
    if (error && error.code === 'ETIMEDOUT') return 503;
    if (/timed out|timeout/i.test(message)) return 503;
    if (/scope|subscription|resource group|profile|mismatch|invalid|required/i.test(message)) return 400;
    return 500;
  })();

  const blocked = {
    schemaVersion: 1,
    category: 'demo-readiness',
    status: 'blocked',
    blocking: true,
    observedAt: new Date().toISOString(),
    duration: 0,
    summary: statusCode === 400
      ? 'Readiness blocked by invalid request scope.'
      : statusCode === 503
        ? 'Readiness blocked by server-side timeout.'
        : 'Mission Control failed to evaluate demo readiness.',
    checks: [{
      id: 'api-readiness-failure',
      category: 'api',
      status: 'fail',
      blocking: true,
      observedAt: new Date().toISOString(),
      duration: 0,
      evidence: { message },
      remediation: statusCode === 400
        ? 'Verify the exact configured Azure subscription and resource group, then retry the readiness gate with a matching request scope.'
        : statusCode === 503
          ? 'Retry the readiness check after the server-side dependency recovers or the timeout window resets.'
          : 'Verify the Azure context and rerun the readiness check.',
    }],
    blockers: ['api-readiness-failure'],
    advisories: [],
  };

  return { statusCode, blocked };
}

async function handleReadinessRequest(req, res) {
  try {
    const scope = await resolveAuthorizedReadinessScope(req);
    const query = req && req.query ? req.query : {};
    const profileRequirements = resolveProfileRequirements(scope.profile, {
      requireMissionControl: query.requireMissionControl,
      requireNativeSreAgent: query.requireNativeSreAgent,
    });
    const requireMissionControl = resolveRequirementFlag(profileRequirements.requireMissionControl, query.requireMissionControl);
    const requireNativeSreAgent = resolveRequirementFlag(profileRequirements.requireNativeSreAgent, query.requireNativeSreAgent);
    const runtime = {
      missionControl: {
        available: true,
        fresh: true,
        status: 'ready',
        details: {
          source: 'mission-control-server',
          observedAt: new Date().toISOString(),
          subscriptionId: scope.subscriptionId,
          resourceGroupName: scope.resourceGroupName,
          runId: scope.runId,
          profile: scope.profile,
        },
      },
      nativeSreAgent: await resolveNativeSreAgentEvidence(scope),
    };

    const result = await evaluateReadiness({
      subscriptionId: scope.subscriptionId,
      resourceGroupName: scope.resourceGroupName,
      profile: scope.profile,
      runId: scope.runId,
      timeoutMs: Number.isFinite(scope.timeoutMs) ? Math.min(scope.timeoutMs, 90000) : 90000,
      mockScenario: query.mockScenario || query.mock || req.body?.mockScenario,
      requireMissionControl,
      requireNativeSreAgent,
    }, runtime);
    return res.json(result);
  } catch (error) {
    const { statusCode, blocked } = buildReadinessFailurePayload(error);
    return res.status(statusCode).json(blocked);
  }
}

app.get('/api/readiness', handleReadinessRequest);
app.get('/api/demo-readiness', handleReadinessRequest);

// --- Break / Fix Endpoints ---

app.post('/api/break/:scenario', async (req, res) => {
  const scenarioId = req.params.scenario;
  try {
    const result = await startDemoScenario(scenarioId, {
      repoRoot: REPO_ROOT,
      namespace: 'propane',
      allowStacking: Boolean(req.query?.allowStacking === 'true' || req.body?.allowStacking === true),
    });

    if (!result.ok) {
      const status = result.code === 'SCENARIO_STACKING_BLOCKED' || result.code === 'BASELINE_DEGRADED' ? 409 : 400;
      return res.status(status).json({ success: false, ...result });
    }

    const meta = SCENARIO_METADATA[scenarioId] || {};
    const incident = incidentStore.activate({
      scenarioId: result.scenarioId,
      scenarioName: meta.name || result.scenarioId,
      domain: meta.domain || null,
      impactedService: meta.impactedService || null,
      relatedIds: meta.relatedIds || [],
      runMode: 'operator-direct',
      correlationId: result.correlationId,
    });
    return res.json({ success: true, message: result.message, correlationId: incident.correlationId, lifecycle: result });
  }
  catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/fix/all', async (req, res) => {
  try {
    const result = await resetDemoBaseline({ repoRoot: REPO_ROOT, namespace: 'propane', scope: 'all' });
    recordOperatorDirectAction('fix_all', {}, { success: result.ok, summary: result.message || 'Reset baseline' });
    if (!result.ok) return res.status(400).json({ success: false, ...result });
    return res.json({ success: true, ...result });
  }
  catch (err) {
    recordOperatorDirectAction('fix_all', {}, { success: false, summary: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/fix/network', async (req, res) => {
  try {
    const result = await resetDemoBaseline({ repoRoot: REPO_ROOT, namespace: 'propane', scope: 'network' });
    recordOperatorDirectAction('fix_network', {}, { success: result.ok, summary: result.message || 'Network reset' });
    if (!result.ok) return res.status(400).json({ success: false, ...result });
    return res.json({ success: true, ...result });
  }
  catch (err) {
    recordOperatorDirectAction('fix_network', {}, { success: false, summary: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/fix/extras', async (req, res) => {
  try {
    const result = await resetDemoBaseline({ repoRoot: REPO_ROOT, namespace: 'propane', scope: 'extras' });
    recordOperatorDirectAction('fix_extras', {}, { success: result.ok, summary: result.message || 'Extra reset' });
    if (!result.ok) return res.status(400).json({ success: false, ...result });
    return res.json({ success: true, ...result });
  }
  catch (err) {
    recordOperatorDirectAction('fix_extras', {}, { success: false, summary: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// --- Incident Evidence Timeline API ---

app.get('/api/incidents/active', (req, res) => {
  const active = incidentStore.getActive();
  if (!active) return res.json(null);
  res.json({
    incident: incidentStore.toRedactedSnapshot(active.correlationId),
    links: getSreAgentLinks(),
  });
});

app.get('/api/incidents', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const recent = incidentStore.listRecent(limit);
  res.json(recent.map((incident) => ({
    correlationId: incident.correlationId,
    scenarioId: incident.scenarioId,
    scenarioName: incident.scenarioName,
    createdAt: incident.createdAt,
    finalState: incident.finalState,
  })));
});

app.get('/api/incidents/:correlationId', (req, res) => {
  const incident = incidentStore.getIncident(req.params.correlationId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  res.json({ incident: incidentStore.toRedactedSnapshot(incident.correlationId), links: getSreAgentLinks() });
});

app.get('/api/incidents/:correlationId/export.json', (req, res) => {
  const incident = incidentStore.getIncident(req.params.correlationId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  const snapshot = { ...incidentStore.toRedactedSnapshot(incident.correlationId), links: getSreAgentLinks() };
  res.setHeader('Content-Disposition', `attachment; filename="${incident.correlationId}.json"`);
  res.json(snapshot);
});

app.get('/api/incidents/:correlationId/export.md', (req, res) => {
  const incident = incidentStore.getIncident(req.params.correlationId);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  const markdown = incidentStore.toRedactedMarkdown(incident.correlationId);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${incident.correlationId}.md"`);
  res.send(markdown);
});

// --- Long-Running Operations ---

app.get('/api/operations', (req, res) => {
  const list = [];
  for (const op of operations.values()) list.push({ id: op.id, type: op.type, label: op.label, status: op.status, startedAt: op.startedAt, endedAt: op.endedAt, exitCode: op.exitCode });
  res.json(list.reverse());
});

/**
 * Plain JSON status+log endpoint for a single operation, used as an
 * authenticated polling fallback when EventSource streaming is
 * unavailable (EventSource cannot attach the X-Mission-Control-Token
 * header required for remote access, so it always fails once
 * MISSION_CONTROL_AUTH_TOKEN is configured — see public/operation-poller.js).
 * `?since=N` returns only log entries from index N onward (never the
 * whole log every poll), plus `logLength` so the caller knows the next
 * cursor to request — this is what keeps repeated polling from
 * duplicating already-rendered log lines.
 */
app.get('/api/operations/:id', (req, res) => {
  const op = operations.get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  const since = Math.max(0, Math.trunc(Number(req.query.since)) || 0);
  res.json({
    id: op.id,
    type: op.type,
    label: op.label,
    status: op.status,
    startedAt: op.startedAt,
    endedAt: op.endedAt,
    exitCode: op.exitCode,
    log: op.log.slice(since),
    logLength: op.log.length,
  });
});

app.get('/api/operations/:id/stream', (req, res) => {
  const op = operations.get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  for (const entry of op.log) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  if (op.status !== 'running') { res.write(`event: done\ndata: ${JSON.stringify({ status: op.status, exitCode: op.exitCode })}\n\n`); return res.end(); }
  op.subscribers.add(res);
  req.on('close', () => op.subscribers.delete(res));
});

app.delete('/api/operations/:id', (req, res) => {
  const op = operations.get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Operation not found' });
  // Every response includes a structured `cancelled` boolean plus the
  // operation's current, truthful `status`/`exitCode`, in addition to
  // the legacy `message` string, so callers can branch on explicit
  // fields instead of parsing message text — brittle, and easy to
  // misinterpret as success. `cancelled: true` is returned if and only
  // if this exact request actually won the cancellation race.
  if (op.status !== 'running') return res.json({ message: 'Already finished', cancelled: false, status: op.status, exitCode: op.exitCode });
  if (op.childExited) {
    // The underlying child process has already genuinely exited (Node's
    // 'exit'/'error' event already fired) even though 'close' — and
    // therefore the true completed/failed finalization — hasn't landed
    // yet. Don't kill an already-dead process or attempt a cancellation;
    // the real outcome is already determined and about to be recorded
    // truthfully.
    return res.json({ message: 'Already finished', cancelled: false, status: op.status, exitCode: op.exitCode });
  }
  // Capture the process reference and attempt the transition FIRST.
  // cancelOperation() atomically decides whether cancellation wins
  // (transitioning to 'cancelled' AND appending the "Cancelled by user"
  // log line together) or loses (leaving op — and its log — completely
  // untouched, because the true completed/failed outcome already won or
  // is about to). Only if it wins do we actually signal the process;
  // this ordering guarantees the log can never claim a cancellation that
  // didn't truly happen.
  const process = op.process;
  if (!operationLifecycle.cancelOperation(op)) return res.json({ message: 'Already finished', cancelled: false, status: op.status, exitCode: op.exitCode });
  if (process) process.kill('SIGTERM');
  res.json({ message: 'Cancelled', cancelled: true, status: op.status, exitCode: op.exitCode });
});

app.post('/api/deploy', (req, res) => {
  for (const op of operations.values()) { if (op.status === 'running' && (op.type === 'deploy' || op.type === 'destroy')) return res.status(409).json({ error: `A ${op.type} operation is already running (${op.id})` }); }
  const { location = 'eastus2', workloadName = 'srelab', skipRbac = false, skipSreAgent = false } = req.body || {};
  if (!['eastus2', 'swedencentral', 'australiaeast'].includes(location)) return res.status(400).json({ error: `Location must be one of: eastus2, swedencentral, australiaeast` });
  let validatedWorkloadName;
  try {
    validatedWorkloadName = validateWorkloadName(workloadName, 'workloadName');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const op = createOperation('deploy', `Deploy to ${location}`);
  appendLog(op, 'system', `🚀 Starting deployment: ${location} / ${validatedWorkloadName}`);
  const args = ['-Location', location, '-WorkloadName', validatedWorkloadName, '-Yes'];
  if (skipRbac) args.push('-SkipRbac');
  if (skipSreAgent) args.push('-SkipSreAgent');
  spawnPwsh(op, path.resolve(REPO_ROOT, 'scripts', 'deploy.ps1'), args);
  res.json({ id: op.id, type: op.type, label: op.label });
});

app.post('/api/destroy', (req, res) => {
  for (const op of operations.values()) { if (op.status === 'running' && (op.type === 'deploy' || op.type === 'destroy')) return res.status(409).json({ error: `A ${op.type} operation is already running (${op.id})` }); }
  const { resourceGroupName = 'rg-srelab-eastus2' } = req.body || {};
  let validatedResourceGroupName;
  try {
    validatedResourceGroupName = validateResourceName(resourceGroupName, 'resourceGroupName');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const op = createOperation('destroy', `Destroy ${validatedResourceGroupName}`);
  appendLog(op, 'system', `🗑️  Destroying: ${validatedResourceGroupName}`);
  spawnPwsh(op, path.resolve(REPO_ROOT, 'scripts', 'destroy.ps1'), ['-ResourceGroupName', validatedResourceGroupName, '-Force']);
  res.json({ id: op.id, type: op.type, label: op.label });
});

app.post('/api/validate', (req, res) => {
  const { resourceGroupName = 'rg-srelab-eastus2' } = req.body || {};
  let validatedResourceGroupName;
  try {
    validatedResourceGroupName = validateResourceName(resourceGroupName, 'resourceGroupName');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const op = createOperation('validate', `Validate ${validatedResourceGroupName}`);
  appendLog(op, 'system', `🔍 Validating deployment: ${validatedResourceGroupName}`);
  spawnPwsh(op, path.resolve(REPO_ROOT, 'scripts', 'validate-deployment.ps1'), ['-ResourceGroupName', validatedResourceGroupName, '-Detailed']);
  res.json({ id: op.id, type: op.type, label: op.label });
});

app.get('/api/pods/:name/logs', async (req, res) => {
  try { const out = await kubectl('logs', req.params.name, '-n', 'propane', '--tail=80'); res.json({ logs: out }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Copilot SDK Integration ---
let copilotClient = null;
let copilotSession = null;
let copilotReady = false;
let copilotError = null;
let chatHistory = [];

// Helper to create a fresh Copilot session
async function createCopilotSession() {
  const tools = createTools(securityState, incidentStore, { scheduleAssertion: schedulePostActionAssertion });
  return copilotClient.createSession({
    clientName: 'zavagas-mission-control',
    systemMessage: { mode: 'append', content: SYSTEM_PROMPT },
    tools, availableTools: tools.map(t => t.name),
  });
}

app.get('/api/copilot/status', (req, res) => {
  res.json({ ready: copilotReady, error: copilotError, sessionId: copilotSession?.sessionId || null });
});

app.use('/api/approval', createOperatorAuthMiddleware());

app.get('/api/approval/pending', (req, res) => {
  if (!securityState.pendingApproval) return res.json(null);
  res.json({ ...securityState.pendingApproval });
});

app.post('/api/approval/approve', (req, res) => {
  const { approvalId, sessionId, actionKey } = req.body || {};
  if (!approvalId) return res.status(400).json({ error: 'approvalId is required' });
  // Always pass the CURRENT active incident's correlationId — security-policy.js
  // validates it against whatever was stored at proposal time, and rejects
  // the approval outright if they don't match (stale, superseded by a new
  // run, or the original incident has since been finalized). This never
  // falls back to writing to "whichever incident happens to be active".
  const activeIncident = incidentStore.getActive();
  const result = approvePendingApproval(securityState, approvalId, {
    sessionId,
    actionKey,
    incidentCorrelationId: activeIncident ? activeIncident.correlationId : null,
  });
  if (result.success && result.incidentCorrelationId) {
    incidentStore.approveAction(result.incidentCorrelationId, {
      actionKey,
      approver: resolveApproverIdentity(req),
      approved: true,
      status: 'approved',
      decision: 'approved',
    });
  }
  res.json(result);
});

app.post('/api/approval/deny', (req, res) => {
  const { approvalId, sessionId, actionKey } = req.body || {};
  if (!approvalId) return res.status(400).json({ error: 'approvalId is required' });
  const activeIncident = incidentStore.getActive();
  const result = denyPendingApproval(securityState, approvalId, {
    sessionId,
    actionKey,
    incidentCorrelationId: activeIncident ? activeIncident.correlationId : null,
  });
  if (result.success && result.incidentCorrelationId) {
    incidentStore.denyAction(result.incidentCorrelationId, {
      actionKey,
      approver: resolveApproverIdentity(req),
      denied: true,
      status: 'denied',
      decision: 'denied',
    });
  }
  res.json(result);
});

// Trusted evidence contract for the presenter `scheduled-task` gate (issue
// #24). Gated by the same operator authentication as /api/approval —
// recording evidence is a privileged write, not something an unauthenticated
// presenter client can influence. The READ route is exposed the same way so
// a presenter's own status panel can show *why* the gate is locked without
// ever letting the browser assert the unlock itself (evaluation happens
// server-side, in handlePresenterMutation below and in this route,
// identically).
app.use('/api/scheduled-task', createOperatorAuthMiddleware());

app.post('/api/scheduled-task/evidence', (req, res) => {
  const { taskId, promptVersionHash, threadId, timestamp, status } = req.body || {};
  const result = scheduledTaskEvidenceStore.recordExecutionEvidence({ taskId, promptVersionHash, threadId, timestamp, status });
  if (!result.ok) {
    return res.status(400).json({ error: result.reason });
  }
  res.json({ ok: true, record: result.record });
});

app.get('/api/scheduled-task/evidence', (req, res) => {
  res.json(scheduledTaskEvidenceStore.evaluate());
});

app.post('/api/chat', async (req, res) => {
  if (!copilotReady || !copilotClient) return res.status(503).json({ error: copilotError || 'Copilot not initialized' });
  const { message } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message is required' });

  chatHistory.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

  // Try sending, auto-reconnect if session expired
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!copilotSession) copilotSession = await createCopilotSession();
      const turnContext = {
        sessionId: `${copilotSession.sessionId || 'copilot'}:${crypto.randomBytes(4).toString('hex')}`,
      };
      const response = await withApprovalContext(turnContext, () => copilotSession.sendAndWait({ prompt: message }, 180000));
      const content = response?.data?.content || '(no response)';
      const toolRequests = response?.data?.toolRequests || [];
      chatHistory.push({ role: 'assistant', content, toolRequests, timestamp: new Date().toISOString() });
      return res.json({ content, toolRequests });
    } catch (err) {
      if (attempt === 0 && err.message && err.message.includes('Session not found')) {
        console.log('  ⚠️  Session expired, creating new session...');
        try { copilotSession = await createCopilotSession(); } catch (e) { /* fall through */ }
        continue;
      }
      return res.status(500).json({ error: err.message });
    }
  }
});

app.get('/api/chat/history', (req, res) => { res.json(chatHistory); });

app.post('/api/chat/reset', async (req, res) => {
  try {
    if (copilotSession) await copilotSession.disconnect().catch(() => {});
    copilotSession = await createCopilotSession();
    chatHistory = [];
    res.json({ success: true, sessionId: copilotSession.sessionId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Startup ---
async function preflight() {
  const checks = [];
  try { await runCommand('kubectl', ['version', '--client', '--short'], { timeout: 15000 }); checks.push('  ✅ kubectl available'); }
  catch { checks.push('  ⚠️  kubectl not found — cluster features will fail'); }
  try { await runCommand('az', ['version', '-o', 'none'], { timeout: 15000 }); checks.push('  ✅ az CLI available'); }
  catch { checks.push('  ⚠️  az CLI not found — Azure info will be unavailable'); }
  return checks;
}

if (require.main === module) {
  (async () => {
    console.log('');
    console.log('  🔥 ZavaGas Propane — Mission Control');
    console.log('  ─────────────────────────────────────');
    console.log('  Powered by GitHub Copilot SDK');
    console.log('');
    const checks = await preflight();
    checks.forEach(c => console.log(c));

    const rehydratedCount = rehydratePendingAssertions();
    if (rehydratedCount > 0) {
      console.log(`  ⏳ Rehydrated ${rehydratedCount} pending post-action assertion(s) from a prior run`);
    }

    console.log('  ⏳ Initializing Copilot SDK...');
    try {
      copilotClient = new CopilotClient({ logLevel: 'error' });
      await copilotClient.start();
      copilotSession = await createCopilotSession();
      copilotReady = true;
      console.log('  ✅ Copilot SDK initialized');
    } catch (err) {
      copilotError = err.message;
      console.log(`  ⚠️  Copilot SDK failed: ${err.message}`);
    }

    app.listen(PORT, HOST, () => {
      console.log('');
      console.log(`  🚀 Dashboard → http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
      console.log('');
    });
  })();
}

module.exports = {
  app,
  resolveAuthorizedReadinessScope,
  handleReadinessRequest,
  presenterStateMachine,
  presenterStateStore,
  sanitizePresenterRequestBody,
  PRESENT_SESSION_FORBIDDEN_FIELDS,
  // Test-only surface for exercising the presenter trust pipeline
  // end-to-end (real incidentStore, real scheduledTaskEvidenceStore, a
  // fake cluster-snapshot collector) without a live Kubernetes cluster.
  incidentStore,
  securityState,
  scheduledTaskEvidenceStore,
  __setClusterSnapshotProviderForTests,
  getTrustedPresenterServerProof,
};
