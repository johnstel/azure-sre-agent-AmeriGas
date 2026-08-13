const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startDemoScenario, waitForActivation } = require('../scenario-lifecycle');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function deployment(name, replicas = 1, available = replicas, ready = replicas) {
  return {
    metadata: { name },
    spec: { replicas },
    status: { availableReplicas: available, readyReplicas: ready },
  };
}

function service(name, endpoints = [{ ip: '10.0.0.1' }]) {
  return {
    metadata: { name },
    spec: { selector: { app: name }, ports: [{ port: 80, targetPort: 80 }] },
  };
}

function endpoint(name, addresses = [{ ip: '10.0.0.1' }]) {
  return {
    metadata: { name },
    subsets: [{ addresses }],
  };
}

function pod(name, status = 'Running', ready = true, restartCount = 0, reason = '') {
  return {
    metadata: { name },
    status: {
      phase: status,
      containerStatuses: [{
        name,
        ready,
        restartCount,
        state: reason ? { waiting: { reason } } : { running: {} },
      }],
    },
  };
}

function healthyBaseline(overrides = {}) {
  const base = {
    pods: [pod('customer-portal-1'), pod('tank-monitor-1'), pod('mongodb-0')],
    deployments: [
      deployment('customer-portal'),
      deployment('dispatch-console'),
      deployment('tank-monitor'),
      deployment('inventory-service'),
      deployment('order-service'),
      deployment('usage-simulator'),
      deployment('order-worker'),
      deployment('rabbitmq'),
      deployment('mongodb'),
      deployment('otel-collector'),
    ],
    services: [
      service('customer-portal'),
      service('dispatch-console'),
      service('tank-monitor'),
      service('inventory-service'),
      service('order-service'),
      service('mongodb'),
      service('rabbitmq'),
    ],
    endpoints: [
      endpoint('customer-portal'),
      endpoint('dispatch-console'),
      endpoint('tank-monitor'),
      endpoint('inventory-service'),
      endpoint('order-service'),
      endpoint('mongodb'),
      endpoint('rabbitmq'),
    ],
    networkPolicies: [],
    configMaps: [],
  };
  return { ...base, ...overrides };
}

function createRunner({ snapshots = [healthyBaseline()], lifecycleState = null, lifecycleLock = null } = {}) {
  let snapshotIndex = 0;
  let cycleReads = 0;
  let state = lifecycleState;
  let lock = lifecycleLock;

  return {
    async readState() {
      return state;
    },
    async writeState(_namespace, nextState) {
      state = nextState;
      return nextState;
    },
    async readLock() {
      return lock;
    },
    async writeLock(_namespace, nextLock) {
      lock = nextLock;
      return nextLock;
    },
    async exec(command, args) {
      if (command === 'kubectl' && Array.isArray(args) && args[0] === 'apply') {
        return 'applied';
      }
      return '';
    },
    async readJson(args) {
      const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)] || healthyBaseline();
      const resource = args[1];
      const payload = (() => {
        if (resource === 'pods') return { items: snapshot.pods || [] };
        if (resource === 'deployments') return { items: snapshot.deployments || [] };
        if (resource === 'svc') return { items: snapshot.services || [] };
        if (resource === 'endpoints') return { items: snapshot.endpoints || [] };
        if (resource === 'networkpolicy') return { items: snapshot.networkPolicies || [] };
        if (resource === 'configmaps') return { items: snapshot.configMaps || [] };
        return { items: [] };
      })();

      cycleReads += 1;
      if (cycleReads >= 6) {
        cycleReads = 0;
        snapshotIndex = Math.min(snapshotIndex + 1, snapshots.length - 1);
      }
      return payload;
    },
  };
}

test('waitForActivation refreshes the live snapshot on every poll and activates once the pod health flips true', async () => {
  const firstSnapshot = healthyBaseline({
    pods: [pod('tank-monitor-1', 'Running', true, 0, '')],
  });
  const secondSnapshot = healthyBaseline({
    pods: [pod('tank-monitor-1', 'Running', true, 5, 'OOMKilled')],
  });

  const runner = createRunner({ snapshots: [firstSnapshot, secondSnapshot] });
  const result = await waitForActivation('oom', REPO_ROOT, runner, { timeoutMs: 100, pollMs: 0, namespace: 'propane' });

  assert.equal(result.ok, true, 'waitForActivation must activate once a fresh live snapshot reflects the failing pod');
  assert.equal(result.health.active, true);
  assert.equal(result.snapshot.pods[0].metadata.name, 'tank-monitor-1');
});

test('waitForActivation returns a truthful timeout with the last fresh snapshot and health signal', async () => {
  const runner = createRunner({
    snapshots: [
      healthyBaseline({ pods: [pod('tank-monitor-1', 'Running', true, 0, '')] }),
      healthyBaseline({ pods: [pod('tank-monitor-1', 'Running', true, 0, '')] }),
    ],
  });

  const result = await waitForActivation('oom', REPO_ROOT, runner, { timeoutMs: 1, pollMs: 0, namespace: 'propane' });

  assert.equal(result.ok, false);
  assert.match(result.message, /did not activate within/i);
  assert.ok(result.snapshot, 'timeout must keep the most recent fresh snapshot for diagnostics');
  assert.equal(result.health.active, false);
});

test('startDemoScenario blocks same-scenario re-entry while the scenario is still unresolved', async () => {
  const phases = ['active', 'starting', 'failed', 'partial', 'apply-failed', 'activation-timeout'];

  for (const phase of phases) {
    const runner = createRunner({
      lifecycleState: { phase, scenarioId: 'oom', endTime: null },
    });

    const result = await startDemoScenario('oom', {
      repoRoot: REPO_ROOT,
      namespace: 'propane',
      runner,
      timeoutMs: 10,
      pollMs: 0,
    });

    assert.equal(result.ok, false, `phase ${phase} should block same-scenario re-entry`);
    assert.equal(result.code, 'SCENARIO_STACKING_BLOCKED');
    assert.match(result.message, /cannot start/i);
  }
});

test('startDemoScenario blocks different-scenario re-entry when another scenario is still unresolved', async () => {
  const runner = createRunner({
    lifecycleState: { phase: 'active', scenarioId: 'network', endTime: null },
  });

  const result = await startDemoScenario('oom', {
    repoRoot: REPO_ROOT,
    namespace: 'propane',
    runner,
    timeoutMs: 10,
    pollMs: 0,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCENARIO_STACKING_BLOCKED');
  assert.equal(result.activeScenarioId, 'network');
});

test('startDemoScenario honors an explicit -AllowStacking override only when requested', async () => {
  const activeSnapshot = healthyBaseline({
    pods: [pod('tank-monitor-1', 'Running', true, 5, 'OOMKilled')],
  });
  const runner = createRunner({
    snapshots: [healthyBaseline(), activeSnapshot],
    lifecycleState: { phase: 'active', scenarioId: 'oom', endTime: null },
  });

  const result = await startDemoScenario('oom', {
    repoRoot: REPO_ROOT,
    namespace: 'propane',
    runner,
    allowStacking: true,
    timeoutMs: 50,
    pollMs: 0,
  });

  assert.equal(result.ok, true, 'explicit stacking override must allow a same-scenario retry for supported testing');
  assert.equal(result.scenarioId, 'oom');
});
