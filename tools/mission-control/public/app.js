
/* ── Scenario Definitions ─────────────────────────────── */
const SCENARIOS = [
  { id:'oom',     name:'OOMKilled',        desc:'Tank monitor memory exhaustion',           icon:'💾' },
  { id:'crash',   name:'CrashLoopBackOff', desc:'Inventory service bad config crash',       icon:'💥' },
  { id:'image',   name:'ImagePullBackOff', desc:'Order service wrong image tag',             icon:'🖼️' },
  { id:'cpu',     name:'High CPU',         desc:'Demand forecast calculation overload',      icon:'🔥' },
  { id:'pending', name:'Pending Pods',     desc:'Fleet telemetry over-provisioned requests', icon:'⏳' },
  { id:'probe',   name:'Bulk Tank Safety Alarm', desc:'Healthy workload + delayed safety alarm', icon:'💓' },
  { id:'network', name:'Network Block',    desc:'Tank monitor network policy isolation',     icon:'🌐' },
  { id:'config',  name:'Missing Config',   desc:'Delivery zone missing ConfigMap',           icon:'📄' },
  { id:'mongodb', name:'MongoDB Down',     desc:'Database outage — cascading failure',       icon:'🗄️' },
  { id:'service', name:'Service Mismatch', desc:'Tank monitor selector drift after v2',      icon:'🔀' },
];

// Pods whose presence/state indicate a scenario is active
const SCENARIO_INDICATORS = {
  oom:     p => p.name.startsWith('tank-monitor') && (p.reason === 'OOMKilled' || p.status === 'CrashLoopBackOff' || p.restarts > 2),
  crash:   p => p.name.startsWith('inventory-service') && (p.status === 'CrashLoopBackOff' || p.status === 'Error'),
  image:   p => p.name.startsWith('order-service') && (p.status === 'ImagePullBackOff' || p.status === 'ErrImagePull'),
  cpu:     p => p.name.startsWith('demand-forecast'),
  pending: p => p.name.startsWith('fleet-telemetry'),
  probe:   p => p.name.startsWith('safety-compliance'),
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
  for (const sc of SCENARIOS) {
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
  const fragment = document.createDocumentFragment();

  SCENARIOS.forEach(sc => {
    const card = document.createElement('div');
    card.className = 'scenario-card';

    const name = document.createElement('div');
    name.className = 'sc-name';
    name.textContent = sc.icon + ' ' + sc.name;
    card.appendChild(name);

    const desc = document.createElement('div');
    desc.className = 'sc-desc';
    desc.textContent = sc.desc;
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

function exportIncident(format) {
  if (!currentIncidentCorrelationId) return;
  const url = '/api/incidents/' + encodeURIComponent(currentIncidentCorrelationId) + '/export.' + format;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/* ── Init ──────────────────────────────────────────────── */
buildScenarioGrid();
refreshPods();
refreshEvents();
refreshServices();
refreshNodes();
refreshDeployments();
refreshClusterInfo();
refreshNetworkPolicies();
refreshEndpoints();
refreshActiveIncident();
refreshRecentIncidents();

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

/** Appends already-parsed log entries to the terminal output. Shared by both the EventSource path and the polling fallback so neither can render a log line the other already showed. */
function appendLogEntries(entries) {
  const out = document.getElementById('terminal-output');
  for (const entry of entries) {
    const span = document.createElement('span');
    if (entry.stream === 'stderr') span.style.color = '#f85149';
    else if (entry.stream === 'system') span.style.color = '#58a6ff';
    span.textContent = entry.text;
    out.appendChild(span);
  }
  if (entries.length > 0) out.scrollTop = out.scrollHeight;
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

async function cancelOperation() {
  if (!currentOpId) return;
  try {
    await apiClient.request('operations/' + currentOpId, { method: 'DELETE' });
    toast('Operation cancelled');
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
        '<h4>🔥 AmeriGas AI Operations Assistant</h4>' +
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
