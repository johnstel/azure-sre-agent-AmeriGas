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
