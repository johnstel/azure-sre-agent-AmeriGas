const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { evaluateReadiness, parseCliArgs } = require('../readiness');

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
