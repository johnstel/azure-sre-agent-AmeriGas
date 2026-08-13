
/* ── Scenario catalog wiring ───────────────────────────── */
let scenarioCatalog = [];

function getScenarioCatalog() {
  return Array.isArray(scenarioCatalog) ? scenarioCatalog : [];
}

async function refreshScenarioCatalog() {
  try {
    const payload = await api('scenarios');
    if (payload && Array.isArray(payload.scenarios)) {
      const entries = payload.scenarios.filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index);
      scenarioCatalog = entries.map((entry) => ({
        id: entry.id,
        title: entry.title || entry.name || entry.id,
        name: entry.name || entry.title || entry.id,
        domain: entry.domain || 'Shared',
        narrative: entry.narrative || '',
        impactedService: entry.impactedService || '',
        manifest: entry.manifest || '',
        relatedIds: Array.isArray(entry.relatedIds) ? entry.relatedIds : [],
        icon: entry.icon || {
          oom: '💾',
          crash: '💥',
          image: '🖼️',
          cpu: '🔥',
          pending: '⏳',
          probe: '💓',
          backlog: '🧵',
          latency: '⏱️',
          network: '🌐',
          config: '📄',
          mongodb: '🗄️',
          service: '🔀',
        }[entry.id] || '📌',
      }));
      buildScenarioGrid();
      updateScenarioIndicators();
      return scenarioCatalog;
    }
  } catch (error) {
    console.warn('Scenario catalog unavailable:', error.message);
  }

  scenarioCatalog = [];
  return scenarioCatalog;
}

// Pods whose presence/state indicate a scenario is active. These are keyed by
// the validated, canonical scenario IDs in the server/catalog and are used as
// predicate adapters only when the underlying signal is real.
const SCENARIO_INDICATORS = {
  oom:     p => p.name.startsWith('tank-monitor') && (p.reason === 'OOMKilled' || p.status === 'CrashLoopBackOff' || p.restarts > 2),
  crash:   p => p.name.startsWith('inventory-service') && (p.status === 'CrashLoopBackOff' || p.status === 'Error'),
  image:   p => p.name.startsWith('order-service') && (p.status === 'ImagePullBackOff' || p.status === 'ErrImagePull'),
  cpu:     p => p.name.startsWith('demand-forecast'),
  pending: p => p.name.startsWith('fleet-telemetry'),
  probe:   p => p.name.startsWith('safety-compliance'),
  backlog: p => p.name.startsWith('refill-order-backlog'),
  latency: null, // Dependency latency is a ConfigMap-driven SLO breach; reported via telemetry/metrics rather than generic pod state.
  config:  p => p.name.startsWith('delivery-zone'),
  mongodb: null, // detected via a dedicated check below: mongodb-down scales the Deployment to 0, so "any matching pod" is not a safe indicator (see isMongoPodReady)
  network: null, // detected via networkpolicies API
  service: null, // detected via endpoints API
};

/** True only when a pod is both Running and fully Ready (all containers ready). Mirrors the server-side check in scenario-health.js so client/server health semantics stay aligned. */
function isMongoPodReady(p) {
  if (!p || p.status !== 'Running' || !p.ready) return false;
  const parts = String(p.ready).split('/');
  if (parts.length !== 2) return false;
  const readyCount = Number(parts[0]);
  const total = Number(parts[1]);
  return Number.isFinite(readyCount) && Number.isFinite(total) && total > 0 && readyCount === total;
}

/** The mongodb-down scenario scales the Deployment to 0 replicas, so the scenario is active both when mongodb pods are unhealthy AND when there are no mongodb pods at all — recovery requires an actual Running/Ready pod, not just "no unhealthy pod found". */
function isMongodbScenarioActive(pods) {
  const mongoPods = pods.filter(p => p.name.startsWith('mongodb'));
  return !mongoPods.some(isMongoPodReady);
}

let currentPods = [];
let networkPolicyActive = false;
let serviceMismatchActive = false;
const render = window.MissionControlRender;
const incidentUI = window.IncidentTimelineUI;

/* ── Remote Access Token Prompt ────────────────────────── */
// Resolves the promise created by showRemoteAuthModal() once the operator
// submits or cancels. Only one prompt is ever shown at a time — the
// apiClient de-dupes concurrent 401s into a single call to this function.
let remoteAuthResolver = null;

function showRemoteAuthModal() {
  return new Promise((resolve) => {
    remoteAuthResolver = resolve;
    const input = document.getElementById('remote-auth-token-input');
    input.value = '';
    document.getElementById('remote-auth-modal').style.display = '';
    input.focus();
  });
}

function submitRemoteAuthToken() {
  const input = document.getElementById('remote-auth-token-input');
  const token = input.value.trim();
  input.value = ''; // never leave the token sitting in the input longer than needed
  document.getElementById('remote-auth-modal').style.display = 'none';
  if (remoteAuthResolver) { remoteAuthResolver(token || null); remoteAuthResolver = null; }
}

function cancelRemoteAuthModal() {
  document.getElementById('remote-auth-token-input').value = '';
  document.getElementById('remote-auth-modal').style.display = 'none';
  if (remoteAuthResolver) { remoteAuthResolver(null); remoteAuthResolver = null; }
}

/* ── API Helpers ───────────────────────────────────────── */
// Centralizes CSRF token handling (a fresh, single-use token per mutation)
// and the optional remote-access token (attached as a header, never a
// query string; kept only in sessionStorage/memory — see api-client.js).
const apiClient = window.MissionControlApiClient.createApiClient({ onAuthRequired: showRemoteAuthModal });
const api = apiClient.api;

/* ── Toast ─────────────────────────────────────────────── */
function toast(msg, type='success') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ── Time Ago ──────────────────────────────────────────── */
function timeAgo(dateStr) {
  if (!dateStr) return '–';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return Math.floor(diff) + 's';
  if (diff < 3600) return Math.floor(diff / 60) + 'm';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h';
  return Math.floor(diff / 86400) + 'd';
}

/* ── Pod Status Parsing ────────────────────────────────── */
function parsePodStatus(pod) {
  const cs = pod.status.containerStatuses || [];
  let status = pod.status.phase;
  let reason = '';
  let restarts = 0;
  let ready = '0/0';

  if (cs.length > 0) {
    const readyCount = cs.filter(c => c.ready).length;
    ready = readyCount + '/' + cs.length;
    restarts = cs.reduce((s, c) => s + (c.restartCount || 0), 0);
    for (const c of cs) {
      if (c.state.waiting) {
        status = c.state.waiting.reason || 'Waiting';
        reason = c.state.waiting.reason || '';
      } else if (c.state.terminated) {
        status = c.state.terminated.reason || 'Terminated';
        reason = c.state.terminated.reason || '';
      }
    }
  }

  // Check init containers too
  const ics = pod.status.initContainerStatuses || [];
  for (const c of ics) {
    if (c.state && c.state.waiting) {
      status = 'Init:' + (c.state.waiting.reason || 'Waiting');
      reason = c.state.waiting.reason || '';
    }
  }

  return {
    name: pod.metadata.name,
    status,
    reason,
    ready,
    restarts,
    age: pod.metadata.creationTimestamp,
  };
}

function statusClass(s) {
  if (s === 'Running' || s === 'Succeeded') return 'running';
  if (['Pending','ContainerCreating'].includes(s) || s.startsWith('Init:')) return 'pending';
  return 'failed';
}

function badgeClass(s) {
  if (s === 'Running' || s === 'Succeeded') return 'badge-running';
  if (['Pending','ContainerCreating'].includes(s) || s.startsWith('Init:')) return 'badge-pending';
  return 'badge-error';
}

/* ── Refresh Functions ─────────────────────────────────── */
async function refreshPods() {
  try {
    const data = await api('pods');
    if (data.error) throw new Error(data.error);
    document.getElementById('conn-banner').style.display = 'none';

    const pods = (data.items || []).map(parsePodStatus);
    currentPods = pods;
    const total = pods.length;
    const healthy = pods.filter(p => p.status === 'Running' || p.status === 'Succeeded').length;
    const unhealthy = total - healthy;

    document.getElementById('total-pods').textContent = total;
    document.getElementById('healthy-pods').textContent = healthy;
    const uhEl = document.getElementById('unhealthy-pods');
    uhEl.textContent = unhealthy;
    uhEl.className = 'value ' + (unhealthy > 0 ? 'red' : 'green');

    // Update Copilot banner with cluster health context
    if (unhealthy > 0) {
      const issues = pods.filter(p => p.status !== 'Running' && p.status !== 'Succeeded')
        .map(p => p.name + ' (' + p.status + ')').join(', ');
      document.getElementById('copilot-banner').querySelector('.banner-desc').textContent =
        '⚠️ ' + unhealthy + ' unhealthy pod(s): ' + issues + ' — click to diagnose.';
    } else {
      document.getElementById('copilot-banner').querySelector('.banner-desc').textContent =
        'Ask questions about your cluster, diagnose failures, or run fixes using natural language.';
    }

    // Pod table
    const tbody = document.getElementById('pod-tbody');
    tbody.replaceChildren(...pods.map(p => render.buildPodRow(p, timeAgo, name => showPodLogs(name), document)));

    // Update scenario indicators
    updateScenarioIndicators();
  } catch (e) {
    document.getElementById('conn-banner').style.display = 'block';
  }
}

async function refreshEvents() {
  try {
    const data = await api('events');
    if (data.error) return;
    const events = (data.items || []).slice(-15).reverse();
    const el = document.getElementById('events-list');
    if (events.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'event-msg';
      empty.textContent = 'No recent events';
      el.replaceChildren(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    events.forEach(e => fragment.appendChild(render.buildEventRow(e, timeAgo, document)));
    el.replaceChildren(fragment);
  } catch {}
}

async function refreshServices() {
  try {
    const data = await api('services');
    if (data.error) return;
    const portal = (data.items || []).find(s => s.metadata.name === 'customer-portal');
    const el = document.getElementById('portal-link');
    if (portal) {
      const ing = portal.status.loadBalancer && portal.status.loadBalancer.ingress;
      if (ing && ing.length > 0) {
        el.replaceChildren(render.buildPortalLink(portal, document));
      } else {
        el.textContent = 'Pending…';
      }
    } else {
      el.textContent = 'N/A';
    }
  } catch {}
}

async function refreshNodes() {
  try {
    const data = await api('nodes');
    if (data.error) return;
    document.getElementById('node-count').textContent = (data.items || []).length;
  } catch {}
}

async function refreshDeployments() {
  try {
    const data = await api('deployments');
    if (data.error) return;
    const deps = (data.items || []);
    const el = document.getElementById('deployments-list');
    const fragment = document.createDocumentFragment();
    deps.forEach(d => fragment.appendChild(render.buildDeploymentRow(d, document)));
    el.replaceChildren(fragment);
  } catch {}
}

async function refreshClusterInfo() {
  try {
    const data = await api('cluster-info');
    if (data.error) return;
    document.getElementById('cluster-ctx').textContent = data.context || '–';
    document.getElementById('azure-sub').textContent = data.subscription || '–';
    document.getElementById('rg-name').textContent = data.resourceGroup || '–';
  } catch {}
}

/* ── Scenario Indicators ──────────────────────────────── */
function updateScenarioIndicators() {
  const scenarios = getScenarioCatalog();
  if (!scenarios.length) return;

  for (const sc of scenarios) {
    const indicator = document.getElementById('ind-' + sc.id);
    if (!indicator) continue;

    let isActive = false;
    if (sc.id === 'network') {
      isActive = networkPolicyActive;
    } else if (sc.id === 'service') {
      isActive = serviceMismatchActive;
    } else if (sc.id === 'mongodb') {
      isActive = isMongodbScenarioActive(currentPods);
    } else {
      const fn = SCENARIO_INDICATORS[sc.id];
      if (!fn) { indicator.textContent = '–'; indicator.className = 'sc-status'; continue; }
      isActive = currentPods.some(fn);
    }

    indicator.textContent = isActive ? '● ACTIVE' : '○ Healthy';
    indicator.className = 'sc-status ' + (isActive ? 'active' : 'ok');
  }
}

/* ── Build Scenario Cards ─────────────────────────────── */
function buildScenarioGrid() {
  const grid = document.getElementById('scenarios-grid');
  if (!grid) return;

  const scenarios = getScenarioCatalog();
  const fragment = document.createDocumentFragment();

  if (!scenarios.length) {
    const empty = document.createElement('div');
    empty.className = 'scenario-card empty';
    empty.textContent = 'Loading scenario catalog…';
    fragment.appendChild(empty);
    grid.replaceChildren(fragment);
    return;
  }

  scenarios.forEach((sc) => {
    const card = document.createElement('div');
    card.className = 'scenario-card';

    const name = document.createElement('div');
    name.className = 'sc-name';
    name.textContent = `${sc.icon || '📌'} ${sc.title || sc.name || sc.id}`;
    card.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'sc-desc';
    desc.textContent = sc.narrative || sc.name || sc.id;
    card.appendChild(desc);

    const status = document.createElement('div');
    status.id = 'ind-' + sc.id;
    status.className = 'sc-status';
    status.textContent = '–';
    card.appendChild(status);

    const button = document.createElement('button');
    button.className = 'break-btn';
    button.textContent = '💥 Break';
    button.dataset.action = 'break-scenario';
    button.dataset.scenarioId = sc.id;
    card.appendChild(button);

    fragment.appendChild(card);
  });

  grid.replaceChildren(fragment);
}

/* ── Break / Fix Actions ──────────────────────────────── */
async function breakScenario(id, btn) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Breaking…';
  try {
    const data = await api('break/' + id, { method: 'POST' });
    if (data.error) throw new Error(data.error);
    toast('Scenario applied: ' + id);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💥 Break';
    refreshPods();
  }
}

async function fix(type, btn) {
  btn.disabled = true;
  const orig = btn.innerHTML;
  btn.innerHTML = '<span class="spinner"></span> Fixing…';
  try {
    const data = await api('fix/' + type, { method: 'POST' });
    if (data.error) throw new Error(data.error);
    toast('Fix applied: ' + type);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
    refreshPods();
    refreshDeployments();
  }
}

/* ── Network Policy & Endpoint Detection ──────────────── */
async function refreshNetworkPolicies() {
  try {
    const data = await api('networkpolicies');
    if (data.error) { networkPolicyActive = false; return; }
    networkPolicyActive = (data.items || []).some(np => np.metadata.name === 'deny-tank-monitor');
    updateScenarioIndicators();
  } catch { networkPolicyActive = false; }
}

async function refreshEndpoints() {
  try {
    const data = await api('endpoints');
    if (data.error) { serviceMismatchActive = false; return; }
    const ep = (data.items || []).find(e => e.metadata.name === 'tank-monitor');
    if (ep) {
      const addrs = (ep.subsets || []).flatMap(s => s.addresses || []);
      // Service mismatch = service exists but has no endpoints (and tank-monitor pod IS running)
      const tankRunning = currentPods.some(p => p.name.startsWith('tank-monitor') && p.status === 'Running');
      serviceMismatchActive = addrs.length === 0 && tankRunning;
    } else {
      serviceMismatchActive = false;
    }
    updateScenarioIndicators();
  } catch { serviceMismatchActive = false; }
}

/* ── Incident Evidence Timeline & Value Scorecard ─────── */
let currentIncidentCorrelationId = null;
let viewingHistoricalIncident = false;

function renderIncidentSnapshot(payload) {
  const empty = document.getElementById('incident-panel-empty');
  const content = document.getElementById('incident-panel-content');
  if (!payload || !payload.incident) {
    empty.style.display = '';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = '';

  const { incident, links } = payload;
  currentIncidentCorrelationId = incident.correlationId;

  document.getElementById('incident-scorecard-mount').replaceChildren(incidentUI.buildScorecard(incident, document));
  document.getElementById('incident-evidence-mount').replaceChildren(incidentUI.buildEvidenceSummary(incident.evidence, document));
  document.getElementById('incident-timeline-mount').replaceChildren(incidentUI.buildTimeline(incident.milestones, document));
  document.getElementById('incident-links-mount').replaceChildren(incidentUI.buildLinks(links, document, render.toSafeHttpUrl));
}

async function refreshActiveIncident() {
  if (viewingHistoricalIncident) return; // don't clobber an operator's historical selection
  try {
    const payload = await api('incidents/active');
    renderIncidentSnapshot(payload);
  } catch { /* keep last-known rendering on transient fetch errors */ }
}

async function refreshRecentIncidents() {
  try {
    const recent = await api('incidents?limit=10');
    const select = document.getElementById('incident-recent-select');
    if (!Array.isArray(recent) || recent.length === 0) {
      select.style.display = 'none';
      return;
    }
    select.style.display = '';
    const fragment = document.createDocumentFragment();
    const liveOption = document.createElement('option');
    liveOption.value = '';
    liveOption.textContent = 'Live (current run)';
    fragment.appendChild(liveOption);
    recent.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.correlationId;
      const stateLabel = incidentUI.finalStateLabel(entry.finalState);
      option.textContent = `${entry.scenarioName || entry.scenarioId || entry.correlationId} — ${stateLabel}`;
      fragment.appendChild(option);
    });
    select.replaceChildren(fragment);
  } catch { /* recent-run history is best-effort */ }
}

async function onSelectRecentIncident(correlationId) {
  if (!correlationId) {
    viewingHistoricalIncident = false;
    refreshActiveIncident();
    return;
  }
  viewingHistoricalIncident = true;
  try {
    const payload = await api('incidents/' + encodeURIComponent(correlationId));
    renderIncidentSnapshot(payload);
  } catch (e) {
    toast('Failed to load incident: ' + e.message, 'error');
  }
}

/**
 * Downloads a redacted incident evidence-pack export via the shared,
 * authenticated apiClient instead of window.open()/plain navigation
 * (which cannot attach the X-Mission-Control-Token header, and always
 * fails once remote access is enabled). The actual download logic
 * (fetch → Blob → object-URL download → revoke, plus error handling)
 * lives in the standalone, dependency-injected incident-export.js module
 * so it can be unit tested without a real browser DOM.
 */
async function exportIncident(format) {
  return window.MissionControlIncidentExport.downloadIncidentExport({
    request: (path) => apiClient.request(path),
    correlationId: currentIncidentCorrelationId,
    format,
    onError: (message) => toast(message, 'error'),
  });
}

/* ── Presenter Mode ─────────────────────────────────────── */
let selectedPresenterTrackId = 'fast-wow';
let presenterCatalog = null;
let presenterState = null;

function getPresenterTrackDefinition(trackId = selectedPresenterTrackId) {
  if (!presenterCatalog || !presenterCatalog.catalog) return null;
  const track = presenterCatalog.catalog.tracks.find((entry) => entry.id === trackId);
  return track || null;
}

function getPresenterStepForState() {
  const track = getPresenterTrackDefinition();
  if (!track || !presenterState || !presenterState.currentStepId) return null;
  return track.steps.find((step) => step.id === presenterState.currentStepId) || track.steps[0] || null;
}

function updatePresenterTrackButtons() {
  const buttons = document.querySelectorAll('.presenter-track-button');
  buttons.forEach((button) => {
    const active = button.dataset.trackId === (presenterState && presenterState.trackId ? presenterState.trackId : selectedPresenterTrackId);
    button.classList.toggle('active', active);
  });
}

function renderPresenterState() {
  const track = getPresenterTrackDefinition(presenterState && presenterState.trackId ? presenterState.trackId : selectedPresenterTrackId) || getPresenterTrackDefinition(selectedPresenterTrackId);
  const currentStep = getPresenterStepForState() || (track && track.steps[0]) || null;
  const statusEl = document.getElementById('presenter-status');
  const titleEl = document.getElementById('presenter-step-title');
  const summaryEl = document.getElementById('presenter-step-summary');
  const notesEl = document.getElementById('presenter-notes');
  const metaEl = document.getElementById('presenter-meta');
  const trackLabelEl = document.getElementById('presenter-track-label');
  const productEl = document.getElementById('presenter-product-label');
  const companionEl = document.getElementById('presenter-companion-label');
  const focusEl = document.getElementById('presenter-focus-label');
  const stepListEl = document.getElementById('presenter-step-list');

  if (!track || !currentStep) {
    if (statusEl) statusEl.textContent = 'No active track';
    if (statusEl) statusEl.className = 'presenter-status';
    return;
  }

  const stateStatus = (presenterState && presenterState.status) || 'idle';
  statusEl.textContent = stateStatus === 'idle' ? 'Idle — ready for a guided run' : stateStatus.charAt(0).toUpperCase() + stateStatus.slice(1);
  statusEl.className = 'presenter-status ' + (stateStatus === 'running' ? 'running' : stateStatus === 'paused' ? 'paused' : stateStatus === 'complete' ? 'complete' : stateStatus === 'aborted' ? 'aborted' : '');

  titleEl.textContent = currentStep.title;
  summaryEl.textContent = currentStep.audienceTakeaway || currentStep.summary || 'Continue when the current gate passes.';
  trackLabelEl.textContent = track.title;
  const productText = currentStep.productSurface === 'azure-sre-agent-cloud' ? 'Azure SRE Agent — cloud product' : currentStep.productSurface === 'mission-control-local' ? 'Mission Control Copilot — local companion' : 'Operator';
  if (productEl) productEl.textContent = productText;
  if (companionEl) companionEl.textContent = 'Mission Control Copilot — local companion';

  const notes = Array.isArray(currentStep.presenterNotes) ? currentStep.presenterNotes : [];
  notesEl.replaceChildren(...notes.map((note) => {
    const item = document.createElement('li');
    item.textContent = note;
    return item;
  }));
  notesEl.classList.toggle('visible', notes.length > 0);

  const correlation = presenterState && presenterState.correlationId ? presenterState.correlationId : 'not started';
  metaEl.textContent = `Track: ${track.title} · Step ${track.steps.findIndex((item) => item.id === currentStep.id) + 1}/${track.steps.length} · Correlation: ${correlation}`;

  const focusedPanels = (presenterState && Array.isArray(presenterState.focusedPanels) && presenterState.focusedPanels.length) ? presenterState.focusedPanels : [];
  focusEl.textContent = 'Focused panels: ' + (focusedPanels.length ? focusedPanels.join(', ') : 'none');

  stepListEl.replaceChildren(...track.steps.map((step) => {
    const item = document.createElement('div');
    const isCurrent = step.id === currentStep.id;
    const done = Array.isArray(presenterState && presenterState.completedSteps) && presenterState.completedSteps.includes(step.id);
    item.className = 'presenter-step-item ' + (isCurrent ? 'current' : done ? 'done' : 'locked');
    item.textContent = `${step.sequence}. ${step.title}`;
    return item;
  }));

  const controls = {
    start: document.querySelector('[data-action="presenter-start"]'),
    pause: document.querySelector('[data-action="presenter-pause"]'),
    resume: document.querySelector('[data-action="presenter-resume"]'),
    continue: document.querySelector('[data-action="presenter-continue"]'),
    notes: document.querySelector('[data-action="presenter-toggle-notes"]'),
    focus: document.querySelector('[data-action="presenter-focus-mode"]'),
    reconnect: document.querySelector('[data-action="presenter-reconnect"]'),
    abort: document.querySelector('[data-action="presenter-abort"]'),
    reset: document.querySelector('[data-action="presenter-reset"]'),
  };

  const hasRun = Boolean(presenterState && presenterState.trackId);
  const isRunning = stateStatus === 'running';
  const isPaused = stateStatus === 'paused';
  const isCompleted = stateStatus === 'complete';
  const isAborted = stateStatus === 'aborted';

  if (controls.start) {
    controls.start.disabled = Boolean(hasRun && !['idle', 'complete', 'aborted'].includes(stateStatus));
  }
  if (controls.pause) controls.pause.disabled = !isRunning;
  if (controls.resume) controls.resume.disabled = !isPaused;
  if (controls.continue) controls.continue.disabled = !hasRun || !isRunning || isCompleted || isAborted || !currentStep;
  if (controls.notes) controls.notes.disabled = !hasRun;
  if (controls.focus) controls.focus.disabled = !hasRun;
  if (controls.reconnect) controls.reconnect.disabled = !hasRun;
  if (controls.abort) controls.abort.disabled = !hasRun || isAborted;
  if (controls.reset) controls.reset.disabled = !hasRun;

  updatePresenterTrackButtons();
}

async function runPresenterAction(path, payload = {}) {
  try {
    const response = await apiClient.request('presenter/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      toast(data.error || 'Presenter action failed', 'error');
      return null;
    }
    if (data.state) {
      presenterState = data.state;
      if (presenterState && presenterState.trackId) {
        selectedPresenterTrackId = presenterState.trackId;
      }
    }
    renderPresenterState();
    return data;
  } catch (error) {
    toast('Presenter action failed: ' + error.message, 'error');
    return null;
  }
}

async function startPresenterTrack() {
  const trackId = presenterState && presenterState.trackId ? presenterState.trackId : selectedPresenterTrackId;
  if (!trackId) {
    toast('Select a presenter track before starting', 'error');
    return;
  }
  const payload = {
    trackId,
    notesVisible: true,
    focusMode: false,
    correlationId: presenterState && presenterState.correlationId ? presenterState.correlationId : null,
  };
  const result = await runPresenterAction('start', payload);
  if (result) {
    toast('Presenter track started: ' + trackId);
  }
}

async function continuePresenterTrack() {
  if (!presenterState || presenterState.status !== 'running') {
    toast('Continue is blocked until the current gate passes', 'error');
    return;
  }
  const result = await runPresenterAction('continue', {
    notesVisible: true,
    focusMode: Boolean(presenterState && presenterState.focusMode),
    correlationId: presenterState && presenterState.correlationId,
    incidentCorrelationId: presenterState && presenterState.incidentCorrelationId,
    scenarioId: presenterState && presenterState.scenarioId,
  });
  if (result) {
    toast('Presenter step advanced');
  }
}

async function pausePresenterTrack() {
  if (!presenterState || presenterState.status !== 'running') return;
  await runPresenterAction('pause', { notesVisible: true, focusMode: Boolean(presenterState && presenterState.focusMode) });
}

async function resumePresenterTrack() {
  if (!presenterState || presenterState.status !== 'paused') return;
  await runPresenterAction('resume', { notesVisible: true, focusMode: Boolean(presenterState && presenterState.focusMode) });
}

async function abortPresenterTrack() {
  if (!presenterState || !presenterState.trackId) return;
  await runPresenterAction('abort', { notesVisible: true, focusMode: Boolean(presenterState && presenterState.focusMode) });
}

async function resetPresenterTrack() {
  const trackId = presenterState && presenterState.trackId ? presenterState.trackId : selectedPresenterTrackId;
  if (!trackId) return;
  await runPresenterAction('reset', { trackId, notesVisible: false, focusMode: false });
}

async function reconnectPresenterTrack() {
  const result = await runPresenterAction('reconnect', { notesVisible: true, focusMode: Boolean(presenterState && presenterState.focusMode) });
  if (result) {
    toast('Presenter state restored');
  }
}

function togglePresenterNotes() {
  if (!presenterState || !presenterState.trackId) return;
  const next = !(presenterState.notesVisible === true);
  presenterState = { ...presenterState, notesVisible: next };
  renderPresenterState();
  const notesEl = document.getElementById('presenter-notes');
  if (notesEl) notesEl.classList.toggle('visible', next);
}

function togglePresenterFocusMode() {
  if (!presenterState || !presenterState.trackId) return;
  const nextMode = !(presenterState.focusMode === true);
  presenterState = { ...presenterState, focusMode: nextMode, focusedPanels: nextMode ? ['presenter-panel', 'incident-panel'] : [] };
  renderPresenterState();
}

function renderReadinessCard(result) {
  const statusEl = document.getElementById('demo-readiness-status');
  const summaryEl = document.getElementById('demo-readiness-summary');
  const listEl = document.getElementById('demo-readiness-checks');
  if (!statusEl || !summaryEl || !listEl) return;

  const safeResult = result && typeof result === 'object' ? result : { status: 'blocked', summary: 'No fresh readiness result exists.', checks: [] };
  const isReady = safeResult.status === 'ready';
  const isBlocked = safeResult.status === 'blocked';
  statusEl.className = 'presenter-status ' + (isReady ? 'complete' : isBlocked ? 'aborted' : 'running');
  statusEl.textContent = isReady ? 'Ready for Demo' : isBlocked ? 'Blocked' : 'Advisory';
  summaryEl.textContent = safeResult.summary || 'No readiness summary available.';
  listEl.innerHTML = '';

  const checks = Array.isArray(safeResult.checks) ? safeResult.checks : [];
  for (const check of checks.slice(0, 6)) {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    label.textContent = check.id || 'check';
    item.appendChild(label);
    item.appendChild(document.createTextNode(` — ${check.status || 'unknown'} (${check.blocking ? 'blocking' : 'advisory'})`));
    const note = document.createElement('div');
    const evidence = typeof check.evidence === 'string' ? check.evidence : JSON.stringify(check.evidence || {});
    note.textContent = evidence;
    item.appendChild(note);
    listEl.appendChild(item);
  }
}

async function refreshDemoReadiness() {
  try {
    const cluster = await apiClient.request('cluster-info');
    const clusterData = await cluster.json();
    const subscriptionId = clusterData.subscriptionId || clusterData.subscription || '';
    const resourceGroup = clusterData.resourceGroup || clusterData.resourceGroupName || '';
    const params = new URLSearchParams({
      subscriptionId,
      resourceGroupName: resourceGroup,
      profile: 'default',
      timeoutMs: '90000',
    });
    const response = await apiClient.request('readiness?' + params.toString());
    const result = await response.json();
    renderReadinessCard(result);
  } catch (error) {
    renderReadinessCard({ status: 'blocked', summary: 'Mission Control readiness check is unavailable.', checks: [{ id: 'readiness-api', status: 'fail', blocking: true, evidence: { message: error.message } }] });
  }
}

async function refreshPresenterStateOnLoad() {
  try {
    const response = await apiClient.request('presenter/catalog');
    presenterCatalog = await response.json();
    const stateResponse = await apiClient.request('presenter/state');
    const data = await stateResponse.json();
    presenterState = data.state || null;
    if (presenterState && presenterState.trackId) {
      selectedPresenterTrackId = presenterState.trackId;
    }
    renderPresenterState();
  } catch (error) {
    console.warn('Presenter catalog unavailable:', error.message);
  }
}

/* ── Init ──────────────────────────────────────────────── */
buildScenarioGrid();
refreshScenarioCatalog();
refreshPods();
refreshEvents();
refreshServices();
refreshNodes();
refreshDeployments();
refreshClusterInfo();
refreshNetworkPolicies();
refreshEndpoints();
refreshDemoReadiness();
refreshActiveIncident();
refreshRecentIncidents();
refreshPresenterStateOnLoad();

setInterval(refreshPods, 5000);
setInterval(refreshEvents, 10000);
setInterval(refreshServices, 15000);
setInterval(refreshDeployments, 10000);
setInterval(refreshNodes, 30000);
setInterval(refreshNetworkPolicies, 5000);
setInterval(refreshEndpoints, 5000);
setInterval(refreshActiveIncident, 5000);
setInterval(refreshRecentIncidents, 20000);

document.getElementById('incident-recent-select').addEventListener('change', (e) => onSelectRecentIncident(e.target.value));

/* ── Infrastructure Operations ────────────────────────── */
let currentOpId = null;
let currentEventSource = null;
let currentOperationPoller = null;
let renderedLogCount = 0; // count of log entries already rendered for the current operation, so an EventSource-to-poller handoff can resume from the exact same cursor instead of re-fetching (and duplicating) from the start

function autoDetectRG() {
  const rgEl = document.getElementById('rg-name');
  if (rgEl && rgEl.textContent && rgEl.textContent !== '–' && rgEl.textContent !== 'Not found') {
    document.getElementById('validate-rg').value = rgEl.textContent;
    document.getElementById('destroy-rg').value = rgEl.textContent;
  }
}

// Update the deploy-workload and location when cluster-info arrives to keep RG inputs in sync
const origRefreshClusterInfo = refreshClusterInfo;
refreshClusterInfo = async function() {
  await origRefreshClusterInfo();
  autoDetectRG();
  await refreshDemoReadiness();
};

function showTerminal() {
  document.getElementById('terminal-panel').style.display = '';
  document.getElementById('terminal-panel').scrollIntoView({ behavior: 'smooth' });
}

function closeTerminal() {
  document.getElementById('terminal-panel').style.display = 'none';
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }
  if (currentOperationPoller) { currentOperationPoller.stop(); currentOperationPoller = null; }
}

function setTerminalStatus(status) {
  const badge = document.getElementById('terminal-status');
  badge.textContent = status;
  badge.className = 'terminal-badge ' + status;
  const cancelBtn = document.getElementById('btn-cancel-op');
  cancelBtn.style.display = status === 'running' ? '' : 'none';
}

/** Appends already-parsed log entries to the terminal output. Shared by both the EventSource path and the polling fallback so neither can render a log line the other already showed. Also advances renderedLogCount, the cursor used to hand off from EventSource to the polling fallback without re-fetching (and duplicating) already-rendered lines. */
function appendLogEntries(entries) {
  const out = document.getElementById('terminal-output');
  for (const entry of entries) {
    const span = document.createElement('span');
    if (entry.stream === 'stderr') span.style.color = '#f85149';
    else if (entry.stream === 'system') span.style.color = '#58a6ff';
    span.textContent = entry.text;
    out.appendChild(span);
  }
  if (entries.length > 0) {
    out.scrollTop = out.scrollHeight;
    renderedLogCount += entries.length;
  }
}

/**
 * Handles a genuine, server-reported terminal status (from either the
 * EventSource `done` event or the polling fallback's onTerminal). This is
 * the ONLY place that may mark an operation's terminal state — a
 * transport-level failure (EventSource onerror, a poll-level network
 * error) must never reach this function on its own.
 */
function handleTerminalOperation(info) {
  setTerminalStatus(info.status);

  if (info.status === 'failed') {
    const termOutput = document.getElementById('terminal-output').textContent || '';
    window._lastFailure = {
      opId: currentOpId,
      status: info.status,
      exitCode: info.exitCode,
      logTail: termOutput.slice(-3000),
    };
    const fb = document.getElementById('copilot-failure-banner');
    document.getElementById('failure-banner-title').textContent = 'Operation Failed (exit ' + info.exitCode + ')';
    document.getElementById('failure-banner-desc').textContent = 'The operation failed. Let Copilot analyze the logs and suggest a fix.';
    fb.style.display = 'flex';
  }

  currentOpId = null;
  setInfraButtonsEnabled(true);
  refreshPods(); refreshDeployments(); refreshServices(); refreshClusterInfo();
}

/**
 * Authenticated same-origin polling fallback for when EventSource
 * streaming is unavailable. EventSource cannot carry the
 * X-Mission-Control-Token header, so in remote mode
 * /api/operations/:id/stream always fails with a generic transport
 * error — that says nothing about whether the operation itself
 * succeeded, failed, or is still running server-side. We fall back to
 * polling the plain JSON endpoint through the shared, authenticated
 * `api()` helper (never a query-string token) until the server reports a
 * genuine terminal status.
 */
function startOperationPolling(opId) {
  if (currentOperationPoller) { currentOperationPoller.stop(); currentOperationPoller = null; }
  currentOperationPoller = window.MissionControlOperationPoller.createOperationPoller({
    api,
    operationId: opId,
    since: renderedLogCount, // resume exactly where EventSource left off — never re-fetch (and duplicate) already-rendered lines, never skip lines added between disconnect and the first poll
    onLogEntries: appendLogEntries,
    onTerminal: (info) => {
      currentOperationPoller = null;
      handleTerminalOperation(info);
    },
    onError: () => {
      // Transient poll failure: keep the UI truthfully "running" and let the poller retry.
    },
    onGiveUp: () => {
      // We genuinely don't know the outcome — never fabricate success or
      // failure. Leave the terminal status as "running" (truthfully
      // "last known status"), but re-enable controls so the operator is
      // not stuck, and let them refresh/poll the operations list manually.
      currentOperationPoller = null;
      setInfraButtonsEnabled(true);
    },
  });
  currentOperationPoller.start();
}

function streamOperation(opId) {
  currentOpId = opId;
  renderedLogCount = 0;
  const out = document.getElementById('terminal-output');
  out.textContent = '';
  setTerminalStatus('running');
  showTerminal();

  if (currentEventSource) currentEventSource.close();
  if (currentOperationPoller) { currentOperationPoller.stop(); currentOperationPoller = null; }
  const es = new EventSource('/api/operations/' + opId + '/stream');
  currentEventSource = es;

  es.onmessage = (e) => {
    appendLogEntries([JSON.parse(e.data)]);
  };

  es.addEventListener('done', (e) => {
    const info = JSON.parse(e.data);
    es.close();
    currentEventSource = null;
    handleTerminalOperation(info);
  });

  es.onerror = () => {
    // EventSource transport failure (expected in remote mode, since it
    // cannot attach the auth token header). This is NOT a report that the
    // operation failed — the deploy/destroy/validate script is very
    // likely still running server-side. Preserve currentOpId, do not
    // touch the terminal status, and fall back to authenticated polling
    // for status/log deltas until a genuine terminal state is reported.
    es.close();
    currentEventSource = null;
    startOperationPolling(opId);
  };
}

function setInfraButtonsEnabled(enabled) {
  ['btn-deploy','btn-destroy','btn-validate'].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
}

async function startDeploy() {
  const location = document.getElementById('deploy-location').value;
  const workloadName = document.getElementById('deploy-workload').value || 'srelab';
  const skipRbac = document.getElementById('deploy-skip-rbac').checked;
  const skipSreAgent = document.getElementById('deploy-skip-sre').checked;

  setInfraButtonsEnabled(false);
  try {
    const r = await apiClient.request('deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location, workloadName, skipRbac, skipSreAgent }),
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || 'Deploy failed to start', 'error'); setInfraButtonsEnabled(true); return; }
    toast('Deployment started');
    streamOperation(data.id);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    setInfraButtonsEnabled(true);
  }
}

function confirmDestroy() {
  const rg = document.getElementById('destroy-rg').value || 'rg-srelab-eastus2';
  document.getElementById('destroy-modal-rg').textContent = rg;
  document.getElementById('destroy-modal').style.display = '';
}

function dismissDestroyModal() {
  document.getElementById('destroy-modal').style.display = 'none';
}

async function executeDestroy() {
  dismissDestroyModal();
  const rg = document.getElementById('destroy-rg').value || 'rg-srelab-eastus2';
  setInfraButtonsEnabled(false);
  try {
    const r = await apiClient.request('destroy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceGroupName: rg }),
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || 'Destroy failed to start', 'error'); setInfraButtonsEnabled(true); return; }
    toast('Destroy operation started');
    streamOperation(data.id);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    setInfraButtonsEnabled(true);
  }
}

async function startValidate() {
  const rg = document.getElementById('validate-rg').value || 'rg-srelab-eastus2';
  setInfraButtonsEnabled(false);
  try {
    const r = await apiClient.request('validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceGroupName: rg }),
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || 'Validate failed to start', 'error'); setInfraButtonsEnabled(true); return; }
    toast('Validation started');
    streamOperation(data.id);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
    setInfraButtonsEnabled(true);
  }
}

/**
 * Cancels the in-progress operation. The decision logic for interpreting
 * the server's response — including the "cancellation lost the race,
 * never fabricate success" behavior — lives in the standalone,
 * unit-tested cancel-response.js module so it can be verified without a
 * real browser DOM.
 */
async function cancelOperation() {
  if (!currentOpId) return;
  const opId = currentOpId;
  try {
    const response = await apiClient.request('operations/' + opId, { method: 'DELETE' });
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON body; interpretCancelOperationResponse falls back to a generic truthful message */ }

    const result = window.MissionControlCancelResponse.interpretCancelOperationResponse({ ok: response.ok, status: response.status, data });
    toast(result.toastMessage, result.toastType);
    if (result.terminalInfo && currentOpId === opId) {
      handleTerminalOperation(result.terminalInfo);
    }
  } catch (e) {
    toast('Cancel failed: ' + e.message, 'error');
  }
}

/* ── Pod Log Viewer ───────────────────────────────────── */
async function showPodLogs(podName) {
  document.getElementById('log-modal-pod').textContent = podName;
  document.getElementById('log-modal-content').textContent = 'Loading...';
  document.getElementById('log-modal').style.display = '';
  try {
    const data = await api('pods/' + encodeURIComponent(podName) + '/logs');
    document.getElementById('log-modal-content').textContent = data.logs || data.error || 'No logs available';
  } catch (e) {
    document.getElementById('log-modal-content').textContent = 'Error: ' + e.message;
  }
}

function closeLogModal() {
  document.getElementById('log-modal').style.display = 'none';
}

/* ── Resource Group Auto-Sync ─────────────────────────── */
document.getElementById('deploy-workload').addEventListener('input', syncRGFields);
document.getElementById('deploy-location').addEventListener('change', syncRGFields);

function syncRGFields() {
  const wl = document.getElementById('deploy-workload').value || 'srelab';
  const loc = document.getElementById('deploy-location').value;
  const rg = 'rg-' + wl + '-' + loc;
  document.getElementById('validate-rg').value = rg;
  document.getElementById('destroy-rg').value = rg;
}

/* ── Copilot Chat ─────────────────────────────────────── */
let chatOpen = false;
let chatStreaming = false;

function toggleChat() {
  chatOpen = !chatOpen;
  document.getElementById('chat-panel').classList.toggle('open', chatOpen);
  document.getElementById('chat-toggle').classList.toggle('hidden', chatOpen);
  if (chatOpen) document.getElementById('chat-input').focus();
}

function handleGlobalClick(event) {
  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;

  if (actionEl.dataset.stopPropagation === 'true') {
    event.stopPropagation();
  }

  const action = actionEl.getAttribute('data-action');
  switch (action) {
    case 'toggle-chat':
      toggleChat();
      break;
    case 'analyze-failure':
      analyzeFailureWithCopilot();
      break;
    case 'fix':
      fix(actionEl.dataset.fixType || 'all', actionEl);
      break;
    case 'break-scenario':
      breakScenario(actionEl.dataset.scenarioId, actionEl);
      break;
    case 'deploy':
      startDeploy();
      break;
    case 'validate':
      startValidate();
      break;
    case 'confirm-destroy':
      confirmDestroy();
      break;
    case 'dismiss-destroy':
      dismissDestroyModal();
      break;
    case 'execute-destroy':
      executeDestroy();
      break;
    case 'close-log':
      closeLogModal();
      break;
    case 'close-terminal':
      closeTerminal();
      break;
    case 'cancel-op':
      cancelOperation();
      break;
    case 'reset-chat':
      resetChat();
      break;
    case 'quick-prompt':
      sendQuickPrompt(actionEl);
      break;
    case 'send-chat':
      sendChatMessage();
      break;
    case 'export-incident-md':
      exportIncident('md');
      break;
    case 'export-incident-json':
      exportIncident('json');
      break;
    case 'presenter-select-track': {
      const nextTrackId = actionEl.dataset.trackId || selectedPresenterTrackId;
      if (!nextTrackId) break;
      if (presenterState && ['running','paused','complete','aborted'].includes(presenterState.status)) {
        toast('Reset or reconnect the current presenter run before changing tracks', 'error');
        break;
      }
      selectedPresenterTrackId = nextTrackId;
      if (presenterState) {
        presenterState = { ...presenterState, trackId: nextTrackId, status: 'idle', currentStepId: null, focusedPanels: [] };
      }
      renderPresenterState();
      break;
    }
    case 'presenter-start':
      startPresenterTrack();
      break;
    case 'presenter-continue':
      continuePresenterTrack();
      break;
    case 'presenter-pause':
      pausePresenterTrack();
      break;
    case 'presenter-resume':
      resumePresenterTrack();
      break;
    case 'presenter-abort':
      abortPresenterTrack();
      break;
    case 'presenter-reset':
      resetPresenterTrack();
      break;
    case 'presenter-reconnect':
      reconnectPresenterTrack();
      break;
    case 'presenter-toggle-notes':
      togglePresenterNotes();
      break;
    case 'presenter-focus-mode':
      togglePresenterFocusMode();
      break;
    case 'submit-remote-auth':
      submitRemoteAuthToken();
      break;
    case 'cancel-remote-auth':
      cancelRemoteAuthModal();
      break;
  }
}

function handleChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
  // Auto-resize textarea
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function sendQuickPrompt(btn) {
  document.getElementById('chat-input').value = btn.textContent;
  sendChatMessage();
}

function appendChatMsg(role, text) {
  const msgDiv = render.buildChatMessage(role, text, document);
  const container = document.getElementById('chat-messages');
  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;
  return msgDiv;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'chat-typing';
  el.id = 'chat-typing';
  ['first', 'second', 'third'].forEach((_, index) => {
    const span = document.createElement('span');
    if (index === 1) span.style.animationDelay = '.15s';
    if (index === 2) span.style.animationDelay = '.3s';
    el.appendChild(span);
  });
  const container = document.getElementById('chat-messages');
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

function showIntent(text) {
  let el = document.getElementById('chat-intent-current');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chat-intent';
    el.id = 'chat-intent-current';
    const container = document.getElementById('chat-messages');
    container.appendChild(el);
  }
  el.textContent = '⏳ ' + text;
  document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;
}

function hideIntent() {
  const el = document.getElementById('chat-intent-current');
  if (el) el.remove();
}

function addToolCard(name, args) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.id = 'tool-card-' + String(name || 'tool') + '-' + Date.now();

  const header = document.createElement('div');
  header.className = 'tool-header';

  const icon = document.createElement('span');
  icon.className = 'tool-icon';
  icon.textContent = '⚙️';
  header.appendChild(icon);

  const title = document.createElement('span');
  title.textContent = String(name || 'tool');
  header.appendChild(title);

  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  spinner.style.width = '10px';
  spinner.style.height = '10px';
  spinner.style.borderWidth = '1.5px';
  header.appendChild(spinner);
  card.appendChild(header);

  const argsStr = args ? JSON.stringify(args, null, 0) : '';
  if (argsStr && argsStr !== '{}') {
    const argsEl = document.createElement('div');
    argsEl.className = 'tool-args';
    argsEl.textContent = argsStr;
    card.appendChild(argsEl);
  }

  const container = document.getElementById('chat-messages');
  container.appendChild(card);
  container.scrollTop = container.scrollHeight;
  return card;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || chatStreaming) return;

  const welcome = document.getElementById('chat-welcome');
  if (welcome) welcome.style.display = 'none';

  appendChatMsg('user', message);
  input.value = '';
  input.style.height = 'auto';

  chatStreaming = true;
  document.getElementById('chat-send').disabled = true;
  showTyping();

  try {
    const resp = await apiClient.request('chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    hideTyping();

    if (!resp.ok) {
      const err = await resp.json();
      appendChatMsg('assistant', 'Error: ' + (err.error || 'Request failed'));
    } else {
      const data = await resp.json();
      appendChatMsg('assistant', data.content || '(no response)');
    }
  } catch (err) {
    hideTyping();
    appendChatMsg('assistant', 'Connection error: ' + err.message);
  }

  chatStreaming = false;
  document.getElementById('chat-send').disabled = false;
}

async function resetChat() {
  try {
    await apiClient.request('chat/reset', { method: 'POST' });
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    const welcome = document.getElementById('chat-welcome');
    if (welcome) {
      welcome.style.display = 'block';
      container.appendChild(welcome);
    } else {
      container.innerHTML = '<div class="chat-welcome" id="chat-welcome">' +
        '<h4>🔥 ZavaGas AI Operations Assistant</h4>' +
        '<p>Powered by GitHub Copilot SDK — ask me anything about your propane platform.</p>' +
        '<div class="quick-prompts">' +
        '<button class="quick-prompt" data-action="quick-prompt">What\'s the health of my cluster?</button>' +
        '<button class="quick-prompt" data-action="quick-prompt">Why is order-service restarting?</button>' +
        '<button class="quick-prompt" data-action="quick-prompt">Fix all broken services</button>' +
        '<button class="quick-prompt" data-action="quick-prompt">Show me recent warning events</button>' +
        '<button class="quick-prompt" data-action="quick-prompt">Validate the deployment</button>' +
        '</div></div>';
    }
    toast('Chat session reset', 'success');
  } catch (err) {
    toast('Failed to reset: ' + err.message, 'error');
  }
}

document.addEventListener('click', handleGlobalClick);
document.getElementById('chat-input').addEventListener('keydown', handleChatKey);
document.getElementById('remote-auth-token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitRemoteAuthToken(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelRemoteAuthModal(); }
});

// Check Copilot status periodically
async function checkCopilotStatus() {
  try {
    const s = await api('copilot/status');
    const badge = document.getElementById('chat-badge');
    const status = document.getElementById('chat-conn-status');
    const bannerStatus = document.getElementById('copilot-banner-status');
    if (s.ready) {
      badge.className = 'badge-dot connected';
      status.className = 'chat-status ok';
      status.textContent = 'connected';
      bannerStatus.className = 'banner-status ok';
      bannerStatus.textContent = '● Ready';
    } else if (s.error) {
      badge.className = 'badge-dot disconnected';
      status.className = 'chat-status err';
      status.textContent = 'error';
      bannerStatus.className = 'banner-status err';
      bannerStatus.textContent = '● ' + (s.error.length > 40 ? s.error.slice(0, 40) + '…' : s.error);
    } else {
      badge.className = 'badge-dot loading';
      status.className = 'chat-status init';
      status.textContent = 'connecting…';
      bannerStatus.className = 'banner-status init';
      bannerStatus.textContent = '● Connecting…';
    }
  } catch {
    document.getElementById('chat-badge').className = 'badge-dot disconnected';
    const bs = document.getElementById('copilot-banner-status');
    bs.className = 'banner-status err';
    bs.textContent = '● Server unreachable';
  }
}

// Analyze a failed operation with Copilot
function analyzeFailureWithCopilot() {
  const failure = window._lastFailure;
  if (!failure) return;

  // Hide the failure banner
  document.getElementById('copilot-failure-banner').style.display = 'none';

  // Build a diagnostic prompt with log context
  const logExcerpt = failure.logTail.slice(-1500);
  const prompt = 'A deployment operation just failed with exit code ' + failure.exitCode + '. ' +
    'Analyze this log excerpt and tell me what went wrong and how to fix it:\n\n```\n' +
    logExcerpt + '\n```';

  // Open chat and send the prompt
  if (!chatOpen) toggleChat();

  // Hide welcome
  const welcome = document.getElementById('chat-welcome');
  if (welcome) welcome.style.display = 'none';

  document.getElementById('chat-input').value = prompt;
  sendChatMessage();
}

checkCopilotStatus();
setInterval(checkCopilotStatus, 15000);
