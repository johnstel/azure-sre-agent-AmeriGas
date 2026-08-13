const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  startDemoScenario,
  waitForActivation,
  acquireLifecycleLock,
  releaseLifecycleLock,
  resetDemoBaseline,
} = require('../scenario-lifecycle');

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

function createAtomicLockRunner({ snapshots = [healthyBaseline()], initialLock = null } = {}) {
  let lock = initialLock;
  const snapshotList = snapshots;
  let snapshotIndex = 0;

  return {
    async readState() {
      return { phase: 'baseline', scenarioId: null };
    },
    async writeState(_namespace, nextState) {
      return nextState;
    },
    async readLock() {
      return lock;
    },
    async writeLock(_namespace, nextLock) {
      const expired = lock && lock.locked && lock.expiresAt && Date.parse(lock.expiresAt) <= Date.now();
      if (lock && lock.locked && nextLock.locked && !expired && lock.ownerToken !== nextLock.ownerToken) {
        throw new Error('lifecycle lock already held by another process');
      }
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
      const snapshot = snapshotList[Math.min(snapshotIndex, snapshotList.length - 1)] || healthyBaseline();
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
      return payload;
    },
    currentLock() {
      return lock;
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

test('acquireLifecycleLock guarantees exactly one Promise.all start/reset winner', async () => {
  const runner = createAtomicLockRunner();
  const results = await Promise.all([
    acquireLifecycleLock(REPO_ROOT, runner, 'propane', 'oom'),
    acquireLifecycleLock(REPO_ROOT, runner, 'propane', 'reset'),
  ]);

  const winners = results.filter((result) => result.ok);
  assert.equal(winners.length, 1, 'exactly one concurrent lifecycle acquisition should win');
  assert.ok(runner.currentLock().locked, 'the winner must hold the authoritative lifecycle lock');
});

test('acquireLifecycleLock reclaims a stale lock after the bounded TTL expires', async () => {
  const staleLock = {
    locked: true,
    ownerToken: 'stale-owner',
    runId: 'stale-run',
    scenarioId: 'oom',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    resourceVersion: '17',
  };

  const runner = createAtomicLockRunner({ initialLock: staleLock });
  const result = await acquireLifecycleLock(REPO_ROOT, runner, 'propane', 'oom');

  assert.equal(result.ok, true, 'expired lock ownership should be recoverable');
  assert.notEqual(result.ownerToken, 'stale-owner');
  assert.equal(result.lockState.scenarioId, 'oom');
});

test('acquireLifecycleLock rejects a live lock while it remains valid and unexpired', async () => {
  const liveLock = {
    locked: true,
    ownerToken: 'live-owner',
    runId: 'live-run',
    scenarioId: 'oom',
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    resourceVersion: '88',
  };

  const runner = createAtomicLockRunner({ initialLock: liveLock });
  const result = await acquireLifecycleLock(REPO_ROOT, runner, 'propane', 'oom');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCENARIO_REENTRY_BLOCKED');
  assert.match(result.message, /cannot start|already active/i);
});

test('releaseLifecycleLock rejects mismatched owner token and resourceVersion', async () => {
  const runner = createAtomicLockRunner({
    initialLock: {
      locked: true,
      ownerToken: 'owner-a',
      runId: 'run-a',
      scenarioId: 'oom',
      expiresAt: new Date(Date.now() + 30000).toISOString(),
      resourceVersion: '99',
    },
  });

  const result = await releaseLifecycleLock(REPO_ROOT, runner, 'propane', {
    ownerToken: 'owner-b',
    resourceVersion: '99',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCK_RELEASE_MISMATCH');
  assert.match(result.message, /owner mismatch|version mismatch/i);
});

test('acquireLifecycleLock fails closed on partial write and transport failures', async () => {
  const runner = {
    async readLock() {
      return null;
    },
    async writeLock() {
      throw new Error('transport failure while persisting lifecycle lock');
    },
    async readState() {
      return { phase: 'baseline', scenarioId: null };
    },
    async writeState(_namespace, nextState) {
      return nextState;
    },
  };

  const result = await acquireLifecycleLock(REPO_ROOT, runner, 'propane', 'oom');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCENARIO_LOCK_WRITE_FAILED');
  assert.match(result.message, /transport failure/i);
});

test('resetDemoBaseline fails closed and keeps lifecycle state reset-required if any scenario resource survives cleanup', async () => {
  const runner = createAtomicLockRunner({
    snapshots: [healthyBaseline()],
  });

  const originalExec = runner.exec.bind(runner);
  runner.exec = async (command, args) => {
    if (command === 'kubectl' && Array.isArray(args) && args[0] === 'delete') {
      if (args[1] === 'deployment' && args[2] === 'tank-monitor') {
        return { ok: false, stdout: '', stderr: 'timed out deleting deployment tank-monitor', status: 1 };
      }
      return { ok: true, stdout: 'deleted', stderr: '', status: 0 };
    }
    if (command === 'kubectl' && Array.isArray(args) && args[0] === 'get') {
      return { ok: true, stdout: JSON.stringify({ items: [{ metadata: { name: 'tank-monitor' } }] }), stderr: '', status: 0 };
    }
    if (command === 'kubectl' && Array.isArray(args) && args[0] === 'apply') {
      return { ok: true, stdout: 'applied', stderr: '', status: 0 };
    }
    return originalExec(command, args);
  };

  const result = await resetDemoBaseline({ repoRoot: REPO_ROOT, namespace: 'propane', runner });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESET_CLEANUP_FAILED');
  assert.match(result.message, /tank-monitor|timed out|surviving/i);
});
