const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { evaluateScenarioHealth } = require('./scenario-health');
const { SCENARIO_MAP, SCENARIO_METADATA } = require('./scenario-catalog');

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_NAMESPACE = 'propane';
const STATE_CONFIGMAP_NAME = 'demo-scenario-lifecycle-state';
const LOCK_CONFIGMAP_NAME = 'demo-scenario-lifecycle-lock';
const UNRESOLVED_LIFECYCLE_PHASES = new Set([
  'active',
  'starting',
  'failed',
  'partial',
  'apply-failed',
  'activation-timeout',
]);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function deepSort(value) {
  if (Array.isArray(value)) return value.map(deepSort);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const next = deepSort(value[key]);
      if (typeof next !== 'undefined') out[key] = next;
    }
    return out;
  }
  return value;
}

function canonicalizeNonSecret(value) {
  if (Array.isArray(value)) return value.map(canonicalizeNonSecret);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const lower = key.toLowerCase();
    if (
      lower.includes('timestamp') ||
      lower.includes('time') ||
      lower.includes('uid') ||
      lower.includes('version') ||
      lower.includes('status') ||
      lower.includes('conditions') ||
      lower === 'creationtimestamp' ||
      lower === 'managedfields' ||
      lower === 'selflink'
    ) {
      continue;
    }
    out[key] = canonicalizeNonSecret(value[key]);
  }
  return out;
}

function normalizeScenarioId(raw) {
  const input = String(raw || '').trim().toLowerCase();
  if (!input) {
    throw new Error('Scenario ID is required. Valid values: ' + Object.keys(SCENARIO_MAP).join(', '));
  }

  const aliases = {
    'refill': 'backlog',
    'refill-backlog': 'backlog',
    'refill-order-backlog': 'backlog',
    'bulk-tank-safety-alarm': 'probe',
    'safety-alarm': 'probe',
    'network-policy': 'network',
    'service-selector-mismatch': 'service',
    'service-mismatch': 'service',
  };

  const normalized = aliases[input] || input;
  if (SCENARIO_MAP[normalized]) return normalized;

  const known = Object.keys(SCENARIO_MAP).join(', ');
  throw new Error(`Unknown scenario: "${raw}". Valid values: ${known}`);
}

function manifestIdForFile(fileName) {
  const name = String(fileName || '').replace(/\.ya?ml$/i, '');
  const resolved = Object.entries(SCENARIO_MAP).find(([, manifest]) => manifest === fileName);
  if (resolved) return resolved[0];
  const aliasMap = {
    'oom-killed': 'oom',
    'crash-loop': 'crash',
    'image-pull-backoff': 'image',
    'high-cpu': 'cpu',
    'pending-pods': 'pending',
    'probe-failure': 'probe',
    'network-block': 'network',
    'missing-config': 'config',
    'mongodb-down': 'mongodb',
    'service-mismatch': 'service',
    'refill-order-backlog': 'backlog',
  };
  return aliasMap[name] || name;
}

function readClusterJson(runner, args) {
  if (runner && typeof runner.readJson === 'function') {
    return Promise.resolve(runner.readJson(args));
  }
  if (runner && typeof runner.execFile === 'function') {
    return runner.execFile('kubectl', args).then((result) => {
      const text = result && result.stdout ? result.stdout : '';
      if (!text.trim()) return { items: [] };
      const parsed = JSON.parse(text);
      return parsed && parsed.items ? parsed : { items: [] };
    });
  }

  const child = spawnSync('kubectl', args, { encoding: 'utf8' });
  if (child.status !== 0 || !child.stdout || !child.stdout.trim()) {
    return Promise.resolve({ items: [] });
  }
  try {
    const parsed = JSON.parse(child.stdout);
    return Promise.resolve(parsed && parsed.items ? parsed : { items: [] });
  } catch {
    return Promise.resolve({ items: [] });
  }
}

function isUnresolvedLifecycleState(state = {}) {
  const phase = String(state.phase || '').trim().toLowerCase();
  if (!phase || !UNRESOLVED_LIFECYCLE_PHASES.has(phase)) return false;
  if (state.endTime) return false;
  return true;
}

async function collectClusterSnapshot(repoRoot, runner, namespace = DEFAULT_NAMESPACE) {
  const args = [
    ['get', 'pods', '-n', namespace, '-o', 'json'],
    ['get', 'deployments', '-n', namespace, '-o', 'json'],
    ['get', 'svc', '-n', namespace, '-o', 'json'],
    ['get', 'endpoints', '-n', namespace, '-o', 'json'],
    ['get', 'networkpolicy', '-n', namespace, '-o', 'json'],
    ['get', 'configmaps', '-n', namespace, '-o', 'json'],
  ];

  const results = await Promise.all(args.map((cmd) => readClusterJson(runner, cmd)));
  return {
    repoRoot,
    namespace,
    pods: results[0] && results[0].items ? results[0].items : [],
    deployments: results[1] && results[1].items ? results[1].items : [],
    services: results[2] && results[2].items ? results[2].items : [],
    endpoints: results[3] && results[3].items ? results[3].items : [],
    networkPolicies: results[4] && results[4].items ? results[4].items : [],
    configMaps: results[5] && results[5].items ? results[5].items : [],
  };
}

function fingerprintDeployment(dep) {
  const template = dep?.spec?.template || {};
  const podSpec = template.spec || {};
  const containers = (podSpec.containers || []).map((container) => ({
    name: container.name,
    image: container.image,
    command: container.command,
    args: container.args,
    env: (container.env || []).map((item) => ({
      name: item.name,
      value: item.value,
      valueFrom: item.valueFrom ? Object.keys(item.valueFrom).sort() : undefined,
    })),
    resources: container.resources,
    readinessProbe: container.readinessProbe,
    livenessProbe: container.livenessProbe,
    startupProbe: container.startupProbe,
    ports: (container.ports || []).map((port) => ({
      containerPort: port.containerPort,
      protocol: port.protocol,
      name: port.name,
    })),
  }));

  return {
    name: dep?.metadata?.name,
    replicas: dep?.spec?.replicas,
    selector: dep?.spec?.selector,
    podLabels: template.metadata && template.metadata.labels,
    containers,
  };
}

function fingerprintService(service) {
  return {
    name: service?.metadata?.name,
    type: service?.spec?.type,
    selector: service?.spec?.selector,
    ports: service?.spec?.ports,
  };
}

function fingerprintConfigMap(cm) {
  return {
    name: cm?.metadata?.name,
    data: cm?.data,
    binaryData: cm?.binaryData,
  };
}

function fingerprintNetworkPolicy(policy) {
  return {
    name: policy?.metadata?.name,
    spec: policy?.spec,
  };
}

function computeBaselineFingerprint(clusterSnapshot) {
  const snapshot = clusterSnapshot || {};
  const deployments = (snapshot.deployments || []).map(fingerprintDeployment);
  const services = (snapshot.services || []).map(fingerprintService);
  const configMaps = (snapshot.configMaps || []).map(fingerprintConfigMap);
  const networkPolicies = (snapshot.networkPolicies || []).map(fingerprintNetworkPolicy);
  const canonical = canonicalizeNonSecret({
    deployments: deepSort(deployments),
    services: deepSort(services),
    configMaps: deepSort(configMaps),
    networkPolicies: deepSort(networkPolicies),
  });
  return sha256(JSON.stringify(canonical));
}

function readLifecycleState(repoRoot, runner, namespace = DEFAULT_NAMESPACE) {
  const statePath = path.join(repoRoot, '.data', 'scenario-lifecycle-state.json');
  if (runner && typeof runner.readState === 'function') return Promise.resolve(runner.readState(namespace));
  if (runner && typeof runner.readLifecycleState === 'function') return Promise.resolve(runner.readLifecycleState(namespace));

  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return Promise.resolve(raw ? JSON.parse(raw) : null);
  } catch {
    return Promise.resolve(null);
  }
}

function writeLifecycleState(repoRoot, runner, state, namespace = DEFAULT_NAMESPACE) {
  const statePath = path.join(repoRoot, '.data', 'scenario-lifecycle-state.json');
  if (runner && typeof runner.writeState === 'function') {
    return Promise.resolve(runner.writeState(namespace, state));
  }
  if (runner && typeof runner.writeLifecycleState === 'function') {
    return Promise.resolve(runner.writeLifecycleState(namespace, state));
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return Promise.resolve(state);
}

function readLifecycleLock(repoRoot, runner, namespace = DEFAULT_NAMESPACE) {
  const lockPath = path.join(repoRoot, '.data', 'scenario-lifecycle-lock.json');
  if (runner && typeof runner.readLock === 'function') return Promise.resolve(runner.readLock(namespace));
  if (runner && typeof runner.readLifecycleLock === 'function') return Promise.resolve(runner.readLifecycleLock(namespace));
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    return Promise.resolve(raw ? JSON.parse(raw) : null);
  } catch {
    return Promise.resolve(null);
  }
}

function writeLifecycleLock(repoRoot, runner, state, namespace = DEFAULT_NAMESPACE) {
  const lockPath = path.join(repoRoot, '.data', 'scenario-lifecycle-lock.json');
  if (runner && typeof runner.writeLock === 'function') {
    return Promise.resolve(runner.writeLock(namespace, state));
  }
  if (runner && typeof runner.writeLifecycleLock === 'function') {
    return Promise.resolve(runner.writeLifecycleLock(namespace, state));
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(state, null, 2));
  return Promise.resolve(state);
}

function releaseLifecycleLock(repoRoot, runner, namespace = DEFAULT_NAMESPACE) {
  return writeLifecycleLock(repoRoot, runner, { locked: false, namespace, releasedAt: new Date().toISOString() }, namespace);
}

async function acquireLifecycleLock(repoRoot, runner, namespace = DEFAULT_NAMESPACE, scenarioId = null, { allowStacking = false } = {}) {
  const current = await readLifecycleLock(repoRoot, runner, namespace);
  const runId = `scenario-${scenarioId || 'reset'}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const lockState = {
    locked: true,
    namespace,
    scenarioId,
    allowStacking,
    runId,
    acquiredAt: new Date().toISOString(),
  };

  if (current && current.locked && current.scenarioId && !allowStacking) {
    const sameScenario = current.scenarioId === scenarioId;
    return {
      ok: false,
      code: sameScenario ? 'SCENARIO_REENTRY_BLOCKED' : 'SCENARIO_LOCKED',
      phase: 'blocked',
      scenarioId,
      activeScenarioId: current.scenarioId,
      message: sameScenario
        ? `Scenario "${scenarioId || 'unknown'}" is already active or unresolved. Reset the lifecycle or explicitly use -AllowStacking for unsupported testing.`
        : `Scenario "${scenarioId || 'unknown'}" cannot start while "${current.scenarioId}" owns the lifecycle lock. Reset or use -AllowStacking only for unsupported testing.`,
      lockState: current,
    };
  }

  await writeLifecycleLock(repoRoot, runner, lockState, namespace);
  return { ok: true, runId, lockState };
}

function inventoryScenarioResources(repoRoot) {
  const scenarioDir = path.join(repoRoot, 'k8s', 'scenarios');
  if (!fs.existsSync(scenarioDir)) return [];

  const files = fs.readdirSync(scenarioDir)
    .filter((file) => /\.ya?ml$/i.test(file))
    .sort();

  return files.map((file) => {
    const filePath = path.join(scenarioDir, file);
    const source = fs.readFileSync(filePath, 'utf8');
    const manifestHash = sha256(source);
    const yamlDocs = source.split(/^---\s*$/m).map((part) => part.trim()).filter(Boolean);
    const resources = yamlDocs.map((part) => {
      const kindMatch = part.match(/^kind:\s*(.+)$/m);
      const nameMatch = part.match(/(?:^|\n)metadata:\s*\n(?:.*\n)*?\s*name:\s*(.+)$/m);
      const labelsMatch = part.match(/(?:^|\n)metadata:\s*\n(?:.*\n)*?\s*labels:\s*\n((?:\s{2,}.*\n)+)/m);
      return {
        kind: kindMatch ? kindMatch[1].trim() : null,
        name: nameMatch ? nameMatch[1].trim() : null,
        labels: labelsMatch ? labelsMatch[1].trim() : null,
      };
    }).filter((resource) => resource.kind && resource.name);

    const scenarioId = manifestIdForFile(file);
    return {
      scenarioId,
      file,
      filePath,
      manifestHash,
      resources,
      metadata: SCENARIO_METADATA[scenarioId] || {},
    };
  });
}

function getBaselineDeployments() {
  return [
    'customer-portal',
    'dispatch-console',
    'tank-monitor',
    'inventory-service',
    'order-service',
    'usage-simulator',
    'order-worker',
    'rabbitmq',
    'mongodb',
    'otel-collector',
    'demand-forecast-overload',
    'fleet-telemetry-monitor',
    'delivery-zone-config',
    'safety-compliance-monitor',
    'refill-order-backlog-simulator',
  ];
}

function verifyBaselineState(clusterSnapshot) {
  const snapshot = clusterSnapshot || {};
  const deployments = snapshot.deployments || [];
  const services = snapshot.services || [];
  const endpoints = snapshot.endpoints || [];
  const remaining = [];

  const baselineDeployments = [
    'customer-portal',
    'dispatch-console',
    'tank-monitor',
    'inventory-service',
    'order-service',
    'usage-simulator',
    'order-worker',
    'rabbitmq',
    'mongodb',
    'otel-collector',
  ];

  for (const name of baselineDeployments) {
    const dep = deployments.find((item) => item?.metadata?.name === name);
    if (!dep) {
      remaining.push(`${name}: deployment missing`);
      continue;
    }
    const desired = Number(dep.spec?.replicas || 1);
    const available = Number(dep.status?.availableReplicas || 0);
    const ready = Number(dep.status?.readyReplicas || 0);
    if (desired > 0 && available < desired) {
      remaining.push(`${name}: available ${available}/${desired}`);
    }
    if (desired > 0 && ready < desired) {
      remaining.push(`${name}: ready ${ready}/${desired}`);
    }
  }

  for (const name of ['customer-portal', 'dispatch-console', 'tank-monitor', 'inventory-service', 'order-service', 'mongodb', 'rabbitmq']) {
    const service = services.find((item) => item?.metadata?.name === name);
    if (!service) {
      remaining.push(`${name}: service missing`);
      continue;
    }
    const endpoint = endpoints.find((item) => item?.metadata?.name === name);
    const subsets = endpoint?.subsets || [];
    const totalAddresses = subsets.reduce((sum, subset) => sum + ((subset.addresses || []).length), 0);
    if (totalAddresses === 0) {
      remaining.push(`${name}: no endpoints`);
    }
  }

  return {
    ok: remaining.length === 0,
    remaining,
  };
}

function scenarioStateKey(namespace = DEFAULT_NAMESPACE) {
  return `${namespace}:${STATE_CONFIGMAP_NAME}`;
}

async function applyScenarioJob(runner, manifestPath, { whatIf = false } = {}) {
  if (whatIf) {
    return { ok: true, dryRun: true, command: ['kubectl', 'apply', '-f', manifestPath], message: `WhatIf: would apply ${manifestPath}` };
  }

  if (runner && typeof runner.exec === 'function') {
    const result = await runner.exec('kubectl', ['apply', '-f', manifestPath]);
    return { ok: true, dryRun: false, message: result || `Applied ${manifestPath}` };
  }

  try {
    const raw = execFileSync('kubectl', ['apply', '-f', manifestPath], { encoding: 'utf8' });
    return { ok: true, dryRun: false, message: raw.trim() || `Applied ${manifestPath}` };
  } catch (error) {
    return { ok: false, dryRun: false, error: String(error.message || error), message: String(error.message || error) };
  }
}

async function resetScenarioOwnedResources(repoRoot, runner, { scope = 'all', whatIf = false, namespace = DEFAULT_NAMESPACE } = {}) {
  const inventory = inventoryScenarioResources(repoRoot);
  const namesByKind = new Map();
  for (const scenario of inventory) {
    for (const resource of scenario.resources) {
      if (!resource.kind || !resource.name) continue;
      if (scope === 'network' && resource.kind.toLowerCase() !== 'networkpolicy') continue;
      if (scope === 'extras' && resource.kind.toLowerCase() !== 'deployment' && resource.kind.toLowerCase() !== 'configmap') continue;
      const key = resource.kind.toLowerCase();
      if (!namesByKind.has(key)) namesByKind.set(key, []);
      namesByKind.get(key).push(resource.name);
    }
  }

  const results = [];
  for (const [kind, names] of namesByKind.entries()) {
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length === 0) continue;
    if (whatIf) {
      results.push({ kind, names: uniqueNames, message: `WhatIf: would delete ${uniqueNames.join(', ')}` });
      continue;
    }
    const args = ['delete', kind, ...uniqueNames, '-n', namespace, '--ignore-not-found'];
    let output = '';
    if (runner && typeof runner.exec === 'function') {
      output = await runner.exec('kubectl', args);
    } else {
      try {
        output = execFileSync('kubectl', args, { encoding: 'utf8' });
      } catch (error) {
        const msg = String(error && error.stderr ? error.stderr : error.message || error);
        output = msg;
      }
    }
    results.push({ kind, names: uniqueNames, message: output && output.trim() ? output.trim() : `Deleted ${uniqueNames.join(', ')}` });
  }
  return { ok: true, results, scope };
}

async function waitForActivation(scenarioId, repoRoot, runner, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 60000);
  const pollMs = Number(options.pollMs || 2000);
  const namespace = options.namespace || DEFAULT_NAMESPACE;
  const startTs = Date.now();
  let lastHealth = null;
  let lastSnapshot = null;

  const minimumIntervalMs = Math.max(1, Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 1);
  const maxAttempts = Math.max(2, Math.ceil(timeoutMs / minimumIntervalMs) + 2);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await collectClusterSnapshot(repoRoot, runner, namespace);
    lastSnapshot = snapshot;
    lastHealth = evaluateScenarioHealth(scenarioId, snapshot);
    if (lastHealth && lastHealth.active === true) {
      return { ok: true, health: lastHealth, snapshot };
    }

    if (Date.now() - startTs >= timeoutMs) {
      break;
    }

    if (attempt < maxAttempts - 1) {
      const delayMs = Math.max(0, pollMs);
      if (delayMs > 0 || attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  return {
    ok: false,
    health: lastHealth,
    snapshot: lastSnapshot,
    message: `Scenario "${scenarioId}" did not activate within ${timeoutMs}ms. Last health signal: ${lastHealth ? lastHealth.reason : 'unknown'}`,
  };
}

async function startDemoScenario(scenarioId, options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const namespace = options.namespace || DEFAULT_NAMESPACE;
  const allowStacking = Boolean(options.allowStacking);
  const scenarioKey = normalizeScenarioId(scenarioId);
  const runner = options.runner || null;
  const state = (await readLifecycleState(repoRoot, runner, namespace)) || { phase: 'baseline', scenarioId: null };
  if (!allowStacking && isUnresolvedLifecycleState(state)) {
    return {
      ok: false,
      code: 'SCENARIO_STACKING_BLOCKED',
      phase: 'blocked',
      scenarioId: scenarioKey,
      activeScenarioId: state.scenarioId || null,
      message: `Scenario "${scenarioKey}" cannot start while "${state.scenarioId || 'unknown'}" is still active or partially applied. Run Reset-DemoBaseline or explicitly use -AllowStacking for unsupported testing.`,
      lifecycleState: state,
    };
  }

  const lockResult = await acquireLifecycleLock(repoRoot, runner, namespace, scenarioKey, { allowStacking });
  if (!lockResult.ok) {
    return {
      ok: false,
      ...lockResult,
      lifecycleState: state,
    };
  }

  const clusterSnapshot = options.clusterSnapshot || await collectClusterSnapshot(repoRoot, runner, namespace);
  const fingerprint = options.baselineFingerprint || computeBaselineFingerprint(clusterSnapshot);
  const baselineValidation = verifyBaselineState(clusterSnapshot);
  if (!baselineValidation.ok) {
    await releaseLifecycleLock(repoRoot, runner, namespace);
    return {
      ok: false,
      code: 'BASELINE_DEGRADED',
      phase: 'blocked',
      scenarioId: scenarioKey,
      baselineFingerprint: fingerprint,
      remaining: baselineValidation.remaining,
      message: `Scenario "${scenarioKey}" cannot start from a degraded or ambiguous baseline. Run Reset-DemoBaseline to restore the healthy baseline. Remaining invariant failures: ${baselineValidation.remaining.join(', ') || 'none'}`,
      lifecycleState: state,
    };
  }

  const manifestPath = path.join(repoRoot, 'k8s', 'scenarios', SCENARIO_MAP[scenarioKey]);
  const manifestSource = fs.readFileSync(manifestPath, 'utf8');
  const manifestHash = sha256(manifestSource);

  const startingState = {
    component: 'scenario-lifecycle',
    phase: 'starting',
    scenarioId: scenarioKey,
    namespace,
    scenarioIds: [scenarioKey],
    startTime: new Date().toISOString(),
    manifestHash,
    allowStacking,
  };
  await writeLifecycleState(repoRoot, runner, startingState, namespace);

  const applyResult = await applyScenarioJob(runner, manifestPath, { whatIf: Boolean(options.whatIf) });
  if (!applyResult.ok) {
    await releaseLifecycleLock(repoRoot, runner, namespace);
    const nextState = {
      ...startingState,
      phase: 'apply-failed',
      endTime: new Date().toISOString(),
      reason: applyResult.message,
    };
    await writeLifecycleState(repoRoot, runner, nextState, namespace);
    return {
      ok: false,
      code: 'SCENARIO_APPLY_FAILED',
      phase: 'apply-failed',
      scenarioId: scenarioKey,
      manifestHash,
      message: applyResult.message,
      lifecycleState: nextState,
    };
  }

  const activation = await waitForActivation(scenarioKey, repoRoot, runner, {
    timeoutMs: Number(options.timeoutMs || 60000),
    pollMs: Number(options.pollMs || 2000),
    namespace,
  });

  if (!activation.ok) {
    await releaseLifecycleLock(repoRoot, runner, namespace);
    const nextState = {
      ...startingState,
      phase: 'activation-timeout',
      endTime: new Date().toISOString(),
      lastHealth: activation.health,
      reason: activation.message,
    };
    await writeLifecycleState(repoRoot, runner, nextState, namespace);
    return {
      ok: false,
      code: 'SCENARIO_ACTIVATION_TIMEOUT',
      phase: 'activation-timeout',
      scenarioId: scenarioKey,
      manifestHash,
      message: activation.message,
      lifecycleState: nextState,
    };
  }

  const correlationId = `scenario-${scenarioKey}-${Date.now()}`;
  const nextState = {
    component: 'scenario-lifecycle',
    phase: 'active',
    scenarioId: scenarioKey,
    namespace,
    scenarioIds: [scenarioKey],
    startTime: startingState.startTime,
    manifestHash,
    allowStacking,
    correlationId,
    active: true,
  };
  await writeLifecycleState(repoRoot, runner, nextState, namespace);
  await releaseLifecycleLock(repoRoot, runner, namespace);

  return {
    ok: true,
    phase: 'active',
    scenarioId: scenarioKey,
    correlationId,
    startTime: nextState.startTime,
    manifestHash,
    baselineFingerprint: fingerprint,
    message: `Scenario "${scenarioKey}" has been applied and activated successfully.`,
    lifecycleState: nextState,
  };
}

async function resetDemoBaseline(options = {}) {
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const namespace = options.namespace || DEFAULT_NAMESPACE;
  const scope = options.scope || 'all';
  const runner = options.runner || null;
  const whatIf = Boolean(options.whatIf);
  const inventory = inventoryScenarioResources(repoRoot);
  const lockResult = await acquireLifecycleLock(repoRoot, runner, namespace, 'reset', { allowStacking: true });
  if (!lockResult.ok) {
    return {
      ok: false,
      code: 'RESET_LOCKED',
      phase: 'blocked',
      message: lockResult.message,
      lifecycleState: await readLifecycleState(repoRoot, runner, namespace),
    };
  }

  try {
    const cleanup = await resetScenarioOwnedResources(repoRoot, runner, { scope, whatIf, namespace });
    if (!cleanup.ok) {
      return { ok: false, phase: 'failed', message: cleanup.message || 'Reset failed while removing scenario-owned resources.' };
    }

    const manifestPath = path.join(repoRoot, 'k8s', 'base', 'application.yaml');
    const baselineApply = await applyScenarioJob(runner, manifestPath, { whatIf });
    if (!baselineApply.ok) {
      const state = {
        component: 'scenario-lifecycle',
        phase: 'failed',
        namespace,
        scenarioId: null,
        scenarioIds: inventory.map((item) => item.scenarioId),
        reason: baselineApply.message,
      };
      await writeLifecycleState(repoRoot, runner, state, namespace);
      return {
        ok: false,
        code: 'BASELINE_REAPPLY_FAILED',
        phase: 'failed',
        message: baselineApply.message,
        lifecycleState: state,
      };
    }

    const clusterSnapshot = options.clusterSnapshot || await collectClusterSnapshot(repoRoot, runner, namespace);
    const fingerprint = computeBaselineFingerprint(clusterSnapshot);
    const verification = verifyBaselineState(clusterSnapshot);

    if (!verification.ok) {
      const state = {
        component: 'scenario-lifecycle',
        phase: 'reset-failed',
        namespace,
        scenarioId: null,
        scenarioIds: inventory.map((item) => item.scenarioId),
        fingerprint,
        remaining: verification.remaining,
        reason: 'Baseline verification failed after reset.',
      };
      await writeLifecycleState(repoRoot, runner, state, namespace);
      return {
        ok: false,
        code: 'BASELINE_VERIFICATION_FAILED',
        phase: 'reset-failed',
        fingerprint,
        remaining: verification.remaining,
        message: `Reset could not verify the healthy baseline. Remaining invariant failures: ${verification.remaining.join(', ') || 'none'}`,
        lifecycleState: state,
      };
    }

    const nextState = {
      component: 'scenario-lifecycle',
      phase: 'reset',
      namespace,
      scenarioId: null,
      scenarioIds: [],
      startTime: null,
      endTime: new Date().toISOString(),
      fingerprint,
      allowStacking: false,
    };
    await writeLifecycleState(repoRoot, runner, nextState, namespace);
    await releaseLifecycleLock(repoRoot, runner, namespace);

    return {
      ok: true,
      phase: 'reset',
      scope,
      fingerprint,
      message: `Reset succeeded and the baseline fingerprint is valid (${fingerprint.slice(0, 12)}).`,
      lifecycleState: nextState,
      cleanup,
    };
  } catch (error) {
    await releaseLifecycleLock(repoRoot, runner, namespace);
    throw error;
  }
}

async function runCli(argv, options = {}) {
  const rawArgs = Array.from(argv || []);
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  let operation = null;
  let scenarioId = null;
  let allowStacking = false;
  let scope = 'all';
  let whatIf = false;
  let namespace = DEFAULT_NAMESPACE;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    switch (arg) {
      case 'start':
      case 'reset':
        operation = arg;
        break;
      case '--scenario-id':
      case '-ScenarioId':
        scenarioId = rawArgs[++index];
        break;
      case '--allow-stacking':
      case '-AllowStacking':
        allowStacking = true;
        break;
      case '--scope':
      case '-Scope':
        scope = rawArgs[++index] || scope;
        break;
      case '--what-if':
      case '-WhatIf':
        whatIf = true;
        break;
      case '--namespace':
      case '-Namespace':
        namespace = rawArgs[++index] || namespace;
        break;
      case '--repo-root':
      case '-RepoRoot':
        repoRoot = rawArgs[++index] || repoRoot;
        break;
      default:
        if (!operation && ['start', 'reset'].includes(arg)) {
          operation = arg;
        } else if (!scenarioId && !arg.startsWith('-') && operation === 'start') {
          scenarioId = arg;
        }
        break;
    }
  }

  if (!operation || !['start', 'reset'].includes(operation)) {
    return {
      ok: false,
      code: 'INVALID_OPERATION',
      message: 'Usage: scenario-lifecycle.js <start|reset> [--scenario-id <id>] [--allow-stacking] [--scope all|network|extras] [--what-if]',
    };
  }

  if (operation === 'start') {
    if (!scenarioId) {
      return {
        ok: false,
        code: 'MISSING_SCENARIO_ID',
        message: 'Scenario ID is required for start operations.',
      };
    }
    return startDemoScenario(scenarioId, {
      repoRoot,
      namespace,
      allowStacking,
      whatIf,
    });
  }

  return resetDemoBaseline({ repoRoot, namespace, scope, whatIf });
}

if (require.main === module) {
  (async () => {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result && result.ok ? 0 : 1;
  })().catch((error) => {
    const payload = {
      ok: false,
      code: 'UNEXPECTED_ERROR',
      message: error && error.message ? error.message : String(error),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_REPO_ROOT,
  DEFAULT_NAMESPACE,
  STATE_CONFIGMAP_NAME,
  LOCK_CONFIGMAP_NAME,
  UNRESOLVED_LIFECYCLE_PHASES,
  normalizeScenarioId,
  inventoryScenarioResources,
  collectClusterSnapshot,
  computeBaselineFingerprint,
  verifyBaselineState,
  isUnresolvedLifecycleState,
  readLifecycleState,
  writeLifecycleState,
  startDemoScenario,
  resetDemoBaseline,
  waitForActivation,
  runCli,
  measureBaselineFingerprint: computeBaselineFingerprint,
};
