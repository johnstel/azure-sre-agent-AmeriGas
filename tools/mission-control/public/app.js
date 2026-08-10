
/* ── Scenario Definitions ─────────────────────────────── */
const SCENARIOS = [
  { id:'oom',     name:'OOMKilled',        desc:'Tank monitor memory exhaustion',           icon:'💾' },
  { id:'crash',   name:'CrashLoopBackOff', desc:'Inventory service bad config crash',       icon:'💥' },
  { id:'image',   name:'ImagePullBackOff', desc:'Order service wrong image tag',             icon:'🖼️' },
  { id:'cpu',     name:'High CPU',         desc:'Demand forecast calculation overload',      icon:'🔥' },
  { id:'pending', name:'Pending Pods',     desc:'Fleet telemetry over-provisioned requests', icon:'⏳' },
  { id:'probe',   name:'Probe Failure',    desc:'Safety compliance monitor bad probes',      icon:'💓' },
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
  mongodb: p => p.name.startsWith('mongodb') && (p.ready === '0/1' || p.status !== 'Running'),
  network: null, // detected via networkpolicies API
  service: null, // detected via endpoints API
};

let currentPods = [];
let networkPolicyActive = false;
let serviceMismatchActive = false;
const render = window.MissionControlRender;
  
/* ── API Helpers ───────────────────────────────────────── */
async function api(path, opts) {
  const r = await fetch('/api/' + path, opts);
  return r.json();
}

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

setInterval(refreshPods, 5000);
setInterval(refreshEvents, 10000);
setInterval(refreshServices, 15000);
setInterval(refreshDeployments, 10000);
setInterval(refreshNodes, 30000);
setInterval(refreshNetworkPolicies, 5000);
setInterval(refreshEndpoints, 5000);

/* ── Infrastructure Operations ────────────────────────── */
let currentOpId = null;
let currentEventSource = null;

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
}

function setTerminalStatus(status) {
  const badge = document.getElementById('terminal-status');
  badge.textContent = status;
  badge.className = 'terminal-badge ' + status;
  const cancelBtn = document.getElementById('btn-cancel-op');
  cancelBtn.style.display = status === 'running' ? '' : 'none';
}

function streamOperation(opId) {
  currentOpId = opId;
  const out = document.getElementById('terminal-output');
  out.textContent = '';
  setTerminalStatus('running');
  showTerminal();

  if (currentEventSource) currentEventSource.close();
  const es = new EventSource('/api/operations/' + opId + '/stream');
  currentEventSource = es;

  es.onmessage = (e) => {
    const entry = JSON.parse(e.data);
    const span = document.createElement('span');
    if (entry.stream === 'stderr') span.style.color = '#f85149';
    else if (entry.stream === 'system') span.style.color = '#58a6ff';
    span.textContent = entry.text;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
  };

  es.addEventListener('done', (e) => {
    const info = JSON.parse(e.data);
    setTerminalStatus(info.status);
    es.close();
    currentEventSource = null;

    // On failure, show the Copilot failure diagnosis banner
    if (info.status === 'failed') {
      const termOutput = document.getElementById('terminal-output').textContent || '';
      // Store failure context for Copilot
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
  });

  es.onerror = () => {
    setTerminalStatus('failed');
    es.close();
    currentEventSource = null;
    currentOpId = null;
    setInfraButtonsEnabled(true);
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
    const r = await fetch('/api/deploy', {
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
    const r = await fetch('/api/destroy', {
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
    const r = await fetch('/api/validate', {
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
    await fetch('/api/operations/' + currentOpId, { method: 'DELETE' });
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
    const r = await fetch('/api/pods/' + encodeURIComponent(podName) + '/logs');
    const data = await r.json();
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
    const resp = await fetch('/api/chat', {
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
    await fetch('/api/chat/reset', { method: 'POST' });
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

// Check Copilot status periodically
async function checkCopilotStatus() {
  try {
    const r = await fetch('/api/copilot/status');
    const s = await r.json();
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
