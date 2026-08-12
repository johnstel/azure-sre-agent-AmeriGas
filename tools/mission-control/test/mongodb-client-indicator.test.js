const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * app.js is a plain browser script (not a CommonJS module), so we extract
 * just the mongodb-indicator logic (SCENARIO_INDICATORS through
 * isMongodbScenarioActive) into a sandboxed vm context, the same technique
 * test/safety-alarm.test.js already uses for the inline portal script. This
 * lets us functionally test the client-side indicator against pod fixtures
 * instead of only regex-matching source text, so it actually catches a
 * regression in the client/server health-semantics alignment.
 */
function loadClientMongodbIndicator() {
  const appJsPath = path.resolve(__dirname, '../public/app.js');
  const source = fs.readFileSync(appJsPath, 'utf8');

  const startIndex = source.indexOf('const SCENARIO_INDICATORS = {');
  const endMarker = 'let currentPods = [];';
  const endIndex = source.indexOf(endMarker, startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('Could not locate the mongodb scenario indicator block in public/app.js');
  }

  const runtimeSource = source.slice(startIndex, endIndex);
  const context = { console };
  vm.createContext(context);
  vm.runInContext(`${runtimeSource}\nthis.__mongoIndicator = { isMongoPodReady, isMongodbScenarioActive, SCENARIO_INDICATORS };`, context);
  return context.__mongoIndicator;
}

function pod(name, overrides = {}) {
  return { name, status: overrides.status || 'Running', ready: overrides.ready, reason: '', restarts: 0 };
}

test('client-side SCENARIO_INDICATORS.mongodb is null — mongodb is special-cased, not the generic "some pod matches" pattern', () => {
  const { SCENARIO_INDICATORS } = loadClientMongodbIndicator();
  assert.equal(SCENARIO_INDICATORS.mongodb, null);
});

test('client-side isMongoPodReady requires both Running status and a fully-ready container count', () => {
  const { isMongoPodReady } = loadClientMongodbIndicator();
  assert.equal(isMongoPodReady(pod('mongodb-0', { status: 'Running', ready: '1/1' })), true);
  assert.equal(isMongoPodReady(pod('mongodb-0', { status: 'Running', ready: '0/1' })), false);
  assert.equal(isMongoPodReady(pod('mongodb-0', { status: 'Pending', ready: '0/1' })), false);
  assert.equal(isMongoPodReady(pod('mongodb-0', { status: 'Running', ready: '0/0' })), false, 'zero total containers must never count as ready');
});

test('client-side isMongodbScenarioActive treats zero mongodb pods as active, matching the server-side semantics', () => {
  const { isMongodbScenarioActive } = loadClientMongodbIndicator();
  const pods = [pod('tank-monitor-1', { status: 'Running', ready: '1/1' })];
  assert.equal(isMongodbScenarioActive(pods), true);
});

test('client-side isMongodbScenarioActive requires Running AND Ready before reporting recovery', () => {
  const { isMongodbScenarioActive } = loadClientMongodbIndicator();
  const runningNotReady = [pod('mongodb-0', { status: 'Running', ready: '0/1' })];
  assert.equal(isMongodbScenarioActive(runningNotReady), true);

  const runningReady = [pod('mongodb-0', { status: 'Running', ready: '1/1' })];
  assert.equal(isMongodbScenarioActive(runningReady), false);
});
