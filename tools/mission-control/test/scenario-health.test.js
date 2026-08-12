const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateScenarioHealth, parsePodStatus } = require('../scenario-health');

function pod(name, overrides = {}) {
  return {
    metadata: { name },
    status: {
      phase: overrides.phase || 'Running',
      containerStatuses: overrides.containerStatuses || [],
    },
  };
}

test('parsePodStatus derives status/reason/restarts from container states', () => {
  const p = {
    metadata: { name: 'tank-monitor-abc' },
    status: {
      phase: 'Running',
      containerStatuses: [
        { restartCount: 4, state: { waiting: { reason: 'CrashLoopBackOff' } } },
      ],
    },
  };
  const parsed = parsePodStatus(p);
  assert.equal(parsed.name, 'tank-monitor-abc');
  assert.equal(parsed.status, 'CrashLoopBackOff');
  assert.equal(parsed.reason, 'CrashLoopBackOff');
  assert.equal(parsed.restarts, 4);
});

test('evaluateScenarioHealth detects oom scenario from tank-monitor restarts', () => {
  const pods = [pod('tank-monitor-1', { containerStatuses: [{ restartCount: 5, state: { waiting: { reason: 'CrashLoopBackOff' } } }] })];
  const result = evaluateScenarioHealth('oom', { pods });
  assert.equal(result.active, true);
  assert.match(result.reason, /tank-monitor-1/);
});

test('evaluateScenarioHealth reports healthy when no matching pods are unhealthy', () => {
  const pods = [pod('tank-monitor-1', { phase: 'Running' })];
  const result = evaluateScenarioHealth('oom', { pods });
  assert.equal(result.active, false);
});

test('evaluateScenarioHealth detects the network scenario via NetworkPolicy presence', () => {
  const networkPolicies = [{ metadata: { name: 'deny-tank-monitor' } }];
  const active = evaluateScenarioHealth('network', { pods: [], networkPolicies });
  assert.equal(active.active, true);

  const cleared = evaluateScenarioHealth('network', { pods: [], networkPolicies: [] });
  assert.equal(cleared.active, false);
});

test('evaluateScenarioHealth detects the service-mismatch scenario via empty Service endpoints', () => {
  const pods = [pod('tank-monitor-1', { phase: 'Running' })];
  const endpoints = [{ metadata: { name: 'tank-monitor' }, subsets: [] }];
  const active = evaluateScenarioHealth('service', { pods, endpoints });
  assert.equal(active.active, true);

  const healthyEndpoints = [{ metadata: { name: 'tank-monitor' }, subsets: [{ addresses: [{ ip: '10.0.0.5' }] }] }];
  const cleared = evaluateScenarioHealth('service', { pods, endpoints: healthyEndpoints });
  assert.equal(cleared.active, false);
});

test('evaluateScenarioHealth returns active:null for unknown scenarios instead of fabricating a result', () => {
  const result = evaluateScenarioHealth('not-a-real-scenario', { pods: [] });
  assert.equal(result.active, null);
  assert.match(result.reason, /No server-side health indicator/);
});

test('evaluateScenarioHealth detects mongodb scenario when the pod is not Running', () => {
  const pods = [pod('mongodb-0', { phase: 'Pending' })];
  const result = evaluateScenarioHealth('mongodb', { pods });
  assert.equal(result.active, true);
});

test('parsePodStatus computes ready only when every containerStatus reports ready:true', () => {
  const readyPod = { metadata: { name: 'mongodb-0' }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } };
  assert.equal(parsePodStatus(readyPod).ready, true);

  const notReadyPod = { metadata: { name: 'mongodb-0' }, status: { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 0, state: { running: {} } }] } };
  assert.equal(parsePodStatus(notReadyPod).ready, false);

  const noContainerStatusesPod = { metadata: { name: 'mongodb-0' }, status: { phase: 'Running', containerStatuses: [] } };
  assert.equal(parsePodStatus(noContainerStatusesPod).ready, false, 'a pod reporting zero containerStatuses must never be treated as ready');
});

test('evaluateScenarioHealth treats a scaled-to-zero mongodb Deployment (zero mongodb pods) as active, not healthy', () => {
  // This reproduces the mongodb-down.yaml scenario, which scales the
  // Deployment to 0 replicas rather than leaving an unhealthy pod behind.
  // `kubectl get pods` for the propane namespace then returns pods for
  // every OTHER service but zero pods whose name starts with "mongodb".
  const pods = [
    pod('tank-monitor-1', { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] }),
    pod('order-service-1', { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] }),
  ];
  const result = evaluateScenarioHealth('mongodb', { pods });
  assert.equal(result.active, true, 'zero mongodb pods must be treated as the scenario still being active');
  assert.match(result.reason, /no mongodb pods found/i);
});

test('evaluateScenarioHealth does not report mongodb recovery until a pod is BOTH Running and Ready', () => {
  // A mongodb pod that exists and is Running, but whose container isn't
  // Ready yet (e.g. still initializing / replica set electing a primary),
  // must not be reported as recovered.
  const runningNotReadyPods = [pod('mongodb-0', { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 0, state: { running: {} } }] })];
  const stillActive = evaluateScenarioHealth('mongodb', { pods: runningNotReadyPods });
  assert.equal(stillActive.active, true, 'Running but not Ready must still be reported as active/unhealthy');
  assert.match(stillActive.reason, /none are Running and Ready/);

  // Only once the pod is Running AND Ready does the scenario clear.
  const readyPods = [pod('mongodb-0', { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] })];
  const recovered = evaluateScenarioHealth('mongodb', { pods: readyPods });
  assert.equal(recovered.active, false, 'a Running and Ready mongodb pod must be reported as recovered');
  assert.match(recovered.reason, /Running and Ready/);
});

test('evaluateScenarioHealth mongodb lifecycle: zero pods (active) -> Running not Ready (still active) -> Running and Ready (recovered)', () => {
  const zeroPods = evaluateScenarioHealth('mongodb', { pods: [] });
  assert.equal(zeroPods.active, true);

  const startingPod = [pod('mongodb-0', { phase: 'Pending', containerStatuses: [] })];
  const starting = evaluateScenarioHealth('mongodb', { pods: startingPod });
  assert.equal(starting.active, true);

  const runningNotReady = [pod('mongodb-0', { phase: 'Running', containerStatuses: [{ ready: false, restartCount: 0, state: { running: {} } }] })];
  const notReadyYet = evaluateScenarioHealth('mongodb', { pods: runningNotReady });
  assert.equal(notReadyYet.active, true);

  const runningReady = [pod('mongodb-0', { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] })];
  const recovered = evaluateScenarioHealth('mongodb', { pods: runningReady });
  assert.equal(recovered.active, false);
});
