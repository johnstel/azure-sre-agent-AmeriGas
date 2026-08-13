const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const { spawnSync } = childProcess;
const { once } = require('node:events');

const { evaluateReadiness, parseCliArgs } = require('../readiness');

async function withReadinessRouteHarness({ evaluateReadinessOverride, execFileStub }) {
  const readinessPath = require.resolve('../readiness');
  const serverPath = require.resolve('../server');
  const originalReadiness = require(readinessPath);
  const originalExecFile = childProcess.execFile;
  const originalSubscription = process.env.MISSION_CONTROL_SUBSCRIPTION_ID;
  const originalResourceGroup = process.env.MISSION_CONTROL_RESOURCE_GROUP;

  process.env.MISSION_CONTROL_SUBSCRIPTION_ID = '11111111-1111-4111-8111-111111111111';
  process.env.MISSION_CONTROL_RESOURCE_GROUP = 'rg-demo';

  require.cache[readinessPath] = {
    id: readinessPath,
    filename: readinessPath,
    loaded: true,
    exports: {
      ...originalReadiness,
      evaluateReadiness: evaluateReadinessOverride || originalReadiness.evaluateReadiness,
    },
  };

  childProcess.execFile = execFileStub || ((cmd, args, options, callback) => {
    const argv = Array.isArray(args) ? args : [];
    if (cmd === 'az' && argv[0] === 'account' && argv[1] === 'show') {
      return callback(null, { stdout: JSON.stringify({ id: process.env.MISSION_CONTROL_SUBSCRIPTION_ID, name: 'Demo Subscription' }), stderr: '' });
    }
    if (cmd === 'az' && argv[0] === 'group' && argv[1] === 'show') {
      return callback(null, { stdout: JSON.stringify({ name: process.env.MISSION_CONTROL_RESOURCE_GROUP, location: 'eastus2' }), stderr: '' });
    }
    if (cmd === 'az' && argv[0] === 'resource' && argv[1] === 'list') {
      return callback(null, { stdout: JSON.stringify([{ name: 'demo-agent', type: 'Microsoft.App/agents' }]), stderr: '' });
    }
    return callback(new Error(`Unexpected execFile call: ${cmd} ${argv.join(' ')}`));
  });

  delete require.cache[serverPath];
  const { app } = require(serverPath);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async cleanup() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      delete require.cache[serverPath];
      if (originalReadiness && originalReadiness.__esModule) {
        require.cache[readinessPath] = { exports: originalReadiness };
      } else {
        delete require.cache[readinessPath];
      }
      childProcess.execFile = originalExecFile;
      if (originalSubscription === undefined) delete process.env.MISSION_CONTROL_SUBSCRIPTION_ID;
      else process.env.MISSION_CONTROL_SUBSCRIPTION_ID = originalSubscription;
      if (originalResourceGroup === undefined) delete process.env.MISSION_CONTROL_RESOURCE_GROUP;
      else process.env.MISSION_CONTROL_RESOURCE_GROUP = originalResourceGroup;
    },
  };
}

function mockRuntime(scenario) {
  return { mockScenario: scenario };
}

test('evaluateReadiness returns a ready result for a healthy mock scenario', async () => {
  const result = await evaluateReadiness({
    subscriptionId: 'sub-ready',
    resourceGroupName: 'rg-ready',
    profile: 'demo',
    timeoutMs: 90000,
  }, mockRuntime('healthy'));

  assert.equal(result.status, 'ready');
  assert.equal(result.blocking, false);
  assert.equal(result.category, 'demo-readiness');
  assert.equal(Array.isArray(result.checks), true);
  assert.ok(result.summary.includes('Ready for Demo'));
  assert.equal(result.checks.every((check) => check.status === 'pass'), true);
});

test('evaluateReadiness fails closed on a malformed request', async () => {
  const result = await evaluateReadiness({
    resourceGroupName: 'rg-demo',
    timeoutMs: 90000,
  }, { mockScenario: 'malformed' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.blocking, true);
  assert.equal(result.checks[0].status, 'fail');
  assert.match(result.summary, /malformed/i);
});

test('evaluateReadiness blocks on a timeout scenario', async () => {
  const result = await evaluateReadiness({
    subscriptionId: 'sub-timeout',
    resourceGroupName: 'rg-timeout',
    profile: 'demo',
    timeoutMs: 5000,
  }, mockRuntime('timeout'));

  assert.equal(result.status, 'blocked');
  assert.equal(result.blocking, true);
  assert.equal(result.checks[0].id, 'azure-auth-context');
  assert.equal(result.checks[0].status, 'fail');
});

test('evaluateReadiness redacts secrets from evidence material', async () => {
  const result = await evaluateReadiness({
    subscriptionId: 'sub-redact',
    resourceGroupName: 'rg-redact',
    profile: 'demo',
    timeoutMs: 90000,
  }, mockRuntime('redaction'));

  assert.equal(result.status, 'blocked');
  assert.match(String(result.checks[0].evidence), /\[REDACTED\]/);
  assert.doesNotMatch(String(result.checks[0].evidence), /super-secret-token-123/);
});

test('parseCliArgs accepts strict inputs with JSON mode set', () => {
  const parsed = parseCliArgs([
    '--subscription-id', 'sub-123',
    '--resource-group', 'rg-123',
    '--profile', 'demo',
    '--timeout-ms', '75000',
    '--json',
    '--optional-mission-control',
  ]);

  assert.equal(parsed.input.subscriptionId, 'sub-123');
  assert.equal(parsed.input.resourceGroupName, 'rg-123');
  assert.equal(parsed.input.profile, 'demo');
  assert.equal(parsed.input.timeoutMs, 75000);
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.requireMissionControl, true);
  assert.equal(parsed.flags.requireNativeSreAgent, false);
});

test('evaluateReadiness enforces required Mission Control and SRE Agent when enabled', async () => {
  const result = await evaluateReadiness({
    subscriptionId: 'sub-required',
    resourceGroupName: 'rg-required',
    profile: 'demo',
    timeoutMs: 90000,
    requireMissionControl: true,
    requireNativeSreAgent: true,
  }, {
    missionControl: { available: false, fresh: false, status: 'unavailable', details: { message: 'Mission Control missing' } },
    nativeSreAgent: { available: false, fresh: false, status: 'unavailable', details: { reason: 'native agent missing' } },
  });

  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.includes('mission-control-required'));
  assert.ok(result.blockers.includes('native-sre-agent-required'));
});

test('demo-readiness CLI emits JSON and exits non-zero when blocked', () => {
  const scriptPath = path.resolve(__dirname, '../demo-readiness.js');
  const result = spawnSync(process.execPath, [scriptPath, '--subscription-id', 'sub-42', '--resource-group', 'rg-42', '--mock', 'blocked', '--json'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.blocking, true);
});

test('HTTP readiness endpoint returns a stable JSON success payload and exactly one response', async () => {
  const { baseUrl, cleanup } = await withReadinessRouteHarness({
    evaluateReadinessOverride: async () => ({
      schemaVersion: 1,
      category: 'demo-readiness',
      status: 'ready',
      blocking: false,
      observedAt: new Date().toISOString(),
      duration: 12,
      summary: 'Ready for Demo',
      checks: [{
        id: 'demo-gate',
        category: 'mission-control',
        status: 'pass',
        blocking: false,
        observedAt: new Date().toISOString(),
        duration: 12,
        evidence: { source: 'mock' },
        remediation: 'No action required.',
      }],
      blockers: [],
      advisories: [],
    }),
  });

  try {
    const response = await fetch(`${baseUrl}/api/demo-readiness?subscriptionId=11111111-1111-4111-8111-111111111111&resourceGroupName=rg-demo&profile=demo`);
    const text = await response.text();
    const payload = JSON.parse(text);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(text.startsWith('<!DOCTYPE html'), false);
    assert.equal(payload.status, 'ready');
    assert.equal(payload.blocking, false);
  } finally {
    await cleanup();
  }
});

test('HTTP readiness endpoint blocks invalid client scope mismatches with a stable JSON payload', async () => {
  const { baseUrl, cleanup } = await withReadinessRouteHarness({
    evaluateReadinessOverride: async () => ({ status: 'ready' }),
  });

  try {
    const response = await fetch(`${baseUrl}/api/demo-readiness?subscriptionId=22222222-2222-4222-8222-222222222222&resourceGroupName=rg-demo&profile=demo`);
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.blocking, true);
    assert.match(String(payload.summary), /invalid request scope/i);
  } finally {
    await cleanup();
  }
});

test('HTTP readiness endpoint returns a stable blocked JSON payload on evaluator failure', async () => {
  const { baseUrl, cleanup } = await withReadinessRouteHarness({
    evaluateReadinessOverride: async () => {
      const error = new Error('simulated evaluator failure');
      error.statusCode = 500;
      throw error;
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/demo-readiness?subscriptionId=11111111-1111-4111-8111-111111111111&resourceGroupName=rg-demo&profile=demo`);
    const payload = await response.json();

    assert.equal(response.status, 500);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.blocking, true);
    assert.match(String(payload.summary), /failed to evaluate demo readiness/i);
  } finally {
    await cleanup();
  }
});

test('HTTP readiness endpoint returns a stable blocked JSON payload on timeout', async () => {
  const { baseUrl, cleanup } = await withReadinessRouteHarness({
    evaluateReadinessOverride: async () => {
      const error = new Error('readiness check timed out after 90s');
      error.statusCode = 503;
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });

  try {
    const response = await fetch(`${baseUrl}/api/demo-readiness?subscriptionId=11111111-1111-4111-8111-111111111111&resourceGroupName=rg-demo&profile=demo`);
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(payload.status, 'blocked');
    assert.equal(payload.blocking, true);
    assert.match(String(payload.summary), /timeout/i);
  } finally {
    await cleanup();
  }
});
