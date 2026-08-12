const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readManifest() {
  return fs.readFileSync(path.resolve(__dirname, '../../../k8s/base/application.yaml'), 'utf8');
}

function readScenarioManifest() {
  return fs.readFileSync(path.resolve(__dirname, '../../../k8s/scenarios/probe-failure.yaml'), 'utf8');
}

function createElement() {
  return {
    className: '',
    innerHTML: '',
    children: [],
    prepend(node) {
      this.children.unshift(node);
    },
    appendChild(node) {
      this.children.push(node);
      return node;
    },
    removeChild(node) {
      const idx = this.children.indexOf(node);
      if (idx >= 0) this.children.splice(idx, 1);
      return node;
    },
  };
}

function loadSafetyAlarmRuntime() {
  const manifestText = readManifest();
  const startIndex = manifestText.indexOf('const BULK_TANK_SAFETY_ALARM = {');
  const endIndex = manifestText.indexOf('const LOG_MESSAGES = [', startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error('Missing Bulk Tank safety alarm runtime in deployed inline portal script.');
  }

  const runtimeSource = manifestText.slice(startIndex, endIndex);
  const elements = new Map();
  const context = {
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    Boolean,
    isNaN,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, createElement());
        return elements.get(id);
      },
      createElement() {
        return createElement();
      },
    },
    window: {},
    globalThis: {},
  };

  context.window = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(`${runtimeSource}; this.__bulkTankSafetyAlarm = { alarm: BULK_TANK_SAFETY_ALARM, acknowledgeBulkTankSafetyAlarm, processBulkTankSafetyAlarm, renderBulkTankSafetyAlarm };`, context);

  return context.__bulkTankSafetyAlarm;
}

test('the bulk tank safety alarm is deterministic and includes the required telemetry fields', () => {
  const appText = readManifest();
  const scenarioText = readScenarioManifest();

  assert.match(appText, /alarmId:\s*'BT-SAFETY-ALM-00042'/);
  assert.match(appText, /assetId:\s*'BT-1551'/);
  assert.match(appText, /readingAgeMinutes:\s*9/);
  assert.match(appText, /simulatedSeverity:\s*'SEV-1'/);
  assert.match(appText, /ackState:\s*'Pending'/);
  assert.match(appText, /triggeredAt:\s*'2025-02-11T06:41:52Z'/);
  assert.match(appText, /lastUpdatedAt:\s*'2025-02-11T06:51:12Z'/);
  assert.match(appText, /processingComponent:\s*'safety-compliance-monitor'/);
  assert.match(appText, /SIMULATED tank level drop below 20% after 15 minutes; requires AmeriGas safety SME validation\./);
  assert.match(scenarioText, /alarm_id: "BT-SAFETY-ALM-00042"/);
  assert.match(scenarioText, /simulated_severity: "SEV-1"/);
  assert.match(scenarioText, /ack_state: "pending"/);
});

test('the alarm encodes a healthy workload that is suppressed by delayed processing', () => {
  const appText = readManifest();
  const scenarioText = readScenarioManifest();

  assert.match(scenarioText, /workload_healthy":true/);
  assert.match(scenarioText, /"processing_state":"suppressed"/);
  assert.match(appText, /processingState:\s*'suppressed'/);
  assert.match(appText, /Workload is healthy, but the processing component continues to delay or suppress the pending alarm\./);
});

test('acknowledgement updates the alarm and suppresses duplicate acknowledgements', () => {
  const runtime = loadSafetyAlarmRuntime();
  assert.equal(runtime.alarm.ackState, 'Pending');

  runtime.acknowledgeBulkTankSafetyAlarm();
  assert.equal(runtime.alarm.ackState, 'Acknowledged');
  assert.equal(runtime.alarm.acknowledgedBy, 'dispatch-console');
  assert.ok(runtime.alarm.acknowledgedAt);

  runtime.acknowledgeBulkTankSafetyAlarm();
  assert.equal(runtime.alarm.ackState, 'Acknowledged');
  assert.equal(runtime.alarm.acknowledgedBy, 'dispatch-console');
});

test('recovery processes the pending alarm exactly once without duplicate incidents', () => {
  const runtime = loadSafetyAlarmRuntime();

  runtime.processBulkTankSafetyAlarm();
  assert.equal(runtime.alarm.processedExactlyOnce, true);
  assert.equal(runtime.alarm.processingState, 'recovered');
  assert.equal(runtime.alarm.ackState, 'Recovered');
  assert.ok(runtime.alarm.recoveredAt);

  runtime.processBulkTankSafetyAlarm();
  assert.equal(runtime.alarm.processedExactlyOnce, true);
  assert.equal(runtime.alarm.processingState, 'recovered');
});

test('the deployed inline UI exposes the alarm card and acknowledgement workflow', () => {
  const manifestText = readManifest();
  assert.match(manifestText, /id="bulk-tank-safety-alarm"/);
  assert.match(manifestText, /onclick="acknowledgeBulkTankSafetyAlarm\(\)"/);
  assert.match(manifestText, /Bulk Tank Safety Signal/);
  assert.match(manifestText, /SIMULATED threshold:/);
});
